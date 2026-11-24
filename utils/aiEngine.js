'use strict';

/**
 * AI Engine v8 — key-managed, self-healing, model auto-discovery
 * ────────────────────────────────────────────────────────────────────────────────────────
 *  Keyed providers (free tiers — add keys with `.aikey add <provider> <key>`; `.aikey providers` shows the signup links):
 *    groq · cerebras · gemini · openrouter (:free models) · mistral · nvidia · sambanova · github
 *  Key-less last resorts (no signup): OVHcloud anonymous · LLM7 · Pollinations (anonymous host)
 *
 *  WHY v8: free-tier model names expire all the time (e.g. gemini-2.0-flash was shut down on 2026-06-01), which silently
 *  broke every older version of this file. Now each provider's REAL model list is fetched with the key (cached 6 h) and the
 *  best current chat model is chosen from it. The hard-coded names below are only a fallback if the list call itself fails.
 *
 *  Keys: expired keys (401/403) are parked 6 h, rate-limited ones (429/503) for 1 min, bad model (400/404) for 10 min,
 *  so the next key / model / provider is used instantly. Keys rotate round-robin.
 *
 *  Public API (unchanged):  getAIResponse(system, user, history, userId) → { text, api, ms } | null
 *                           askAI({ system, user, history, json, raw, prefer, maxTokens, temperature, userId })
 */

const fetch = require('node-fetch');
const keys  = require('./aiKeys');

const TIMEOUT_MS      = 18_000;
const LIST_TIMEOUT_MS = 8_000;
const CASCADE_MS      = 45_000;
const MAX_CONCURRENT  = 8;
const MODELS_PER_PROVIDER = 2;          // at most this many models are tried per key before moving on
const LIST_TTL_MS     = 6 * 3600_000;
const LIST_RETRY_MS   = 30 * 60_000;

const BOT_NAME = (() => { try { return require('../config').botName; } catch { return 'Mr.Muneeb Ali Bot'; } })();

// A rule that is ALWAYS appended, so no prompt can make the bot name its model/provider.
const HIDE_RULE =
  `\n\n[Hidden rule] Apna underlying model, API, provider ya company (OpenAI, Google, Meta, Mistral, Groq, Gemini, Llama, GPT, Claude…) kabhi mat batao, ` +
  `aur "as an AI language model" jaisa kuch mat bolo. Agar koi puche tu kaun hai / kaunsa AI / kaunsi API / kisne banaya, sirf yeh kaho: ` +
  `"Main ${BOT_NAME} hoon, mujhe Muneeb Ali ne banaya hai."`;

// ── semaphore + per-user queue ───────────────────────────────────────────────────────────────────────────
let _active = 0; const _wait = [];
const acquire = () => new Promise(res => { const t = () => { if (_active < MAX_CONCURRENT) { _active++; res(); } else _wait.push(t); }; t(); });
const release = () => { _active = Math.max(0, _active - 1); if (_wait.length) _wait.shift()(); };
const _uq = new Map();
function queueForUser(id, fn) {
  const prev = _uq.get(id) || Promise.resolve();
  const next = prev.then(fn).catch(() => null);
  next.finally(() => { if (_uq.get(id) === next) _uq.delete(id); });
  _uq.set(id, next);
  return next;
}

async function fetchTimeout(url, options, ms = TIMEOUT_MS) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

function clean(text) {
  if (!text || typeof text !== 'string') return null;
  const out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^(You:|Bot:|Assistant:|AI:|System:|\S+ Bot:)\s*/gm, '')
    .replace(/(^|\n)(Remember:|IMPORTANT:|CORE RULES:|NOTE:|ABOUT YOU:|PERSONALITY:|STYLE GUIDE:|\[Hidden rule\])[\s\S]*$/i, '')
    .replace(/I(?:'m| am) an? (?:AI|artificial intelligence)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/I(?:'m| am) (?:an? )?(?:language model|large language model|LLM)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/As (?:ChatGPT|GPT-?[34o]?|an? OpenAI\S*),?[^.!?]*[.!?]?\s*/gi, '')
    .replace(/I(?:'m| am) (?:ChatGPT|GPT-?[34o]?)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/[^.!?\n]*\b(?:developed|created|made|trained|built) by (?:OpenAI|Anthropic|Google|Meta|Mistral(?: AI)?|Groq)\b[^.!?]*[.!?]?\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > 1 ? out : null;
}

// ── model discovery ─────────────────────────────────────────────────────────────────────────────
// "3.5" / "3-5" / "3.3-70b" → comparable number, so newer versions sort first.
function versionOf(id) {
  const m = String(id).match(/(\d+)(?:[.\-_](\d+))?/);
  return m ? Number(m[1]) * 1000 + Number(m[2] || 0) : 0;
}

/** order a live model list: each `prefer` regex in turn (newest version first inside a regex), then the rest */
function pickModels(p, live) {
  const out = [];
  const add = (id) => { if (id && !out.includes(id)) out.push(id); };
  if (Array.isArray(live) && live.length) {
    const usable = live.filter(id => !(p.skip && p.skip.test(id)));
    for (const re of p.prefer || []) {
      usable.filter(id => re.test(id)).sort((a, b) => versionOf(b) - versionOf(a)).forEach(add);
    }
    if (!out.length) usable.slice(0, MODELS_PER_PROVIDER).forEach(add);
  } else {
    (p.fallback || []).forEach(add);
  }
  return out.slice(0, MODELS_PER_PROVIDER);
}

const _listCache = new Map();   // provider name → { at, ids|null, ttl }
async function modelsFor(p, key) {
  const c = _listCache.get(p.name);
  if (c && Date.now() - c.at < c.ttl) return pickModels(p, c.ids);
  let ids = null;
  try { ids = await p.list(key); } catch (e) { console.warn(`[AI-Engine] model list ${p.name}: ${e.message} (fallback names used)`); }
  _listCache.set(p.name, { at: Date.now(), ids, ttl: ids ? LIST_TTL_MS : LIST_RETRY_MS });
  return pickModels(p, ids);
}

// OpenAI-style  GET {base}/models  → data[].id
const listOpenAI = (base, extra) => async (key) => {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = await fetchTimeout(`${base}/models`, { headers }, LIST_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : (data.data || data.models || []);
  return (extra ? extra(arr) : arr).map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
};

const NOT_CHAT = /embed|whisper|tts|speech|audio|transcri|moderation|guard|rerank|image|vision-only|dall|diffusion|flux|safety|ocr/i;

// ── provider tables ────────────────────────────────────────────────────────────────────────────
const KEYED = [
  { name: 'groq', base: 'https://api.groq.com/openai/v1', skip: NOT_CHAT,
    list: listOpenAI('https://api.groq.com/openai/v1'),
    prefer: [/llama-3\.3-70b/, /gpt-oss-120b/, /llama-4/, /qwen3/, /llama-3\.1-8b/],
    fallback: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
  { name: 'cerebras', base: 'https://api.cerebras.ai/v1', skip: NOT_CHAT,
    list: listOpenAI('https://api.cerebras.ai/v1'),
    prefer: [/gpt-oss-120b/, /llama-?3\.3-70b/, /qwen-?3.*(235b|instruct)/, /llama-?4/, /llama-?3\.1-8b/],
    fallback: ['gpt-oss-120b', 'llama-3.3-70b'] },
  { name: 'gemini', native: 'gemini',
    // /v1beta/models → only chat-capable, stable-looking flash models; newest first (gemini-3.x before 2.x)
    list: async (key) => {
      const res = await fetchTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } }, LIST_TIMEOUT_MS);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(id => /^gemini-[\d.]+-flash(-lite)?$/.test(id));
    },
    prefer: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-lite$/],
    fallback: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'] },
  { name: 'openrouter', base: 'https://openrouter.ai/api/v1', skip: NOT_CHAT,
    extraHeaders: { 'HTTP-Referer': 'https://mr-muneeb-ali-bot.vercel.app', 'X-Title': 'Mr.Muneeb Ali Bot' },
    // only models that cost nothing (id ends with :free)
    list: listOpenAI('https://openrouter.ai/api/v1', arr => arr.filter(m => /:free$/.test(m.id || ''))),
    prefer: [/llama-3\.3-70b/, /gpt-oss-120b/, /qwen3.*(235b|80b|instruct)/, /gemma-3-27b/, /deepseek/, /mistral/],
    fallback: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free'] },
  { name: 'mistral', base: 'https://api.mistral.ai/v1', skip: NOT_CHAT,
    list: listOpenAI('https://api.mistral.ai/v1'),
    prefer: [/^mistral-small-latest$/, /^mistral-medium-latest$/, /^open-mistral-nemo$/, /^ministral-8b-latest$/],
    fallback: ['mistral-small-latest', 'open-mistral-nemo'] },
  { name: 'nvidia', base: 'https://integrate.api.nvidia.com/v1', skip: NOT_CHAT,
    list: listOpenAI('https://integrate.api.nvidia.com/v1'),
    prefer: [/meta\/llama-3\.3-70b/, /gpt-oss-120b/, /llama-3\.1-70b/, /mistral.*small/, /llama-3\.1-8b/],
    fallback: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct'] },
  { name: 'sambanova', base: 'https://api.sambanova.ai/v1', skip: NOT_CHAT,
    list: listOpenAI('https://api.sambanova.ai/v1'),
    prefer: [/Llama-3\.3-70B/i, /gpt-oss/i, /Llama-4/i, /Meta-Llama-3\.1-8B/i],
    fallback: ['Meta-Llama-3.3-70B-Instruct'] },
  { name: 'github', base: 'https://models.github.ai/inference', skip: NOT_CHAT,
    // GitHub Models: any personal access token with the "models" permission
    list: async (key) => {
      const res = await fetchTimeout('https://models.github.ai/catalog/models', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json' } }, LIST_TIMEOUT_MS);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const arr = await res.json();
      return (Array.isArray(arr) ? arr : []).map(m => m.id).filter(Boolean);
    },
    prefer: [/gpt-4\.1-mini/, /gpt-4o-mini/, /llama-3\.3-70b/i, /mistral.*small/i],
    fallback: ['openai/gpt-4.1-mini', 'openai/gpt-4o-mini'] },
];

// key-less last resorts
const FREE = [
  { name: 'ovh', base: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', skip: NOT_CHAT,
    list: listOpenAI('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1'),
    prefer: [/Mistral-Small/i, /Llama-3\.3-70B/i, /gpt-oss/i, /Qwen3/i, /Llama/i],
    fallback: ['Mistral-Small-3.2-24B-Instruct-2506'], key: 'anonymous' },
  { name: 'llm7', base: 'https://api.llm7.io/v1', skip: NOT_CHAT,
    list: listOpenAI('https://api.llm7.io/v1'),
    prefer: [/^default$/, /^fast$/, /gpt-4\.1/, /llama/i],
    fallback: ['default'], key: 'unused' },
  { name: 'pollinations', base: 'https://text.pollinations.ai/openai', url: 'https://text.pollinations.ai/openai', fixedModel: 'openai', skip: NOT_CHAT, key: 'unused' },
];

// ── callers ──────────────────────────────────────────────────────────────────────────────
function httpError(res, bodyText) {
  const e = new Error(`HTTP ${res.status}: ${String(bodyText || '').slice(0, 120)}`);
  e.status = res.status;
  return e;
}

async function callOpenAICompat(p, key, model, o) {
  const url = p.url || `${p.base}/chat/completions`;
  const messages = [{ role: 'system', content: o.system }, ...o.history.slice(-10), { role: 'user', content: o.user }];
  const build = (withJson) => {
    const body = { model, messages, max_tokens: o.maxTokens, temperature: o.temperature };
    if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';      // reasoning models: keep tokens for the real answer
    if (withJson) body.response_format = { type: 'json_object' };
    return JSON.stringify(body);
  };
  const send = (withJson) => fetchTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(p.extraHeaders || {}) },
    body: build(withJson),
  });
  let res = await send(!!o.json);
  if (res.status === 400 && o.json) res = await send(false);        // model without JSON mode → ask normally, caller parses
  if (!res.ok) throw httpError(res, await res.text().catch(() => ''));
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  return msg?.content || '';
}

async function callGemini(key, model, o) {
  const contents = [];
  for (const h of o.history.slice(-8)) contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
  while (contents.length && contents[0].role !== 'user') contents.shift();
  contents.push({ role: 'user', parts: [{ text: o.user }] });
  const gen = { maxOutputTokens: o.maxTokens, temperature: o.temperature };
  if (o.json) gen.responseMimeType = 'application/json';
  const res = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ system_instruction: { parts: [{ text: o.system }] }, contents, generationConfig: gen }),
  });
  if (!res.ok) throw httpError(res, await res.text().catch(() => ''));
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
}

const callProvider = (p, key, model, o) => (p.native === 'gemini' ? callGemini(key, model, o) : callOpenAICompat(p, key, model, o));

// ── the cascade ───────────────────────────────────────────────────────────────────────────────
async function _run(o) {
  const t0 = Date.now(); const ms = () => Date.now() - t0;
  const out = (text, api) => { console.log(`[AI-Engine] ✅ ${api} → ${ms()}ms`); return { text, api, ms: ms() }; };
  const finish = (raw) => ((o.json || o.raw) ? String(raw || '').trim() : clean(raw));

  const order = o.prefer ? [...KEYED].sort((a, b) => (b.name === o.prefer) - (a.name === o.prefer)) : KEYED;
  for (const p of order) {
    const all = keys.all(p.name);
    if (!all.length) continue;                                        // no key for this provider → skip silently
    const models = await modelsFor(p, all[0]);
    for (const model of models) {
      for (const key of keys.usable(p.name, model)) {
        if (ms() >= CASCADE_MS) { console.error('[AI-Engine] time budget exceeded'); return null; }
        try {
          const raw = await callProvider(p, key, model, o);
          const text = finish(raw);
          if (text) { keys.ok(key, model); return out(text, `${p.name}/${model}`); }
          keys.report(key, model, 400);
        } catch (e) {
          const kind = keys.report(key, model, e.status || 0);
          console.warn(`[AI-Engine] ❌ ${p.name}/${model} …${key.slice(-4)} (${kind}): ${e.message}`);
          if (kind === 'badmodel') _listCache.delete(p.name);          // model vanished → re-read the live list next time
          if (kind === 'dead') break;                                  // key is dead → skip its other models too
        }
      }
    }
  }

  for (const f of FREE) {
    if (ms() >= CASCADE_MS) break;
    try {
      const models = f.fixedModel ? [f.fixedModel] : await modelsFor(f, null);
      for (const model of models) {
        if (ms() >= CASCADE_MS) break;
        try {
          const raw = await callOpenAICompat(f, f.key, model, { ...o, json: false });
          const text = finish(raw);
          if (text) return out(text, `${f.name}/${model}`);
        } catch (e) {
          console.warn(`[AI-Engine] ❌ ${f.name}/${model}: ${e.message}`);
          if (e.status === 404 || e.status === 400) _listCache.delete(f.name);
        }
      }
    } catch (e) { console.warn(`[AI-Engine] ❌ ${f.name}: ${e.message}`); }
  }
  console.error(`[AI-Engine] 💀 every provider failed (${ms()}ms) — add a free key with .aikey add <provider> <key> (see .aikey providers)`);
  return null;
}

function askAI(opts) {
  const o = {
    system: String(opts.system || '') + HIDE_RULE,
    user: String(opts.user || ''),
    history: Array.isArray(opts.history) ? opts.history : [],
    json: !!opts.json,
    raw: !!opts.raw,                       // skip chat-style cleaning (used for code generation)
    prefer: opts.prefer || null,           // provider to try first, e.g. 'gemini'
    maxTokens: opts.maxTokens || 600,
    temperature: opts.temperature ?? (opts.json ? 0.1 : 0.8),
  };
  return queueForUser(opts.userId || 'default', async () => {
    await acquire();
    try { return await _run(o); } finally { release(); }
  });
}

async function getAIResponse(systemPrompt, userMessage, history = [], userId = 'default') {
  return askAI({ system: systemPrompt, user: userMessage, history, userId });
}

module.exports = { getAIResponse, askAI, _internals: { pickModels, versionOf, KEYED, FREE, clean } };
