'use strict';
/**
 * utils/updateSource.js — where `.update` / `.checkupdate` / the "update available" notice get their files from.
 *
 * PUBLIC repo  : works with no setup (github.com/…/archive zip + raw.githubusercontent.com version.json)
 * PRIVATE repo : set a READ-ONLY GitHub token and everything switches to the authenticated GitHub API
 *                (api.github.com zipball + contents) — the token is sent ONLY to api.github.com / raw.githubusercontent.com,
 *                never to any other host and never to a redirect target.
 *
 *   token sources (first found wins):  env UPDATE_GITHUB_TOKEN   →   data/updateToken.json  (written by `.updatetoken`)
 *   Create it at GitHub → Settings → Developer settings → Fine-grained tokens → only repo "muneeb-bot-updater",
 *   permission  Contents: Read-only  (Metadata: Read-only is added automatically).  Nothing else is needed.
 *
 * If a token is set but stops working (expired / revoked) while the repo is still public, callers fall back to the public URLs.
 */

const fs   = require('fs');
const path = require('path');

const REPO = { owner: 'mr-muneeb-ali-abbasi', repo: 'muneeb-bot-updater', branch: 'main' };
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'updateToken.json');
const TOKEN_RE = /^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})$/;

// ── token ───────────────────────────────────────────────────────────────────
function token() {
  const e = String(process.env.UPDATE_GITHUB_TOKEN || '').trim();
  if (e) return e;
  try { return String(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || '').trim(); } catch (_) { return ''; }
}
function isValidToken(t) { return TOKEN_RE.test(String(t || '').trim()); }
function setToken(t) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: String(t).trim(), savedAt: new Date().toISOString() }), { mode: 0o600 });
}
function clearToken() { try { fs.unlinkSync(TOKEN_FILE); return true; } catch (_) { return false; } }
function tokenSource() { return process.env.UPDATE_GITHUB_TOKEN ? 'env' : (fs.existsSync(TOKEN_FILE) ? 'file' : null); }

// ── which repo ──────────────────────────────────────────────────────────────
function repoInfo() {
  const z = process.env.UPDATE_ZIP_URL;
  if (z) {
    const m = z.match(/github\.com\/([^/]+)\/([^/]+)\/archive\/refs\/heads\/(.+?)\.zip/i) || z.match(/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/zipball\/(.+)$/i);
    if (m) return { owner: m[1], repo: m[2], branch: m[3] };
  }
  return { ...REPO };
}

// ── URLs ────────────────────────────────────────────────────────────────────
function publicZipUrl() { const r = repoInfo(); return `https://github.com/${r.owner}/${r.repo}/archive/refs/heads/${r.branch}.zip`; }
function publicVersionUrl() { const r = repoInfo(); return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch}/version.json`; }
function apiZipUrl() { const r = repoInfo(); return `https://api.github.com/repos/${r.owner}/${r.repo}/zipball/${r.branch}`; }
function apiVersionUrl() { const r = repoInfo(); return `https://api.github.com/repos/${r.owner}/${r.repo}/contents/version.json?ref=${r.branch}`; }

/** URL used first. With a token → the authenticated API (works for private repos). UPDATE_ZIP_URL, if set, always wins. */
function zipUrl() { return process.env.UPDATE_ZIP_URL || (token() ? apiZipUrl() : publicZipUrl()); }
function versionUrl() { return token() ? apiVersionUrl() : publicVersionUrl(); }
/** true when `url` is one of the token-based URLs (so a public fallback makes sense) */
function isAuthUrl(url) { return /^https:\/\/api\.github\.com\//i.test(String(url || '')); }

/** Auth headers — ONLY for GitHub's own API/raw hosts. Everything else (incl. redirect targets such as codeload) gets none. */
function headersFor(url, base) {
  const h = { ...(base || {}) };
  const t = token();
  if (!t) return h;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return h; }
  if (host === 'api.github.com') {
    h.Authorization = `Bearer ${t}`;
    h['X-GitHub-Api-Version'] = '2022-11-28';
    h.Accept = /\/contents\//.test(url) ? 'application/vnd.github.raw+json' : 'application/vnd.github+json';
  } else if (host === 'raw.githubusercontent.com') {
    h.Authorization = `token ${t}`;
  }
  return h;
}

// ── text shown in chat ──────────────────────────────────────────────────────
/** remove anything that looks like a repo / url / token from text that is shown in chat */
function scrub(text) {
  return String(text || '')
    .replace(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/g, '[token]')
    .replace(/https?:\/\/\S+/gi, '[server]')
    .replace(/github(usercontent)?\.com\S*/gi, '[server]')
    .replace(/mr-muneeb-ali-abbasi\S*/gi, '[server]')
    .slice(0, 300);
}

/** friendly Hinglish hint for a failed update-server request */
function explain(err) {
  const msg = String((err && err.message) || err || '');
  const has = !!token();
  if (/HTTP 404/.test(msg)) return has
    ? '\n\n💡 Server ne file nahi di. Token ko repo `muneeb-bot-updater` par *Contents: Read-only* permission chahiye — `.updatetoken status` se check karo.'
    : '\n\n💡 Agar update repo *private* hai to ek read-only GitHub token set karo: *.updatetoken <token>*  (kaise banana hai: *.updatetoken help*).';
  if (/HTTP 401/.test(msg)) return '\n\n💡 Token galat / expire / revoke ho gaya. Naya banao aur *.updatetoken <naya token>* chalao.';
  if (/HTTP 403/.test(msg)) return '\n\n💡 GitHub ne mana kar diya (rate-limit ya token ki permission). Thodi der baad try karo, ya token mein *Contents: Read-only* do.';
  return '';
}

module.exports = {
  zipUrl, versionUrl, publicZipUrl, publicVersionUrl, isAuthUrl, headersFor, scrub, explain, repoInfo,
  token, isValidToken, setToken, clearToken, tokenSource, TOKEN_FILE,
};
