'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   Mr.Muneeb Ali Bot — Website Logic
   ═══════════════════════════════════════════════════════════════════════ */

// ── GitHub Gist where every backend server publishes its own live status.
// Must match "gistId" in every server's config.js. One gist, one file per
// server (file name = "server-<slugified serverName>.json") — so adding a
// new server on your end just means a new file shows up here automatically,
// no frontend change needed.
const GIST_ID = '4a34b2c132c790960e056cd94e6f92d9';
const STALE_MS = 10 * 60 * 1000; // backend ab rate-limit bachane ke liye ~4 min mein heartbeat deta hai (tunnel girne par turant offline likhta hai);  // server heartbeats every 15s — if a file hasn't
                              // updated in 50s (missed ~3 beats), treat it as
                              // actually offline instead of trusting a possibly-
                              // dead last value. Servers also now self-report
                              // "offline" immediately the moment their tunnel
                              // dies (see server.js), instead of only correcting
                              // on the next successful reconnect — so a card
                              // should flip to Offline fast and honestly instead
                              // of hanging on a stale "Online" that silently fails.
const HIDE_AFTER_MS = 24 * 60 * 60 * 1000; // a server silent for 24h+ is treated
                              // as retired and dropped from the list entirely —
                              // this is what auto-cleans old/renamed "ghost" cards.

// ═══════════════════════════════════════════════════════════════
// COMMANDS SHOWCASE
// ═══════════════════════════════════════════════════════════════
const COMMANDS = [
  { name: '.menu', desc: 'Shows the full list of every command the bot supports, organized by category.' },
  { name: '.sticker', desc: 'Reply to any photo or short video with this to instantly turn it into a WhatsApp sticker.' },
  { name: '.antilink', desc: 'Admin-only group toggle. When on, any link sent by a non-admin is removed automatically to keep the group clean.' },
  { name: '.antibug', desc: 'Protects the group from crash/attack-tool messages (e.g. spam payloads designed to crash WhatsApp). Safe for normal users — only real attack patterns get caught.' },
  { name: '.antiuserbot', desc: 'Detects and removes unauthorized bots that join your group, without affecting real members.' },
  { name: '.ai <question>', desc: 'Ask the built-in AI chatbot anything — get an instant reply right inside WhatsApp.' },
  { name: '.play <song name>', desc: 'Searches and sends an audio file of the song you asked for.' },
  { name: '.tgsticker <pack>', desc: 'Downloads an entire Telegram sticker pack and converts it into WhatsApp stickers for you.' },
  { name: '.ban / .kick', desc: 'Admin-only. Removes a mentioned member from the group.' },
  { name: '.owner', desc: "Shows the bot owner's contact details." }
];
function renderCommands() {
  const grid = document.getElementById('cmd-grid');
  grid.innerHTML = COMMANDS.map((c, i) => `
    <div class="glass cmd-item" id="cmd-item-${i}">
      <button class="cmd-btn" onclick="toggleCommand(${i})">
        <span class="name">${c.name}</span><span class="plus">+</span>
      </button>
      <div class="cmd-panel"><div class="cmd-panel-inner">${c.desc}</div></div>
    </div>`).join('');
}
function toggleCommand(i) {
  const el = document.getElementById(`cmd-item-${i}`);
  const wasOpen = el.classList.contains('open');
  document.querySelectorAll('.cmd-item.open').forEach(x => x.classList.remove('open'));
  if (!wasOpen) el.classList.add('open');
}
renderCommands();

// ═══════════════════════════════════════════════════════════════
// CLICK SOUND — tiny synthesized "tick", no external audio file needed
// ═══════════════════════════════════════════════════════════════
let _actx = null;
function playClick() {
  try {
    if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
    if (_actx.state === 'suspended') _actx.resume();
    const t = _actx.currentTime;
    const osc = _actx.createOscillator();
    const gain = _actx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(820, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 0.08);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(gain).connect(_actx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch (_) {}
}
document.addEventListener('click', (e) => {
  if (e.target.closest('button, a.btn, .cmd-btn, .server-card, .tab')) playClick();
}, true);

// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ═══════════════════════════════════════════════════════════════
// THEME (day / night)
// ═══════════════════════════════════════════════════════════════
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '🌙' : '☀️';
  try { localStorage.setItem('mb-theme', theme); } catch (_) {}
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('mb-theme'); } catch (_) {}
  const theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(theme);
})();
document.getElementById('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ═══════════════════════════════════════════════════════════════
// LANGUAGE
// ═══════════════════════════════════════════════════════════════
function applyLang(lang) {
  const dict = window.I18N[lang] || window.I18N.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] != null) el.innerHTML = dict[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key] != null) el.setAttribute('placeholder', dict[key]);
  });
  document.documentElement.setAttribute('lang', lang);
  document.documentElement.setAttribute('dir', window.I18N_RTL[lang] ? 'rtl' : 'ltr');
  try { localStorage.setItem('mb-lang', lang); } catch (_) {}
  window._mbLang = lang;
  renderCommands(); // command list has no data-i18n (kept bilingual on purpose), but re-render for RTL layout
}
(function initLang() {
  const sel = document.getElementById('lang-select');
  Object.keys(window.I18N).forEach(code => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = window.I18N[code]._label;
    sel.appendChild(opt);
  });
  let saved = null;
  try { saved = localStorage.getItem('mb-lang'); } catch (_) {}
  const browserLang = (navigator.language || 'en').slice(0, 2);
  const lang = saved || (window.I18N[browserLang] ? browserLang : 'en');
  sel.value = lang;
  sel.addEventListener('change', () => applyLang(sel.value));
  applyLang(lang);
})();

// ═══════════════════════════════════════════════════════════════
// SOCIAL LINKS (from config.js's "social" block — update here if it changes)
// ═══════════════════════════════════════════════════════════════
const SOCIAL_LINKS = [
  { icon: '📢', label: 'WhatsApp Channel', url: 'https://whatsapp.com/channel/0296SaioLiqKUMBSZJW' },
  { icon: '▶️', label: 'YouTube',   url: 'https://www.youtube.com/@MrMuneebAli05' },
  { icon: '💼', label: 'LinkedIn',  url: 'https://www.linkedin.com/in/abbasi-king-5a0437418' },
  { icon: '📘', label: 'Facebook',  url: 'https://www.facebook.com/share/1572s6fFm7/' },
  { icon: '🐙', label: 'GitHub',    url: 'https://github.com/mr-muneeb-ali-abbasi/mr-muneeb-ali-abbasi' },
  { icon: '💬', label: 'WhatsApp',  url: 'https://wa.me/923196615238' },
  { icon: '📸', label: 'Instagram', url: 'https://www.instagram.com/abbasiking155?igsh=MjV6OTgyOTAyZm85' },
  { icon: '🎵', label: 'TikTok',    url: 'https://tiktok.com/@its.muneeb.king09' }
];
(function renderSocial() {
  const row = document.getElementById('social-row');
  row.innerHTML = SOCIAL_LINKS.map(s => `<a href="${s.url}" target="_blank" rel="noopener" title="${s.label}" aria-label="${s.label}">${s.icon}</a>`).join('');
  const pr = document.getElementById('profile-social');
  if (pr) pr.innerHTML = SOCIAL_LINKS.map(s => `<a class="soc-chip" href="${s.url}" target="_blank" rel="noopener"><span>${s.icon}</span>${s.label}</a>`).join('');
})();
document.getElementById('year').textContent = new Date().getFullYear();


// ═══════════════════════════════════════════════════════════════
// SELECT SERVER — reads the shared Gist, renders cards, no hardcoded list
// ═══════════════════════════════════════════════════════════════
let servers = [];        // last-known-good list, kept even if a poll fails
let selectedServer = null;

function slugify(s) {
  return String(s || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

async function fetchServers() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}?t=${Date.now()}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/vnd.github+json' }
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('gist fetch failed');
    const gist = await res.json();
    const files = gist.files || {};
    const now = Date.now();
    const list = [];
    for (const fname of Object.keys(files)) {
      if (!/^server-.*\.json$/.test(fname)) continue;
      try {
        const obj = JSON.parse(files[fname].content);
        if (!obj || !obj.name) continue;
        // A server that hasn't published a heartbeat in a very long time is
        // treated as retired/renamed, not just "offline" — it disappears from
        // the list on its own instead of sitting there forever as a ghost
        // card. (A server that's merely down for a bit still shows, as
        // "Offline", via the shorter STALE_MS check below.)
        if (!obj.updatedAt || (now - obj.updatedAt) > HIDE_AFTER_MS) continue;
        const fresh = (now - obj.updatedAt) < STALE_MS;
        list.push({
          slug: slugify(obj.name),
          name: obj.name,
          url: obj.url || '',
          connected: Number(obj.connected) || 0,
          maxSlots: Number(obj.maxSlots) || 0,
          online: !!fresh && !!obj.url
        });
      } catch (_) { /* skip a corrupt entry, don't break the rest */ }
    }
    if (list.length) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      servers = list;
    }
    // if the gist came back empty/unreachable this cycle, we simply keep the
    // previous good "servers" array instead of flashing everything "Offline" —
    // this is the main fix for the old refresh-to-refresh flakiness.
  } catch (e) {
    // transient network hiccup — keep showing the last good data, don't wipe cards
  }
  renderServers();
}

function renderServers() {
  const grid = document.getElementById('server-grid');
  const dict = window.I18N[window._mbLang] || window.I18N.en;
  if (!servers.length) {
    grid.innerHTML = `<div class="server-grid-empty">${dict['srv.none']}</div>`;
  } else {
    grid.innerHTML = servers.map(s => {
      const full = s.online && s.maxSlots > 0 && s.connected >= s.maxSlots;
      const pillClass = !s.online ? 'offline' : (full ? 'full' : 'online');
      const pillText = !s.online ? dict['srv.offline'] : (full ? dict['srv.full'] : dict['srv.online']);
      const pct = s.maxSlots > 0 ? Math.min(100, Math.round((s.connected / s.maxSlots) * 100)) : 0;
      const isSel = selectedServer && selectedServer.slug === s.slug;
      const disabled = (!s.online || full) ? 'disabled' : '';
      const adminLink = s.url
        ? `<a href="${s.url}/manage" target="_blank" rel="noopener" class="icon-btn" title="Admin Panel" style="width:34px;height:34px;font-size:.9rem;flex:none;">⚙️</a>`
        : '';
      return `
      <div class="glass server-card ${isSel ? 'selected' : ''}">
        <div class="server-top">
          <span class="server-name">📡 ${escHtml(s.name)}</span>
          <span class="status-pill ${pillClass}"><span class="dot"></span>${pillText}</span>
        </div>
        <div class="server-slots-bar"><div class="server-slots-fill" style="width:${pct}%"></div></div>
        <div class="server-slots-label">${s.connected}/${s.maxSlots || '?'} ${dict['srv.slots']}</div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="btn ${isSel ? 'btn-primary' : 'btn-outline'} btn-block" style="flex:1;" ${disabled}
            onclick="selectServer('${s.slug}')">${isSel ? '✅ ' + dict['srv.selected'] : dict['srv.select']}</button>
          ${adminLink}
        </div>
      </div>`;
    }).join('');
  }
  // hero stats
  const totalConnected = servers.reduce((a, s) => a + (s.online ? s.connected : 0), 0);
  const onlineCount = servers.filter(s => s.online).length;
  document.getElementById('stat-connected').textContent = servers.length ? totalConnected : '—';
  document.getElementById('stat-servers').textContent = servers.length ? onlineCount : '—';
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function selectServer(slug) {
  const s = servers.find(x => x.slug === slug);
  if (!s) return;
  selectedServer = s;
  renderServers();
  const dict = window.I18N[window._mbLang] || window.I18N.en;
  document.getElementById('connect-server-name').textContent = `${s.name} — ${s.connected}/${s.maxSlots} ${dict['srv.slots']}`;
  document.getElementById('connect').scrollIntoView({ behavior: 'smooth', block: 'start' });
  resetConnectUI();
  startConnect();
}

fetchServers();
// 65s, not faster — GitHub's unauthenticated API allows 60 requests/hour per
// visitor; 65s keeps every visitor safely under that (≈55/hour) while still
// catching a server going down or coming back within a minute or so.
setInterval(fetchServers, 65 * 1000);

// ═══════════════════════════════════════════════════════════════
// CONNECT FLOW — same API contract as the bot's Panel/server.js
// (POST /api/public/connect, GET .../qr, POST .../paircode) scoped to
// whichever server card the visitor picked above.
// ═══════════════════════════════════════════════════════════════
let _token = null;
let _method = 'pair';
let _qrTimer = null;
let _pollTimer = null;
let _socket = null;

function switchTab(tab) {
  _method = tab;
  document.getElementById('tab-pair').classList.toggle('active', tab === 'pair');
  document.getElementById('tab-qr').classList.toggle('active', tab === 'qr');
  document.getElementById('panel-pair').classList.toggle('active', tab === 'pair');
  document.getElementById('panel-qr').classList.toggle('active', tab === 'qr');
  if (tab === 'qr' && _token) startQrFlow();
}
document.getElementById('tab-pair').onclick = () => switchTab('pair');
document.getElementById('tab-qr').onclick = () => switchTab('qr');

async function fetchWithRetry(url, options = {}, { retries = 3, timeoutMs = 12000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr;
}

function resetConnectUI() {
  clearTimers();
  _token = null;
  document.getElementById('pair-code-result').style.display = 'none';
  document.getElementById('pair-phone').value = '';
  document.getElementById('btn-get-paircode').disabled = false;
  const dict = window.I18N[window._mbLang] || window.I18N.en;
  document.getElementById('btn-get-paircode').textContent = dict['conn.getCode'];
  document.getElementById('qr-loading').style.display = 'flex';
  document.getElementById('qr-image').style.display = 'none';
}

function clearTimers() {
  if (_qrTimer) { clearInterval(_qrTimer); _qrTimer = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function startConnect() {
  if (!selectedServer) { toast((window.I18N[window._mbLang] || window.I18N.en)['conn.needServer'], 'error'); return; }
  try {
    _socket = io(selectedServer.url, { transports: ['websocket', 'polling'], extraHeaders: { 'Bypass-Tunnel-Reminder': 'true' } });
    _socket.on('connect:qr', ({ qr }) => { if (qr) showQrImage(qr); });
    _socket.on('connect:status', ({ status }) => { if (status === 'CONNECTED') onConnected(); });
  } catch (_) {}

  try {
    const res = await fetchWithRetry(
      selectedServer.url + '/api/public/connect',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true' }, body: '{}' },
      { retries: 3, timeoutMs: 12000 }
    );
    const data = await res.json();
    if (!data.success) { toast(data.error || 'Failed to start session.', 'error'); return; }
    _token = data.token;
    if (_socket && _socket.connected) _socket.emit('connect:subscribe', { token: _token });
    if (_method === 'qr') startQrFlow();
  } catch (e) {
    toast('Network error — please try again.', 'error');
  }
}

async function getPairCode() {
  const dict = window.I18N[window._mbLang] || window.I18N.en;
  const phone = document.getElementById('pair-phone').value.trim().replace(/[^0-9]/g, '');
  if (!phone || phone.length < 7) { toast(dict['conn.needPhone'], 'error'); return; }
  if (!_token) { await startConnect(); if (!_token) return; }

  const btn = document.getElementById('btn-get-paircode');
  btn.disabled = true;
  btn.textContent = dict['conn.connecting'];
  try {
    const res = await fetchWithRetry(
      `${selectedServer.url}/api/public/connect/${_token}/paircode`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true' }, body: JSON.stringify({ phone }) },
      { retries: 3, timeoutMs: 12000 }
    );
    const data = await res.json();
    if (data.success && data.code) {
      document.getElementById('pair-code-result').style.display = 'block';
      document.getElementById('pair-code-text').textContent = data.code;
      startPollStatus();
    } else {
      toast(data.error || 'Failed to get pairing code', 'error');
    }
  } catch (e) {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = dict['conn.getCode'];
  }
}

async function startQrFlow() {
  if (!_token) await startConnect();
  clearTimers();
  await refreshQR();
  _qrTimer = setInterval(refreshQR, 28000);
  startPollStatus();
}

async function refreshQR() {
  if (!_token || !selectedServer) return;
  try {
    const res = await fetch(`${selectedServer.url}/api/public/connect/${_token}/qr`, { headers: { 'Bypass-Tunnel-Reminder': 'true' } });
    const data = await res.json();
    if (data.status === 'CONNECTED') { onConnected(); return; }
    if (data.qr) showQrImage(data.qr);
  } catch (_) {}
}

function showQrImage(qrDataUrl) {
  document.getElementById('qr-loading').style.display = 'none';
  const img = document.getElementById('qr-image');
  img.src = qrDataUrl;
  img.style.display = 'block';
}

function startPollStatus() {
  clearInterval(_pollTimer);
  _pollTimer = setInterval(async () => {
    if (!_token || !selectedServer) return;
    try {
      const res = await fetch(`${selectedServer.url}/api/public/connect/${_token}/qr`, { headers: { 'Bypass-Tunnel-Reminder': 'true' } });
      const data = await res.json();
      if (data.status === 'CONNECTED') onConnected();
    } catch (_) {}
  }, 5000);
}

function onConnected() {
  clearTimers();
  _token = null;
  const dict = window.I18N[window._mbLang] || window.I18N.en;
  toast(dict['conn.connected'], 'success');
  fetchServers();
}
