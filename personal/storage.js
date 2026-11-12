// Storage abstraction for every Boardle key (puzzles, stats, openings, tests, settings).
//
//  * Local mode  (no backend / static hosting / signed out): plain localStorage,
//    exactly the pre-v3 behaviour and key names ("boardle:…").
//  * Server mode (python3 serve.py or the AWS deployment, signed in): the
//    signed-in player's keys live in memory, are cached in localStorage under
//    "boardle:u:<name>" for offline use, and are synced to /api/history
//    (debounced full-snapshot PUT with optimistic revision checks).
//
// The synchronous get/set API means the rest of the app does not care which
// mode is active. Signed-out ("Guest") data is never deleted: on the first
// sign-in on this device it is merged into that profile (see migrateGuest).

const PREFIX = "boardle:";
const USER_CACHE_PREFIX = "boardle:u:";
export const LOG_KEY = "boardle:history:log";
const LOG_CAP = 1500;
// Device-level keys: never scoped to a player, never synced.
const DEVICE_KEYS = new Set(["boardle:seenHelp", "boardle:migratedTo", "boardle:lastUser"]);

let user = null;           // { username } when signed in (server mode)
let serverInfo = null;     // /api/me payload when a backend answered
let data = null;           // signed-in key → value map
let rev = 0;               // server revision of `data`
let dirty = new Set();     // keys changed since last successful sync
let syncTimer = null;
let syncing = null;
let syncState = "local";   // local | synced | pending | offline | error
const listeners = new Set();

const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isAppKey = (k) => typeof k === "string" && k.startsWith(PREFIX) && !k.startsWith(USER_CACHE_PREFIX) && !DEVICE_KEYS.has(k);

function emit() { for (const fn of listeners) { try { fn(status()); } catch { /* ignore */ } } }
export function onStorageStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function status() {
  return {
    mode: user ? "server" : "local",
    serverAvailable: !!serverInfo,
    registration: serverInfo ? serverInfo.registration !== false : false,
    inviteRequired: !!(serverInfo && serverInfo.inviteRequired),
    user: user ? user.username : null,
    sync: syncState,
    pending: dirty.size,
    rev,
  };
}

// ---------------- synchronous key/value API ----------------
export const store = {
  get(k, d) {
    if (user && isAppKey(k)) return k in data ? clone(data[k]) : d;
    try { const s = ls(); return (s && JSON.parse(s.getItem(k))) ?? d; } catch { return d; }
  },
  set(k, v) {
    if (user && isAppKey(k)) {
      data[k] = clone(v);
      dirty.add(k);
      persistCache();
      scheduleSync();
      return true;
    }
    try { ls().setItem(k, JSON.stringify(v)); return true; } catch { return false; }
  },
  remove(k) {
    if (user && isAppKey(k)) {
      // Removal syncs as null (server keeps the key with a null value)
      data[k] = null; dirty.add(k); persistCache(); scheduleSync(); return true;
    }
    try { ls().removeItem(k); return true; } catch { return false; }
  },
};

/** Append one history event (puzzle result, opening test, lesson finished…). */
export function logEvent(evt) {
  const e = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, t: new Date().toISOString(), ...evt };
  const log = store.get(LOG_KEY, []);
  log.push(e);
  store.set(LOG_KEY, log.slice(-LOG_CAP));
  return e;
}
export function readLog() { return store.get(LOG_KEY, []); }

/** Every app key of the active profile (or Guest) as a plain object. */
export function snapshot() {
  if (user) return clone(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)));
  return guestSnapshot();
}
function guestSnapshot() {
  const s = ls(); const out = {};
  if (!s) return out;
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!isAppKey(k)) continue;
    try { out[k] = JSON.parse(s.getItem(k)); } catch { /* skip non-JSON */ }
  }
  return out;
}

/** Union two event logs by id, oldest first. */
export function mergeLogs(a = [], b = []) {
  const byId = new Map();
  for (const e of [...(a || []), ...(b || [])]) if (e && e.id && !byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => String(x.t).localeCompare(String(y.t))).slice(-LOG_CAP);
}

/** Merge: `base` values win unless the key is in `prefer` (local edits); logs are unioned. */
export function mergeData(base = {}, overlay = {}, prefer = null) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (k === LOG_KEY) { out[k] = mergeLogs(base[k], v); continue; }
    if (prefer ? prefer.has(k) : !(k in base)) out[k] = v;
  }
  return out;
}

// ---------------- export / import ----------------
export function exportHistory() {
  return {
    format: "boardle-history",
    version: 1,
    exportedAt: new Date().toISOString(),
    user: user ? user.username : "guest",
    data: snapshot(),
  };
}
/** Import a previously exported file. mode "merge" keeps existing keys; "replace" overwrites them. */
export async function importHistory(obj, mode = "merge") {
  if (!obj || obj.format !== "boardle-history" || typeof obj.data !== "object") throw new Error("Not a Boardle history export");
  const incoming = Object.fromEntries(Object.entries(obj.data).filter(([k]) => isAppKey(k)));
  const current = snapshot();
  const merged = mode === "replace"
    ? { ...current, ...incoming, [LOG_KEY]: mergeLogs(current[LOG_KEY], incoming[LOG_KEY]) }
    : mergeData(current, incoming);
  let n = 0;
  for (const [k, v] of Object.entries(merged)) {
    if (JSON.stringify(current[k]) !== JSON.stringify(v)) { store.set(k, v); n++; }
  }
  await flush();
  return n;
}

// ---------------- server mode ----------------
async function api(path, { method = "GET", body, timeout = 6000, keepalive = false } = {}) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
  try {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json", "X-Boardle-Client": "1" } : { "X-Boardle-Client": "1" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined,
      keepalive,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, json };
  } finally { if (timer) clearTimeout(timer); }
}

function cacheKey(name) { return `${USER_CACHE_PREFIX}${name}`; }
function persistCache() {
  if (!user) return;
  try { ls().setItem(cacheKey(user.username), JSON.stringify({ data, rev, dirty: [...dirty] })); } catch { /* quota: server copy still syncs */ }
}
function readCache(name) {
  try { return JSON.parse(ls().getItem(cacheKey(name))) || null; } catch { return null; }
}

function scheduleSync(delay = 800) {
  if (!user) return;
  syncState = "pending"; emit();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { flush().catch(() => {}); }, delay);
}

/** Push dirty keys now. Resolves when the server has them (or fails softly). */
export async function flush() {
  if (!user || !dirty.size) return true;
  if (syncing) { await syncing; if (!dirty.size) return true; }
  syncing = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sending = new Set(dirty);
      let r;
      try { r = await api("/api/history", { method: "PUT", body: { data: snapshotForServer(), baseRev: rev } }); }
      catch { syncState = "offline"; emit(); return false; }
      if (r.ok) {
        rev = r.json.rev;
        for (const k of sending) dirty.delete(k);
        syncState = dirty.size ? "pending" : "synced";
        persistCache(); emit();
        if (dirty.size) continue;
        return true;
      }
      if (r.status === 409 && r.json) {
        // Another device wrote first: take theirs, re-apply our dirty keys, retry.
        data = mergeData(r.json.data || {}, data, dirty);
        rev = r.json.rev;
        persistCache();
        continue;
      }
      if (r.status === 401) { syncState = "error"; emit(); return false; }
      syncState = "error"; emit(); return false;
    }
    return false;
  })();
  try { return await syncing; } finally { syncing = null; }
}
function snapshotForServer() {
  return Object.fromEntries(Object.entries(data).filter(([k]) => isAppKey(k)));
}

async function activate(username) {
  const r = await api("/api/history");
  if (!r.ok) throw new Error((r.json && r.json.error) || `history ${r.status}`);
  const cached = readCache(username);
  let serverData = r.json.data || {};
  rev = r.json.rev || 0;
  dirty = new Set();
  if (cached && Array.isArray(cached.dirty) && cached.dirty.length) {
    // Offline edits from last session that never reached the server
    serverData = mergeData(serverData, cached.data || {}, new Set(cached.dirty));
    cached.dirty.forEach((k) => dirty.add(k));
  }
  user = { username };
  data = serverData;
  syncState = dirty.size ? "pending" : "synced";
  try { ls().setItem("boardle:lastUser", JSON.stringify(username)); } catch { /* ignore */ }
  persistCache();
  emit();
}

/**
 * First sign-in on this device: copy Guest (pre-v3 localStorage) data into the
 * profile. Keys the profile already has are kept; logs are unioned. Guest
 * keys are left in place (nothing is deleted).
 */
export function migrateGuest() {
  if (!user) return 0;
  let already = null;
  try { already = JSON.parse(ls().getItem("boardle:migratedTo")); } catch { already = null; }
  if (already) return 0;
  const guest = guestSnapshot();
  const keys = Object.keys(guest);
  let n = 0;
  if (keys.length) {
    const merged = mergeData(data, guest);
    for (const k of Object.keys(merged)) {
      if (JSON.stringify(merged[k]) !== JSON.stringify(data[k])) { data[k] = merged[k]; dirty.add(k); n++; }
    }
    persistCache();
  }
  try { ls().setItem("boardle:migratedTo", JSON.stringify(user.username)); } catch { /* ignore */ }
  return n;
}

/** Call once before the app reads any state. Never throws; falls back to local mode. */
export async function initStorage() {
  serverInfo = null;
  try {
    const r = await api("/api/me", { timeout: 2500 });
    if (r.ok && r.json && r.json.server) {
      serverInfo = r.json;
      if (r.json.user) {
        await activate(r.json.user.username);
        if (dirty.size) scheduleSync(50);
      }
    }
  } catch { serverInfo = null; }
  if (!user) syncState = "local";
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", () => { if (dirty.size) flush(); });
    document.addEventListener?.("visibilitychange", () => { if (document.visibilityState === "hidden" && dirty.size) flushOnExit(); });
    window.addEventListener("pagehide", () => { if (dirty.size) flushOnExit(); });
  }
  emit();
  return status();
}

function flushOnExit() {
  if (!user || !dirty.size) return;
  try {
    api("/api/history", { method: "PUT", body: { data: snapshotForServer(), baseRev: rev }, keepalive: true }).catch(() => {});
  } catch { /* ignore */ }
}

async function authCall(path, body) {
  let r;
  try { r = await api(path, { method: "POST", body }); }
  catch { throw new Error("Could not reach the Boardle server."); }
  if (!r.ok) throw new Error((r.json && r.json.error) || `Request failed (${r.status})`);
  return r.json;
}

/** Sign in (or register) then load that player's history. Returns {migrated}. */
export async function signIn(username, password, { register = false, invite = "" } = {}) {
  const j = await authCall(register ? "/api/register" : "/api/login", { username, password, invite });
  await activate(j.user.username);
  const migrated = migrateGuest();
  await flush();
  return { user: j.user.username, migrated };
}

export async function signOut() {
  await flush().catch(() => {});
  try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* ignore */ }
  try { if (user) ls().removeItem(cacheKey(user.username)); } catch { /* ignore */ }
  user = null; data = null; rev = 0; dirty = new Set(); syncState = "local";
  emit();
}

// test seam
export const _test = {
  reset() { user = null; data = null; rev = 0; dirty = new Set(); serverInfo = null; syncState = "local"; clearTimeout(syncTimer); },
  activateWith(username, d, r = 0) { user = { username }; data = clone(d) || {}; rev = r; dirty = new Set(); },
  dirty: () => new Set(dirty),
};
