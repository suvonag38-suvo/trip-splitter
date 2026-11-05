/**
 * Trip Expense & Bill Splitter - Backend Server (Node.js)
 * --------------------------------------------------------
 * Designed specifically for `trip_splitter_mobile_app-v3.html`.
 *
 * Features:
 * - Zero external npm dependencies required (uses built-in Node.js `http`, `fs`, `path`).
 * - Persistent JSON database (`trips_data.json`) with automatic initialization & atomic saves.
 * - Full REST API for trips, group size presets, members, expenses, and settlement calculations.
 * - Full-state sync endpoints (`GET /api/state` & `PUT /api/state`) for drop-in replacement of `localStorage`.
 * - Serves `trip_splitter_mobile_app-v3.html` directly at `http://localhost:3000/` with live backend sync.
 *
 * Usage:
 *   node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'trips_data.json');
const FRONTEND_FILE = path.join(__dirname, 'trip_splitter_mobile_app-v3.html');

// ============================================================================
// 1. Helper Utilities (Matching Frontend Logic)
// ============================================================================

function formatTodayDate() {
  const d = new Date();
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function formatINR(val) {
  return '₹' + Number(val || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function indexToLabel(idx) {
  let label = '';
  let n = idx;
  while (n >= 0) {
    label = String.fromCharCode((n % 26) + 65) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

function getMemberSpent(trip, memberId) {
  return (trip.expenses || [])
    .filter(e => e.memberId === memberId)
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);
}

/**
 * Calculates total spent, per-person share, net balances, and minimum cash-flow transfers.
 */
function calculateSettlements(trip) {
  const members = trip.members || [];
  const expenses = trip.expenses || [];
  const count = members.length;

  if (count === 0) {
    return { total: 0, share: 0, balances: [], transfers: [], whatsappSummary: '' };
  }

  const total = +expenses.reduce((s, e) => s + Number(e.amount || 0), 0).toFixed(2);
  const share = +(total / count).toFixed(2);

  const balances = members.map(m => {
    const spent = +getMemberSpent(trip, m.id).toFixed(2);
    const net = +(spent - total / count).toFixed(2);
    return { ...m, spent, net };
  });

  const debtors = balances
    .filter(b => b.net < -0.01)
    .map(b => ({ ...b, amount: Math.abs(b.net) }))
    .sort((a, b) => b.amount - a.amount);

  const creditors = balances
    .filter(b => b.net > 0.01)
    .map(b => ({ ...b, amount: b.net }))
    .sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay > 0.01) {
      transfers.push({
        from: debtors[i].name,
        to: creditors[j].name,
        amount: +pay.toFixed(2)
      });
    }
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }

  // Build WhatsApp Summary text matching frontend format
  const lines = [
    `*${trip.title} - Expense Summary (${members.length} People)*`,
    `Total Spent: ${formatINR(total)}`,
    `Per Person Share: ${formatINR(share)}`,
    '',
    '*Individual Spending:*'
  ];
  balances.forEach(b => {
    const diff = b.net >= 0
      ? `(Gets ${formatINR(b.net)})`
      : `(Gives ${formatINR(Math.abs(b.net))})`;
    lines.push(`• ${b.name}: ${formatINR(b.spent)} ${diff}`);
  });
  lines.push('', '*Final Settlement:*');
  if (transfers.length === 0) {
    lines.push('All settled!');
  } else {
    transfers.forEach(t => {
      lines.push(`👉 *${t.from}* pays *${t.to}*: *${formatINR(t.amount)}*`);
    });
  }

  return {
    total,
    share,
    balances,
    transfers,
    whatsappSummary: lines.join('\n')
  };
}

// ============================================================================
// 2. Database Layer (Persistent JSON File Storage)
// ============================================================================

const DEFAULT_DATA = {
  activeTripId: 'trip_1',
  trips: [
    {
      id: 'trip_1',
      title: 'Trip #1 (Sample)',
      createdAt: formatTodayDate(),
      members: [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
        { id: '4', name: 'D' }
      ],
      expenses: [
        { id: 'e1', memberId: '1', amount: 3200, note: 'Hotel Booking' },
        { id: 'e2', memberId: '2', amount: 1400, note: 'Cab & Fuel' },
        { id: 'e3', memberId: '3', amount: 1800, note: 'Dinner & Lunch' },
        { id: 'e4', memberId: '4', amount: 400, note: 'Snacks & Tea' }
      ]
    }
  ]
};

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      writeDb(DEFAULT_DATA);
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.trips) && parsed.trips.length > 0) {
      return parsed;
    }
  } catch (err) {
    console.error('Error reading DB file, falling back to default:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function writeDb(data) {
  const tempFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempFile, DB_FILE);
}

function findTrip(db, tripId) {
  return db.trips.find(t => t.id === tripId);
}

// ============================================================================
// 3. HTTP Utilities
// ============================================================================

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Script injected into the HTML frontend when served by this backend
// so it automatically loads and saves state to `/api/state` alongside `localStorage`.
const BACKEND_SYNC_BRIDGE = `
<script>
  (function() {
    const origSaveState = window.saveState;
    window.saveState = function() {
      if (typeof origSaveState === 'function') origSaveState();
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appData)
      }).catch(err => console.warn('Backend sync warning:', err));
    };

    fetch('/api/state')
      .then(res => res.ok ? res.json() : null)
      .then(serverData => {
        if (serverData && Array.isArray(serverData.trips) && serverData.trips.length > 0) {
          appData = serverData;
          localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(appData));
          render();
        }
      })
      .catch(err => console.warn('Running in offline/localStorage mode:', err));
  })();
</script>
`;

// ============================================================================
// 4. Request Router & Controllers
// ============================================================================

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  try {
    // ------------------------------------------------------------------------
    // Serve Frontend HTML at `/`
    // ------------------------------------------------------------------------
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (fs.existsSync(FRONTEND_FILE)) {
        let html = fs.readFileSync(FRONTEND_FILE, 'utf8');
        html = html.replace('</body>', `${BACKEND_SYNC_BRIDGE}
</body>`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return sendJson(res, 200, {
        message: 'Trip Expense Splitter Backend API is running.',
        hint: 'Place trip_splitter_mobile_app-v3.html in the same folder to serve the UI at /',
        endpoints: [
          'GET    /api/state',
          'PUT    /api/state',
          'GET    /api/trips',
          'POST   /api/trips',
          'GET    /api/trips/:tripId',
          'PATCH  /api/trips/:tripId',
          'DELETE /api/trips/:tripId',
          'PUT    /api/trips/:tripId/group-count',
          'POST   /api/trips/:tripId/members',
          'PATCH  /api/trips/:tripId/members/:memberId',
          'DELETE /api/trips/:tripId/members/:memberId',
          'POST   /api/trips/:tripId/expenses',
          'DELETE /api/trips/:tripId/expenses/:expenseId',
          'GET    /api/trips/:tripId/settlements'
        ]
      });
    }

    // ------------------------------------------------------------------------
    // Full State Sync (`GET /api/state` & `PUT /api/state`)
    // ------------------------------------------------------------------------
    if (pathname === '/api/state') {
      if (method === 'GET') {
        const db = readDb();
        return sendJson(res, 200, db);
      }
      if (method === 'PUT') {
        const body = await parseBody(req);
        if (!body || !Array.isArray(body.trips) || body.trips.length === 0) {
          return sendJson(res, 400, { error: 'State must include a non-empty trips array.' });
        }
        const newState = {
          activeTripId: body.activeTripId || body.trips[0].id,
          trips: body.trips
        };
        writeDb(newState);
        return sendJson(res, 200, newState);
      }
    }

    // ------------------------------------------------------------------------
    // Trips Collection (`GET /api/trips` & `POST /api/trips`)
    // ------------------------------------------------------------------------
    if (pathname === '/api/trips') {
      const db = readDb();

      if (method === 'GET') {
        const summaries = db.trips.map(t => {
          const { total, share } = calculateSettlements(t);
          return {
            id: t.id,
            title: t.title,
            createdAt: t.createdAt,
            isActive: t.id === db.activeTripId,
            memberCount: t.members.length,
            expenseCount: t.expenses.length,
            totalSpent: total,
            perPersonShare: share
          };
        });
        return sendJson(res, 200, { activeTripId: db.activeTripId, trips: summaries });
      }

      if (method === 'POST') {
        const body = await parseBody(req);
        const currentTrip = findTrip(db, db.activeTripId) || db.trips[0];
        const rawTitle = (body.title || '').trim();
        const title = rawTitle || `Trip #${db.trips.length + 1} (${formatTodayDate()})`;
        const memberOption = String(body.memberOption || '4');

        let newMembers = [];
        if (Array.isArray(body.members) && body.members.length > 0) {
          newMembers = body.members.map((m, idx) => ({
            id: m.id || `m_${Date.now()}_${idx}`,
            name: String(m.name || indexToLabel(idx)).trim()
          }));
        } else if (memberOption === 'keep' && currentTrip && currentTrip.members.length > 0) {
          newMembers = currentTrip.members.map((m, idx) => ({
            id: `m_${Date.now()}_${idx}`,
            name: m.name
          }));
        } else {
          const count = Math.min(Math.max(parseInt(memberOption, 10) || 4, 1), 100);
          for (let i = 0; i < count; i++) {
            newMembers.push({
              id: `m_${Date.now()}_${i}`,
              name: indexToLabel(i)
            });
          }
        }

        const newTrip = {
          id: `trip_${Date.now()}`,
          title,
          createdAt: formatTodayDate(),
          members: newMembers,
          expenses: []
        };

        db.trips.unshift(newTrip);
        db.activeTripId = newTrip.id;
        writeDb(db);
        return sendJson(res, 201, { activeTripId: db.activeTripId, trip: newTrip });
      }
    }

    // ------------------------------------------------------------------------
    // Single Trip Routes (`/api/trips/:tripId...`)
    // ------------------------------------------------------------------------
    const tripMatch = pathname.match(/^\/api\/trips\/([^/]+)(?:\/(.*))?$/);
    if (tripMatch) {
      const tripId = decodeURIComponent(tripMatch[1]);
      const subPath = tripMatch[2] || '';
      const db = readDb();
      const trip = findTrip(db, tripId);

      if (!trip) {
        return sendJson(res, 404, { error: `Trip "${tripId}" not found.` });
      }

      // `/api/trips/:tripId`
      if (!subPath) {
        if (method === 'GET') {
          const settlements = calculateSettlements(trip);
          return sendJson(res, 200, { ...trip, settlements });
        }

        if (method === 'PATCH') {
          const body = await parseBody(req);
          if (typeof body.title === 'string' && body.title.trim()) {
            trip.title = body.title.trim();
          }
          if (body.setActive === true) {
            db.activeTripId = trip.id;
          }
          writeDb(db);
          return sendJson(res, 200, { activeTripId: db.activeTripId, trip });
        }

        if (method === 'DELETE') {
          if (db.trips.length <= 1) {
            return sendJson(res, 400, { error: 'You must keep at least 1 trip in the app.' });
          }
          db.trips = db.trips.filter(t => t.id !== tripId);
          if (db.activeTripId === tripId) {
            db.activeTripId = db.trips[0].id;
          }
          writeDb(db);
          return sendJson(res, 200, {
            message: 'Trip deleted.',
            activeTripId: db.activeTripId
          });
        }
      }

      // `GET /api/trips/:tripId/settlements`
      if (subPath === 'settlements' && method === 'GET') {
        return sendJson(res, 200, calculateSettlements(trip));
      }

      // `PUT /api/trips/:tripId/group-count`
      if (subPath === 'group-count' && method === 'PUT') {
        const body = await parseBody(req);
        const count = parseInt(body.count, 10);
        if (isNaN(count) || count < 1 || count > 100) {
          return sendJson(res, 400, { error: 'Count must be an integer between 1 and 100.' });
        }
        const currentLen = trip.members.length;
        if (count > currentLen) {
          for (let i = currentLen; i < count; i++) {
            trip.members.push({
              id: `m_${Date.now()}_${i}`,
              name: indexToLabel(i)
            });
          }
        } else if (count < currentLen) {
          const kept = trip.members.slice(0, count);
          const keptIds = new Set(kept.map(m => m.id));
          trip.members = kept;
          trip.expenses = trip.expenses.filter(e => keptIds.has(e.memberId));
        }
        writeDb(db);
        return sendJson(res, 200, { trip, settlements: calculateSettlements(trip) });
      }

      // `POST /api/trips/:tripId/members`
      if (subPath === 'members' && method === 'POST') {
        const body = await parseBody(req);
        const customName = (body.name || '').trim();
        const name = customName || indexToLabel(trip.members.length);
        const newMember = {
          id: `m_${Date.now()}`,
          name
        };
        trip.members.push(newMember);
        writeDb(db);
        return sendJson(res, 201, { member: newMember, settlements: calculateSettlements(trip) });
      }

      // `/api/trips/:tripId/members/:memberId`
      const memberMatch = subPath.match(/^members\/([^/]+)$/);
      if (memberMatch) {
        const memberId = decodeURIComponent(memberMatch[1]);
        const member = trip.members.find(m => m.id === memberId);
        if (!member) {
          return sendJson(res, 404, { error: `Member "${memberId}" not found.` });
        }

        if (method === 'PATCH') {
          const body = await parseBody(req);
          if (typeof body.name === 'string' && body.name.trim()) {
            member.name = body.name.trim();
            writeDb(db);
            return sendJson(res, 200, { member, settlements: calculateSettlements(trip) });
          }
          return sendJson(res, 400, { error: 'Valid member name is required.' });
        }

        if (method === 'DELETE') {
          if (trip.members.length <= 1) {
            return sendJson(res, 400, { error: 'A trip must have at least 1 member.' });
          }
          trip.members = trip.members.filter(m => m.id !== memberId);
          trip.expenses = trip.expenses.filter(e => e.memberId !== memberId);
          writeDb(db);
          return sendJson(res, 200, {
            message: 'Member and associated expenses removed.',
            settlements: calculateSettlements(trip)
          });
        }
      }

      // `POST /api/trips/:tripId/expenses`
      if (subPath === 'expenses' && method === 'POST') {
        const body = await parseBody(req);
        const amount = parseFloat(body.amount);
        const memberId = String(body.memberId || '');
        const note = (body.note || '').trim() || 'Trip Expense';

        if (!amount || amount <= 0) {
          return sendJson(res, 400, { error: 'Expense amount must be greater than 0.' });
        }
        if (!trip.members.some(m => m.id === memberId)) {
          return sendJson(res, 404, { error: `Member "${memberId}" does not exist in this trip.` });
        }

        const newExpense = {
          id: `e_${Date.now()}`,
          memberId,
          amount: +amount.toFixed(2),
          note
        };
        trip.expenses.push(newExpense);
        writeDb(db);
        return sendJson(res, 201, { expense: newExpense, settlements: calculateSettlements(trip) });
      }

      // `DELETE /api/trips/:tripId/expenses/:expenseId`
      const expenseMatch = subPath.match(/^expenses\/([^/]+)$/);
      if (expenseMatch && method === 'DELETE') {
        const expenseId = decodeURIComponent(expenseMatch[1]);
        const initialLen = trip.expenses.length;
        trip.expenses = trip.expenses.filter(e => e.id !== expenseId);
        if (trip.expenses.length === initialLen) {
          return sendJson(res, 404, { error: `Expense "${expenseId}" not found.` });
        }
        writeDb(db);
        return sendJson(res, 200, {
          message: 'Expense deleted.',
          settlements: calculateSettlements(trip)
        });
      }
    }

    return sendJson(res, 404, { error: `Route ${method} ${pathname} not found.` });
  } catch (err) {
    console.error('Server error:', err);
    return sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`✅ Trip Expense Splitter Backend running at http://localhost:${PORT}`);
    console.log(`📂 Persistent storage file: ${DB_FILE}`);
  });
}

module.exports = { server, calculateSettlements, readDb, writeDb };