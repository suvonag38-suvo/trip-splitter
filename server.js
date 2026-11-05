/**
 * Trip Expense Splitter - Backend v2.0 (Node.js, zero dependencies)
 * -----------------------------------------------------------------
 * - Accounts: register / login / logout (passwords hashed with scrypt)
 * - Every user has their own private trips (nobody else can see them)
 * - Automatically serves `trip_splitter_mobile_app-v3.html` OR `./public/index.html`
 * - Supports Upstash Redis (`UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`)
 *   with automatic fallback to `./data/db.json`
 *
 * Run:  node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_HTML_FILE = path.join(__dirname, 'trip_splitter_mobile_app-v3.html');
const SESSION_DAYS = 90;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const MAX_STATE_BYTES = 400 * 1024;

// ============================================================================
// 1. Storage (file or Upstash Redis)
// ============================================================================

function createFileStore() {
  const file = path.join(DATA_DIR, 'db.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let db = { kv: {}, exp: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    db = { kv: parsed.kv || {}, exp: parsed.exp || {} };
  } catch (e) { /* first run: start empty */ }

  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  };
  const alive = (k) => {
    if (db.exp[k] && db.exp[k] < Date.now()) {
      delete db.kv[k];
      delete db.exp[k];
      return false;
    }
    return Object.prototype.hasOwnProperty.call(db.kv, k);
  };

  return {
    name: 'local file (' + file + ')',
    async get(k) { return alive(k) ? db.kv[k] : null; },
    async set(k, v, ttlSeconds) {
      db.kv[k] = v;
      if (ttlSeconds) db.exp[k] = Date.now() + ttlSeconds * 1000;
      else delete db.exp[k];
      save();
    },
    async setIfAbsent(k, v) {
      if (alive(k)) return false;
      db.kv[k] = v;
      delete db.exp[k];
      save();
      return true;
    },
    async del(k) { delete db.kv[k]; delete db.exp[k]; save(); }
  };
}

function createUpstashStore(baseUrl, token) {
  const url = baseUrl.replace(/\/+$/, '');
  async function cmd(args) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Database error: ' + (j.error || r.status));
    return j.result;
  }
  return {
    name: 'Upstash Redis (hosted database)',
    get: (k) => cmd(['GET', k]),
    async set(k, v, ttlSeconds) {
      await cmd(ttlSeconds ? ['SET', k, v, 'EX', String(ttlSeconds)] : ['SET', k, v]);
    },
    async setIfAbsent(k, v) { return (await cmd(['SET', k, v, 'NX'])) === 'OK'; },
    async del(k) { await cmd(['DEL', k]); }
  };
}

const store =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? createUpstashStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
    : createFileStore();

// ============================================================================
// 2. Accounts & sessions
// ============================================================================

const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function verifyPassword(password, record) {
  const { hash } = await hashPassword(password, record.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.set('s:' + sha256(token), JSON.stringify({ username }), SESSION_SECONDS);
  return token;
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function getSessionUser(req) {
  const token = parseCookies(req).tsid;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const raw = await store.get('s:' + sha256(token));
  if (!raw) return null;
  try { return JSON.parse(raw).username; } catch (e) { return null; }
}

function isHttps(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, token, maxAge) {
  return (
    'tsid=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge +
    (isHttps(req) ? '; Secure' : '')
  );
}

const hits = new Map();
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}
function recordHit(key, windowMs) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || rec.resetAt < now) hits.set(key, { count: 1, resetAt: now + windowMs });
  else rec.count++;
}
function isBlocked(key, max) {
  const rec = hits.get(key);
  return Boolean(rec && rec.resetAt > Date.now() && rec.count >= max);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
}, 10 * 60 * 1000).unref();

// ============================================================================
// 3. HTTP helpers
// ============================================================================

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin'
};

function sendJson(res, status, payload, extraHeaders) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, SECURITY_HEADERS, extraHeaders || {}));
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json')) return reject(Object.assign(new Error('JSON required'), { status: 415 }));
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_STATE_BYTES + 10 * 1024) tooBig = true;
    });
    req.on('end', () => {
      if (tooBig) return reject(Object.assign(new Error('Data is too large'), { status: 413 }));
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return sendJson(res, 400, { error: 'Bad URL' }); }

  // If requesting `/` or `/index.html`, support either `./public/index.html` OR `./trip_splitter_mobile_app-v3.html`
  if (rel === '/' || rel === '/index.html') {
    const publicIndex = path.join(PUBLIC_DIR, 'index.html');
    const candidate = fs.existsSync(publicIndex)
      ? publicIndex
      : (fs.existsSync(ROOT_HTML_FILE) ? ROOT_HTML_FILE : null);
    if (candidate) {
      const st = fs.statSync(candidate);
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache'
      }, SECURITY_HEADERS));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(candidate).pipe(res);
    }
  }

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache'
    }, SECURITY_HEADERS));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function validState(body) {
  return Boolean(
    body && typeof body === 'object' &&
    Array.isArray(body.trips) && body.trips.length >= 1 && body.trips.length <= 500 &&
    body.trips.every((t) => t && typeof t === 'object' && typeof t.id === 'string' &&
      Array.isArray(t.members) && Array.isArray(t.expenses))
  );
}

// ============================================================================
// 4. Routes
// ============================================================================

async function handleApi(req, res, pathname) {
  const method = req.method;
  const ip = clientIp(req);

  if (pathname === '/api/register' && method === 'POST') {
    if (isBlocked('reg:' + ip, 20)) return sendJson(res, 429, { error: 'Too many sign-ups. Try again later.' });
    const body = await parseBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) {
      return sendJson(res, 400, { error: 'Username must be 3-30 characters: letters, numbers, dot, dash or underscore.' });
    }
    if (password.length < 6 || password.length > 200) {
      return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    }
    const rec = await hashPassword(password);
    const created = await store.setIfAbsent('u:' + username, JSON.stringify({ ...rec, createdAt: new Date().toISOString() }));
    recordHit('reg:' + ip, 60 * 60 * 1000);
    if (!created) return sendJson(res, 409, { error: 'That username is already taken.' });
    const token = await createSession(username);
    return sendJson(res, 201, { username }, { 'Set-Cookie': sessionCookie(req, token, SESSION_SECONDS) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (isBlocked('login:' + ip, 10)) {
      return sendJson(res, 429, { error: 'Too many wrong attempts. Please wait 15 minutes.' });
    }
    const body = await parseBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const raw = USERNAME_RE.test(username) ? await store.get('u:' + username) : null;
    let ok = false;
    if (raw && password.length <= 200) {
      try { ok = await verifyPassword(password, JSON.parse(raw)); } catch (e) { ok = false; }
    } else {
      await hashPassword(password.slice(0, 200));
    }
    if (!ok) {
      recordHit('login:' + ip, 15 * 60 * 1000);
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    const token = await createSession(username);
    return sendJson(res, 200, { username }, { 'Set-Cookie': sessionCookie(req, token, SESSION_SECONDS) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).tsid;
    if (token && /^[a-f0-9]{64}$/.test(token)) await store.del('s:' + sha256(token));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  const username = await getSessionUser(req);
  if (!username) return sendJson(res, 401, { error: 'Please log in.' });

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { username });
  }

  if (pathname === '/api/state' && method === 'GET') {
    const raw = await store.get('d:' + username);
    let state = null;
    if (raw) { try { state = JSON.parse(raw); } catch (e) { state = null; } }
    return sendJson(res, 200, { state });
  }

  if (pathname === '/api/state' && method === 'PUT') {
    const body = await parseBody(req);
    if (!validState(body)) return sendJson(res, 400, { error: 'Invalid trips data.' });
    const state = {
      activeTripId: typeof body.activeTripId === 'string' ? body.activeTripId : body.trips[0].id,
      trips: body.trips
    };
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) return sendJson(res, 413, { error: 'Data is too large.' });
    await store.set('d:' + username, text);
    return sendJson(res, 200, { ok: true, savedAt: Date.now() });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('Server error:', err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Trip Splitter v2.0 running at http://localhost:' + PORT);
    console.log('Storage: ' + store.name);
  });
}

module.exports = { server, store };
