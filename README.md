# Trip Splitter

Split trip expenses with friends and see who pays whom.
Every person makes their own account, so **each person's trips are private**.
Friends open one link, tap "Add to Home Screen", and it works like a normal app.

---

## A. Try it on your own laptop first

1. Install Node.js (the "LTS" button on nodejs.org).
2. Open a terminal inside this folder and run:
   ```
   node server.js
   ```
3. Open **http://localhost:3000** in Chrome, tap **Create an account**, and use the app.

On your laptop the data is saved in a file: `data/db.json`.

---

## B. Put it on the internet for your friends (free)

You need three free accounts: **Upstash** (keeps the data safe), **GitHub** (holds your code),
**Render** (runs the app). It takes about 20 minutes the first time.

### Why Upstash?
Free hosting like Render erases files whenever the app restarts or goes to sleep.
Upstash is a small online database, so everyone's trips are never lost.

### Step 1 - Make the database (Upstash)
1. Go to **upstash.com** and sign up.
2. Create a new **Redis** database (any name, pick the region nearest to India, choose the free plan).
3. Open the database and find the **REST API** section.
4. Copy these two values somewhere (Notepad):
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### Step 2 - Put the code on GitHub
1. Go to **github.com** and sign up.
2. Click **New repository**, name it `trip-splitter`, and create it.
3. Click **uploading an existing file** and drag in everything from this folder:
   `server.js`, `package.json`, `README.md` and the whole **`public`** folder
   (make sure the files inside `public` upload too).
   Do not upload a `data` folder.
4. Click **Commit changes**.

### Step 3 - Run it on Render
1. Go to **render.com** and sign up (you can use your GitHub login).
2. Click **New +** then **Web Service**, and pick your `trip-splitter` repository.
3. Fill in:
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. Open **Environment Variables** and add the two values from Step 1:
   - `UPSTASH_REDIS_REST_URL` = (the URL you copied)
   - `UPSTASH_REDIS_REST_TOKEN` = (the token you copied)
5. Click **Create Web Service** and wait a few minutes.
6. Render shows your link, for example `https://trip-splitter-abcd.onrender.com`.
   Open it. If you can create an account and the logs say
   `Storage: Upstash Redis (hosted database)`, everything is set up correctly.

### Step 4 - Share with friends
Send them the link. To install it like an app:

- **Android (Chrome):** open the link, tap the **3-dot menu**, then **Install app** (or **Add to Home screen**).
- **iPhone (Safari):** open the link, tap the **Share** button, then **Add to Home Screen**.

---

## Good to know

- **Free Render sleeps.** After 15 minutes with no visitors the app sleeps, and the next
  person waits about a minute while it wakes up. Their trips are still safe in Upstash.
- **Forgot password:** there is no reset feature. Create a new account if a password is lost.
- **Privacy:** passwords are scrambled (hashed) and nobody can read them. As the owner you can
  still open your Upstash database and see trip data, so only share with friends you trust.
- **Same account on two phones:** works. The most recent save wins, so avoid editing the same trip
  on two phones at the same time.
- **Offline:** the app opens without internet and keeps changes on the phone, then saves them
  to the server when the internet comes back.
- **Updating the app later:** change the files on GitHub and Render redeploys by itself.
- **First account on a browser that used the old single HTML file:** its old trips are copied
  into that account once, automatically.
