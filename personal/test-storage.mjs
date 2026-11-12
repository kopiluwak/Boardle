// node test-storage.mjs — storage abstraction: guest mode, signed-in scoping, migration, merge, export/import
import assert from "assert";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
  clear: () => mem.clear(),
};
let puts = [];
globalThis.fetch = async (path, opts = {}) => {
  if (path === "/api/history" && opts.method === "PUT") {
    const body = JSON.parse(opts.body);
    puts.push(body);
    return { ok: true, status: 200, json: async () => ({ rev: body.baseRev + 1 }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const S = await import("./storage.js?v=3.3");
const { store, logEvent, readLog, mergeData, mergeLogs, exportHistory, importHistory, migrateGuest, _test } = S;

// guest mode = plain localStorage keys (pre-v3 behaviour)
store.set("boardle:stats:classic", { played: 2, wins: 1 });
assert.strictEqual(mem.get("boardle:stats:classic"), JSON.stringify({ played: 2, wins: 1 }));
assert.deepStrictEqual(store.get("boardle:stats:classic"), { played: 2, wins: 1 });
assert.strictEqual(store.get("boardle:missing", 7), 7);
logEvent({ kind: "puzzle", mode: "classic", day: 3, won: true, tries: 2, size: 5 });
assert.strictEqual(readLog().length, 1);
store.set("boardle:seenHelp", "1");
assert.ok(!("boardle:seenHelp" in exportHistory().data), "device keys not exported");
assert.ok("boardle:stats:classic" in exportHistory().data);

// signed in: keys scoped in memory, guest keys untouched, then migrated once
_test.activateWith("alice", { "boardle:stats:mini": { played: 9 }, "boardle:stats:classic": { played: 50, wins: 40 } }, 4);
assert.strictEqual(store.get("boardle:stats:classic").played, 50, "profile wins over guest");
assert.strictEqual(store.get("boardle:seenHelp"), "1", "device key still read from localStorage");
const n = migrateGuest();
assert.ok(n >= 1);
assert.strictEqual(store.get("boardle:stats:classic").played, 50, "existing profile keys kept on migration");
assert.strictEqual(readLog().length, 1, "guest log merged");
assert.strictEqual(migrateGuest(), 0, "migration happens once per device");
assert.strictEqual(JSON.parse(mem.get("boardle:stats:classic")).played, 2, "guest data not deleted");
store.set("boardle:openings:tests", { "it-main": { solved: 1 } });
assert.ok(_test.dirty().has("boardle:openings:tests"));
assert.strictEqual(mem.get("boardle:openings:tests"), undefined, "signed-in writes don't touch guest keys");
assert.ok(mem.get("boardle:u:alice"), "offline cache kept");
await S.flush();
assert.strictEqual(puts.length, 1);
assert.strictEqual(puts[0].baseRev, 4);
assert.ok(puts[0].data["boardle:openings:tests"]);
assert.strictEqual(_test.dirty().size, 0);

// merge helpers
const a = [{ id: "1", t: "2026-01-01" }, { id: "2", t: "2026-01-03" }];
const b = [{ id: "2", t: "2026-01-03" }, { id: "3", t: "2026-01-02" }];
assert.deepStrictEqual(mergeLogs(a, b).map((e) => e.id), ["1", "3", "2"]);
assert.deepStrictEqual(mergeData({ x: 1, y: 1 }, { y: 2, z: 3 }), { x: 1, y: 1, z: 3 });
assert.deepStrictEqual(mergeData({ x: 1, y: 1 }, { y: 2, z: 3 }, new Set(["y"])), { x: 1, y: 2 });

// import merges; rejects junk
await assert.rejects(() => importHistory({ hello: 1 }));
const changed = await importHistory({ format: "boardle-history", version: 1, data: { "boardle:stats:maxi": { played: 1 }, "evil": 1 } });
assert.strictEqual(changed, 1);
assert.strictEqual(store.get("evil", null), null);
assert.deepStrictEqual(store.get("boardle:stats:maxi"), { played: 1 });
_test.reset();
assert.strictEqual(store.get("boardle:stats:maxi", null), null, "signed out → guest view");
console.log("storage tests passed");
