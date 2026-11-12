// Profile / sign-in / history dialog (👤). Works in both storage modes.
import { CONFIG } from "./config.js?v=3.3";
import {
  store, status, onStorageStatus, signIn, signOut, readLog, exportHistory, importHistory,
} from "./storage.js?v=3.3";
import { LESSONS } from "./openings/data.js?v=3.3";
import { progressSummary } from "./openings/trainer.js?v=3.3";
import { orderedVariations, testSummary, RESULTS_KEY, variationById } from "./openings/testmode.js?v=3.3";

const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function describeEvent(e) {
  if (e.kind === "puzzle") {
    const label = CONFIG.modes[e.mode]?.label || e.mode;
    return { what: `${label} #${e.day}${e.archive ? " (archive)" : ""}`, result: e.won ? `✓ ${e.tries}/${e.size}` : `✗ X/${e.size}` };
  }
  if (e.kind === "opening-test") {
    const v = variationById(e.variation);
    return { what: `Test · ${v ? v.title : e.title || e.variation}`, result: e.won ? `✓ ${e.tries}/5` : "✗ X/5" };
  }
  if (e.kind === "opening-learn") return { what: `Learn · ${e.title || e.lesson}`, result: "finished" };
  return { what: e.kind || "event", result: "" };
}

function syncLabel(s) {
  if (s.mode !== "server") return s.serverAvailable ? "Guest — saved in this browser only" : "Local mode (no server) — saved in this browser";
  return { synced: "✓ synced", pending: "saving…", offline: "offline — will sync when back", error: "sync problem — try signing in again" }[s.sync] || s.sync;
}

function puzzleRows() {
  return Object.entries(CONFIG.modes).map(([k, m]) => {
    const st = store.get(`boardle:stats:${k}`, null);
    if (!st) return `<tr><td>${m.label}</td><td colspan="4" class="muted">not played yet</td></tr>`;
    return `<tr><td>${m.label}</td><td>${st.played}</td><td>${st.played ? Math.round((100 * st.wins) / st.played) : 0}%</td><td>${st.streak}</td><td>${st.maxStreak}</td></tr>`;
  }).join("");
}

function openingRows() {
  const results = store.get(RESULTS_KEY, {});
  const cards = store.get("boardle:openings:cards", {});
  return LESSONS.map((l) => {
    const p = progressSummary(cards, [l]);
    const vars = orderedVariations(l.id);
    const solved = vars.filter((v) => results[v.id]?.solved > 0).length;
    const tries = vars.reduce((n, v) => n + (results[v.id]?.attempts.length || 0), 0);
    return `<tr><td>${esc(l.title)}</td><td>${p.seen}/${p.total}</td><td>${p.mastered}</td><td>${solved}/${vars.length}</td><td>${tries}</td></tr>`;
  }).join("");
}

function recentRows(limit = 40) {
  const log = readLog().slice(-limit).reverse();
  if (!log.length) return `<tr><td colspan="3" class="muted">No games recorded yet — finish a puzzle or an opening test.</td></tr>`;
  return log.map((e) => {
    const d = describeEvent(e);
    const when = new Date(e.t);
    const ts = isNaN(when) ? "" : when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<tr><td class="nowrap">${esc(ts)}</td><td>${esc(d.what)}</td><td class="nowrap">${esc(d.result)}</td></tr>`;
  }).join("");
}

export function renderProfile() {
  const s = status();
  const tsum = testSummary(store.get(RESULTS_KEY, {}));
  const auth = s.mode === "server"
    ? `<div class="pf-who"><b>${esc(s.user)}</b> <span class="muted">${esc(syncLabel(s))}</span>
         <button type="button" id="pfSignOut">Sign out</button></div>`
    : (s.serverAvailable
      ? `<form id="pfForm" class="pf-form" autocomplete="on">
          <p class="muted">Sign in so each player keeps their own history (puzzles, streaks, openings, tests, board colors) across devices.
            Progress already in this browser is copied into the first profile you sign into — nothing is deleted.</p>
          <label>Username <input name="username" autocomplete="username" required minlength="3" maxlength="32"></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required minlength="8"></label>
          ${s.inviteRequired ? `<label>Invite code <input name="invite" autocomplete="off"></label>` : ""}
          <div class="pf-actions">
            <button type="submit" class="primary" value="login">Sign in</button>
            ${s.registration ? `<button type="submit" value="register">Create account</button>` : ""}
          </div>
          <p class="pf-error" id="pfError" role="alert"></p>
        </form>`
      : `<p class="muted">No Boardle server answered (static hosting), so profiles are off and history stays in this browser.
           Run <code>python3 serve.py</code> (or the AWS deployment) to enable sign-in. Export/Import below moves history between browsers.</p>`);
  return `
    <div class="pf-status">${s.mode === "server" ? "" : `<span class="pf-guest">Guest</span> <span class="muted">${esc(syncLabel(s))}</span>`}</div>
    ${auth}
    <h4>Puzzles</h4>
    <table class="pf-table"><thead><tr><th></th><th>Played</th><th>Win</th><th>Streak</th><th>Max</th></tr></thead><tbody>${puzzleRows()}</tbody></table>
    <h4>Openings <span class="muted">· tests ${tsum.solved}/${tsum.total} variations solved</span></h4>
    <table class="pf-table"><thead><tr><th></th><th>Seen</th><th>Comfy</th><th>Tests</th><th>Tries</th></tr></thead><tbody>${openingRows()}</tbody></table>
    <h4>Recent activity</h4>
    <div class="pf-scroll"><table class="pf-table"><tbody>${recentRows()}</tbody></table></div>
    <div class="pf-actions">
      <button type="button" id="pfExport">Export history (JSON)</button>
      <label class="pf-import">Import JSON<input type="file" id="pfImport" accept="application/json,.json" hidden></label>
    </div>`;
}

export function refreshProfileButton($) {
  const b = $("#profileBtn");
  if (!b) return;
  const s = status();
  b.classList.toggle("signed-in", s.mode === "server");
  b.title = s.mode === "server" ? `Signed in as ${s.user} — history` : "Profile & history (Guest)";
  b.textContent = s.mode === "server" ? (s.user[0] || "?").toUpperCase() : "👤";
}

export function wireProfileUI({ $, toast }) {
  const dlg = $("#profile");
  const body = $("#profileBody");
  const btn = $("#profileBtn");
  if (!dlg || !body || !btn) return;
  const draw = () => {
    body.innerHTML = renderProfile();
    const form = $("#pfForm");
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const register = (e.submitter && e.submitter.value === "register");
        const fd = new FormData(form);
        const err = $("#pfError");
        err.textContent = "";
        form.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          const r = await signIn(String(fd.get("username") || ""), String(fd.get("password") || ""),
            { register, invite: String(fd.get("invite") || "") });
          toast(r.migrated ? `Signed in as ${r.user} — copied ${r.migrated} saved items into your profile` : `Signed in as ${r.user}`);
          setTimeout(() => location.reload(), 600); // reload so every tab reads this player's data
        } catch (ex) {
          err.textContent = ex.message || String(ex);
          form.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      };
    }
    const so = $("#pfSignOut");
    if (so) so.onclick = async () => { await signOut(); toast("Signed out"); setTimeout(() => location.reload(), 400); };
    $("#pfExport").onclick = () => {
      const blob = new Blob([JSON.stringify(exportHistory(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      const who = status().user || "guest";
      a.href = URL.createObjectURL(blob);
      a.download = `boardle-history-${who}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $("#pfImport").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const n = await importHistory(JSON.parse(await f.text()), "merge");
        toast(`Imported ${n} items`);
        setTimeout(() => location.reload(), 600);
      } catch (ex) { toast(ex.message || "Import failed"); }
    };
  };
  btn.onclick = () => { draw(); dlg.showModal(); };
  onStorageStatus(() => { refreshProfileButton($); if (dlg.open && !$("#pfForm")) draw(); });
  refreshProfileButton($);
}
