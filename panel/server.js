'use strict';
/**
 * Panel Server — Web interface for managing WhatsApp bot sessions
 * Public Connect API: privacy-preserving token-based session creation from landing page
 */

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL CRASH SAFETY NET — MUST be the very first thing that runs.
// Without this, ANY unhandled error anywhere in the app (a command file, an
// AI Engine API call, a media download, a malformed WhatsApp message) kills
// the ENTIRE Node process instantly — which is why the whole bot randomly
// goes offline every 20-30 minutes. These handlers log the error and let the
// process keep running instead of crashing on a single bad edge case.
// ═══════════════════════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('🚨 [FATAL-CAUGHT] Uncaught Exception (process kept alive):', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('🚨 [FATAL-CAUGHT] Unhandled Promise Rejection (process kept alive):', reason?.stack || reason);
});

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const path           = require('path');
const fs             = require('fs');
const { randomUUID, createHash } = require('crypto');
const sessionManager = require('./sessionManager');
const { SESSION_STATUS } = require('./sessionManager');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS — allow the Vercel-hosted frontend to call this backend ──────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://mr-muneeb-ali-bot.vercel.app');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Bypass-Tunnel-Reminder');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL PASSWORD AUTHENTICATION
// Password: MUNEEB SAR  (case-sensitive, trimmed)
// ═══════════════════════════════════════════════════════════════════════════════

const PANEL_PASSWORD = 'MUNEEB SAR';
const PANEL_TOKEN    = createHash('sha256')
  .update(PANEL_PASSWORD + (process.env.SESSION_SECRET || 'muneeb_bot_secret_key'))
  .digest('hex');
const COOKIE_NAME    = 'pauth';
const COOKIE_TTL     = 86400; // 24 hours

function _parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function isPanelAuthed(req) {
  return _parseCookies(req)[COOKIE_NAME] === PANEL_TOKEN;
}

function requirePanelAuth(req, res, next) {
  if (isPanelAuthed(req)) return next();
  return res.status(401).json({ error: 'Login required', code: 'PANEL_UNAUTH' });
}

// POST /api/panel/login — verify password, set auth cookie
app.post('/api/panel/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password.trim() !== PANEL_PASSWORD) {
    return res.status(403).json({ success: false, error: 'Galat password! Dobara try karo.' });
  }
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${PANEL_TOKEN}; HttpOnly; Path=/; Max-Age=${COOKIE_TTL}; SameSite=None; Secure`);
  res.json({ success: true });
});

// GET /api/panel/check — check if already authenticated
app.get('/api/panel/check', (req, res) => {
  res.json({ authed: isPanelAuthed(req) });
});

// GET /api/panel/logout — clear auth cookie
app.get('/api/panel/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure`);
  res.json({ success: true });
});

// ── Static folder ─────────────────────────────────────────────────────────────
const _pub1 = path.join(__dirname, 'Public');
const _pub2 = path.join(__dirname, 'public');
const PUBLIC_DIR = fs.existsSync(_pub1) ? _pub1 : _pub2;

app.set('trust proxy', 1);

// ── /manage — admin panel (canonical, no-cache) ───────────────────────────────
app.get('/manage', (req, res) => {
  const filePath = path.join(PUBLIC_DIR, 'panel.html');
  if (!fs.existsSync(filePath))
    return res.status(500).send('<h2>panel.html not found</h2><p>' + filePath + '</p>');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.sendFile(filePath);
});

// ── /panel — keep working (alias for /manage) ─────────────────────────────────
app.get('/panel', (req, res) => {
  const filePath = path.join(PUBLIC_DIR, 'panel.html');
  if (!fs.existsSync(filePath))
    return res.status(500).send('<h2>panel.html not found</h2>');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.sendFile(filePath);
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN REST API  (all routes below require panel auth)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/sessions', requirePanelAuth, (req, res) => {
  res.json({ sessions: sessionManager.getSessions(), max: sessionManager.MAX_SESSIONS });
});

app.post('/api/sessions', requirePanelAuth, (req, res) => {
  try {
    const { name, ownerNumber } = req.body;
    const session = sessionManager.createSession(name, ownerNumber);
    res.json({ success: true, session: { id: session.id, name: session.name } });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.delete('/api/sessions/:id', requirePanelAuth, async (req, res) => {
  try {
    await sessionManager.deleteSession(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/sessions/:id/start', requirePanelAuth, async (req, res) => {
  try {
    await sessionManager.startSession(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/sessions/:id/stop', requirePanelAuth, async (req, res) => {
  try {
    await sessionManager.stopSession(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/sessions/:id/paircode', requirePanelAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });
    const code = await sessionManager.requestPairCode(parseInt(req.params.id), phone);
    res.json({ success: true, code });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get('/api/sessions/:id/qr', requirePanelAuth, (req, res) => {
  const session = sessionManager.getSession(parseInt(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ qr: session.qrImage || null, status: session.status });
});

app.get('/api/status', (req, res) => {
  const sessions  = sessionManager.getSessions();
  const connected = sessions.filter(s => s.status === SESSION_STATUS.CONNECTED).length;
  res.json({ total: sessions.length, connected, max: sessionManager.MAX_SESSIONS, uptime: process.uptime() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC CONNECT API — privacy-preserving (token-based, no user details exposed)
// ═══════════════════════════════════════════════════════════════════════════════

// token → { sessionId, created, socketId }
const _publicTokens = new Map();
const _TOKEN_TTL    = 3 * 60 * 1000; // 3 minutes — plenty for a real user to finish pairing,
                                       // but stops abandoned/test attempts from permanently
                                       // occupying a session slot (was 20 min, far too slow)

// Cleanup stale public sessions every 1 minute (was 5 min — too slow relative to how
// often the 10-session cap could fill up from repeated/abandoned connect attempts)
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of _publicTokens) {
    if (now - entry.created < _TOKEN_TTL) continue;
    const sess = sessionManager.getSession(entry.sessionId);
    if (sess && sess.status !== SESSION_STATUS.CONNECTED) {
      sessionManager.deleteSession(entry.sessionId).catch(() => {});
      console.log(`[PublicConnect] 🧹 Cleaned up abandoned session ${entry.sessionId} (never completed pairing)`);
    }
    _publicTokens.delete(token);
  }
}, 60 * 1000);

// GET /api/public/status — only total connected count, NO user details
app.get('/api/public/status', (req, res) => {
  const sessions  = sessionManager.getSessions();
  const connected = sessions.filter(s => s.status === SESSION_STATUS.CONNECTED).length;
  res.json({ connected, max: sessionManager.MAX_SESSIONS, name: require('../config').serverName || 'Server' });
});

// POST /api/public/connect — create anonymous session, return private token
app.post('/api/public/connect', async (req, res) => {
  try {
    let sessions = sessionManager.getSessions();

    // If at capacity, try an immediate sweep for abandoned (unpaired, >60s old)
    // sessions before rejecting — don't make a real user wait for the next
    // scheduled 1-minute cleanup tick just to free up an already-dead slot.
    if (sessions.length >= sessionManager.MAX_SESSIONS) {
      const now = Date.now();
      for (const [token, entry] of _publicTokens) {
        if (now - entry.created < 60 * 1000) continue; // give it at least 60s grace
        const sess = sessionManager.getSession(entry.sessionId);
        if (sess && sess.status !== SESSION_STATUS.CONNECTED) {
          await sessionManager.deleteSession(entry.sessionId).catch(() => {});
          _publicTokens.delete(token);
          console.log(`[PublicConnect] 🧹 Just-in-time cleanup freed session ${entry.sessionId}`);
        }
      }
      sessions = sessionManager.getSessions(); // recheck after cleanup
    }

    if (sessions.length >= sessionManager.MAX_SESSIONS) {
      return res.status(429).json({ success: false, error: 'Server is at capacity. Please try again later.' });
    }
    const token    = randomUUID();
    const autoName = `Bot_${token.slice(0, 8)}`;
    const session  = sessionManager.createSession(autoName, '');
    _publicTokens.set(token, { sessionId: session.id, created: Date.now(), socketId: null });
    await sessionManager.startSession(session.id);
    res.json({ success: true, token });
  } catch (e) {
    console.error('[PublicConnect] create error:', e.message);
    res.status(400).json({ success: false, error: e.message });
  }
});

// GET /api/public/connect/:token/qr — returns only this session's QR (private)
app.get('/api/public/connect/:token/qr', (req, res) => {
  const entry = _publicTokens.get(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Token expired or invalid. Please start again.' });
  const sess = sessionManager.getSession(entry.sessionId);
  if (!sess)  return res.status(404).json({ error: 'Session not found.' });
  res.json({ qr: sess.qrImage || null, status: sess.status });
});

// POST /api/public/connect/:token/paircode — get pairing code for this session
app.post('/api/public/connect/:token/paircode', async (req, res) => {
  const entry = _publicTokens.get(req.params.token);
  if (!entry) return res.status(404).json({ success: false, error: 'Token expired or invalid.' });
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Phone number required.' });
  try {
    const code = await sessionManager.requestPairCode(entry.sessionId, phone);
    res.json({ success: true, code });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK — serve index.html for all unmatched routes
// ═══════════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  const filePath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(filePath))
    return res.status(500).send('<h2>index.html not found</h2>');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.sendFile(filePath);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO — real-time panel events (admin panel)
// ═══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  // Check panel auth via cookie sent in handshake headers
  const handshakeCookies = {};
  const rawCookie = socket.handshake.headers?.cookie || '';
  for (const part of rawCookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    handshakeCookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  const socketAuthed = handshakeCookies[COOKIE_NAME] === PANEL_TOKEN;

  socket.emit('sessions:list', {
    sessions: sessionManager.getSessions(),
    max: sessionManager.MAX_SESSIONS
  });

  // Admin panel events — all require panel auth
  socket.on('session:start', async ({ id }) => {
    if (!socketAuthed) return socket.emit('session:error', { id, error: 'Unauthorized. Please login.' });
    try { await sessionManager.startSession(id); socket.emit('session:ok', { id, action: 'start' }); }
    catch (e) { socket.emit('session:error', { id, error: e.message }); }
  });

  socket.on('session:stop', async ({ id }) => {
    if (!socketAuthed) return socket.emit('session:error', { id, error: 'Unauthorized. Please login.' });
    try { await sessionManager.stopSession(id); socket.emit('session:ok', { id, action: 'stop' }); }
    catch (e) { socket.emit('session:error', { id, error: e.message }); }
  });

  socket.on('session:create', async ({ name, ownerNumber }) => {
    if (!socketAuthed) return socket.emit('session:error', { error: 'Unauthorized. Please login.' });
    try {
      const session = sessionManager.createSession(name, ownerNumber);
      socket.emit('session:created', { id: session.id, name: session.name });
      io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
    } catch (e) { socket.emit('session:error', { error: e.message }); }
  });

  socket.on('session:delete', async ({ id }) => {
    if (!socketAuthed) return socket.emit('session:error', { id, error: 'Unauthorized. Please login.' });
    try {
      await sessionManager.deleteSession(id);
      io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
    } catch (e) { socket.emit('session:error', { id, error: e.message }); }
  });

  socket.on('session:paircode', async ({ id, phone }) => {
    if (!socketAuthed) return socket.emit('session:error', { id, error: 'Unauthorized. Please login.' });
    try {
      const code = await sessionManager.requestPairCode(id, phone);
      socket.emit('session:paircode:result', { id, code });
    } catch (e) { socket.emit('session:error', { id, error: e.message }); }
  });

  // Public connect: subscribe to a token's session updates (QR/status only for that session)
  socket.on('connect:subscribe', ({ token }) => {
    const entry = _publicTokens.get(token);
    if (!entry) return;
    entry.socketId = socket.id;
    socket.join(`public:${token}`);
  });
});

// ── Forward session events to clients ────────────────────────────────────────

sessionManager.on('session:status', (data) => {
  io.emit('session:status', data);
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
  // Notify public connect subscribers about their own session status only
  for (const [token, entry] of _publicTokens) {
    if (entry.sessionId === data.id) {
      io.to(`public:${token}`).emit('connect:status', { status: data.status });
    }
  }
});

sessionManager.on('session:qr', (data) => {
  io.emit('session:qr', data);
  // Emit QR to public subscriber only
  for (const [token, entry] of _publicTokens) {
    if (entry.sessionId === data.id) {
      io.to(`public:${token}`).emit('connect:qr', { qr: data.qr });
    }
  }
});

sessionManager.on('session:paircode', (data) => { io.emit('session:paircode', data); });

sessionManager.on('session:connected', (data) => {
  io.emit('session:connected', data);
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
});

sessionManager.on('session:disconnected', (data) => {
  io.emit('session:disconnected', data);
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
});

sessionManager.on('session:created', () => { io.emit('sessions:refresh', { sessions: sessionManager.getSessions() }); });
sessionManager.on('session:deleted', () => { io.emit('sessions:refresh', { sessions: sessionManager.getSessions() }); });
sessionManager.on('session:error',   (data) => { io.emit('session:error', data); });

// ── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.SERVER_PORT || process.env.PORT || 5915;

// Tracks whatever the CURRENT best public URL is (Cloudflare's, since it
// changes every restart) — exposed via /api/public/backend-url so the
// frontend can auto-discover it instead of needing a manual code update
// every time the backend restarts.
let currentBackendUrl = null;

// ── Multi-server status publishing (fixes the "Select Server" flakiness) ──
// OLD BEHAVIOUR (bug): har server ek hi FIXED gist filename ("backend-url.txt")
// pe apna URL likhta tha. Jab 3 servers same gist pe likhte, har server dusre
// ka likha hua OVERWRITE kar deta — isiliye kabhi ek online dikhta kabhi
// dusra offline (jo bhi last publish kare wahi "jeeta"), aur slots bhi
// (hardcoded 10) config se match nahi karte the.
//
// NEW: har server apni OWN file likhta hai, uske config.serverName se naam
// banta hai (e.g. "server-server-1.json"), jisme uska apna URL + kitne bots
// connected + kitne max slots + aakhri update ka time hota hai. Frontend
// ye POORI gist ek hi call mein padhta hai aur jitni bhi "server-*.json"
// files milti hain unko cards bana deta hai — koi hardcoded list nahi,
// naya server add karo (naya serverName + maxSlots config mein daalo) to
// wo khud hi website pe aa jayega.
function _slug(s) {
  return String(s || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function publishServerStatus(url) {
  try {
    const cfg = require('../config');
    if (!cfg.gistId || !cfg.gistToken) return; // not configured on this server — skip silently
    const https = require('https');
    const sessions = sessionManager.getSessions();
    const connected = sessions.filter(s => s.status === SESSION_STATUS.CONNECTED).length;
    const statusObj = {
      name: cfg.serverName || 'Server',
      url: url || currentBackendUrl || '',
      connected,
      maxSlots: sessionManager.MAX_SESSIONS,
      updatedAt: Date.now()
    };
    const filename = `server-${_slug(cfg.serverName)}.json`;
    const payload = JSON.stringify({
      files: { [filename]: { content: JSON.stringify(statusObj) } }
    });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/gists/${cfg.gistId}`,
      method: 'PATCH',
      headers: {
        'Authorization': `token ${cfg.gistToken}`,
        'User-Agent': 'muneeb-bot',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.log(`[Gist] ⚠️ Publish failed (HTTP ${res.statusCode}) for ${filename}`);
        }
      });
    });
    req.on('error', (e) => console.log('[Gist] Publish error:', e.message));
    req.write(payload);
    req.end();
  } catch (e) {
    console.log('[Gist] Publish error:', e.message);
  }
}

// Heartbeat — har 30 second status republish karta hai (sirf URL change hone
// pe nahi), taaki "connected" count aur "updatedAt" hamesha fresh rahe aur
// frontend ko pata chal sake ke server abhi bhi zinda hai (stale/purana
// updatedAt dekh kar frontend khud "Offline" dikha dega agar server sach
// mein crash ho jaye).
setInterval(() => publishServerStatus(currentBackendUrl), 30 * 1000);

// A stable discovery endpoint — the frontend hits the FIXED localtunnel URL
// first just to ask "what's the current real backend URL right now?", then
// uses whatever this returns for everything else. This is the one thing
// that must stay at a fixed, predictable address.
app.get('/api/public/backend-url', (req, res) => {
  res.json({ url: currentBackendUrl || `https://mrmuneebalibot.loca.lt` });
});

function startPanelServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 Panel running at http://0.0.0.0:${PORT}`);
    console.log(`📊 Managing up to ${sessionManager.MAX_SESSIONS} bot sessions\n`);
    sessionManager.autoStartSessions();

    // ── Free HTTPS tunnel — Cloudflare Tunnel (primary) with localtunnel fallback ──
    // loca.lt is a single hobby-run relay that goes down unpredictably (503s,
    // random subdomain reassignment). Cloudflare's free "quick tunnel" runs on
    // Cloudflare's real edge network — same $0 cost, far more reliable.
    // If the cloudflared binary can't run on this host (some restricted
    // containers block spawning external binaries), we fall back to the old
    // localtunnel approach so the bot still gets SOME public URL.
    (async () => {
      let usedCloudflare = false;

      try {
        const { Tunnel } = require('cloudflared');
        let cfTunnel = null;

        const connectCloudflare = async () => {
          try {
            cfTunnel = Tunnel.quick(`http://localhost:${PORT}`);

            const urlPromise = new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('timeout waiting for URL')), 30000);
              cfTunnel.once('url', (u) => { clearTimeout(timer); resolve(u); });
            });

            const url = await urlPromise;
            currentBackendUrl = url;
            publishServerStatus(url);
            console.log(`\n🔒 Public HTTPS URL (Cloudflare): ${url}\n`);
            console.log(`ℹ️  Frontend will auto-discover this — no manual update needed.`);

            cfTunnel.on('exit', (code) => {
              console.log(`[Cloudflare Tunnel] process exited (code ${code}) — reconnecting in 5s...`);
              setTimeout(connectCloudflare, 5000);
            });
          } catch (e) {
            console.log('[Cloudflare Tunnel] failed to start:', e.message, '— retrying in 5s...');
            setTimeout(connectCloudflare, 5000);
          }
        };

        await connectCloudflare();
        usedCloudflare = true;
      } catch (e) {
        console.log('[Cloudflare Tunnel] package not available:', e.message);
      }

      // localtunnel always runs too now — even when Cloudflare succeeds —
      // since its fixed, predictable URL is what makes the discovery
      // endpoint reachable at all.

      // ── localtunnel (fixed subdomain) ─────────────────────────────────────
      try {
        const localtunnel = require('localtunnel');
        const EXPECTED_SUBDOMAIN = 'mrmuneebalibot';
        const EXPECTED_URL = `https://${EXPECTED_SUBDOMAIN}.loca.lt`;
        let tunnelInstance = null;
        let subdomainMismatchCount = 0;

        const connectTunnel = async () => {
          try {
            tunnelInstance = await localtunnel({ port: PORT, subdomain: EXPECTED_SUBDOMAIN });

            if (tunnelInstance.url !== EXPECTED_URL) {
              subdomainMismatchCount++;
              console.log(`⚠️  [Tunnel] Got WRONG subdomain: ${tunnelInstance.url} (expected ${EXPECTED_URL}) — attempt #${subdomainMismatchCount}`);
              if (subdomainMismatchCount <= 10) {
                try { tunnelInstance.close(); } catch (_) {}
                const retryDelay = Math.min(2000 * subdomainMismatchCount, 20000);
                setTimeout(connectTunnel, retryDelay);
                return;
              }
              console.log(`🚨 [Tunnel] Running on FALLBACK URL: ${tunnelInstance.url} — update frontend manually.`);
            } else {
              subdomainMismatchCount = 0;
            }

            console.log(`\n🔒 Public HTTPS URL (localtunnel): ${tunnelInstance.url}\n`);
            if (!usedCloudflare) { currentBackendUrl = tunnelInstance.url; publishServerStatus(tunnelInstance.url); }

            tunnelInstance.on('close', () => { setTimeout(connectTunnel, 5000); });
            tunnelInstance.on('error', () => { setTimeout(connectTunnel, 5000); });
          } catch (e) {
            console.log('[Tunnel] failed to start:', e.message, '— retrying in 5s...');
            setTimeout(connectTunnel, 5000);
          }
        };

        connectTunnel();

        setInterval(async () => {
          try {
            const https = require('https');
            const checkUrl = (tunnelInstance && tunnelInstance.url) || EXPECTED_URL;
            await new Promise((resolve, reject) => {
              const req = https.get(`${checkUrl}/api/public/status`, { timeout: 8000 }, (r) => { r.resume(); resolve(); });
              req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
              req.on('error', reject);
            });
          } catch (e) {
            console.log('[Tunnel] health check failed — forcing reconnect...');
            try { tunnelInstance && tunnelInstance.close(); } catch (_) {}
          }
        }, 60 * 1000);
      } catch (e) {
        console.log('[Tunnel] localtunnel package not installed either:', e.message);
      }
    })();
  });
}

function startKeepAlive() {
  // Keep-alive pings every 4 minutes to prevent Replit sleep
  setInterval(() => {
    try {
      const req = require('http').get(`http://localhost:${process.env.PORT || 5000}/api/public/status`);
      req.on('error', () => {});
    } catch (_) {}
  }, 4 * 60 * 1000);
}

module.exports = { startPanelServer, startKeepAlive, app, io };
