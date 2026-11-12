// Board appearance settings — CSS custom properties + per-player storage (storage.js).
import { store } from "./storage.js?v=3.3";
// Does not touch puzzle or openings keys.

const COLORS_KEY = "boardle:settings:boardColors";

export const PRESETS = [
  {
    id: "carolina",
    label: "Carolina blue / white",
    light: "#FFFFFF",
    dark: "#4B9CD3",
  },
  {
    id: "classic",
    label: "Classic green / beige",
    light: "#eeeed2",
    dark: "#769656",
  },
  {
    id: "walnut",
    label: "Walnut / cream",
    light: "#f0d9b5",
    dark: "#b58863",
  },
  {
    id: "slate",
    label: "Slate / ice",
    light: "#e8eef4",
    dark: "#5a6f8a",
  },
];

export const DEFAULT_COLORS = {
  light: PRESETS[0].light,
  dark: PRESETS[0].dark,
};

function normalizeHex(v, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return `#${s.slice(1).toUpperCase()}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3];
    return `#${(r + r + g + g + b + b).toUpperCase()}`;
  }
  return fallback;
}

export function loadBoardColors() {
  try {
    const parsed = store.get(COLORS_KEY, null);
    if (!parsed) return { ...DEFAULT_COLORS };
    return {
      light: normalizeHex(parsed?.light, DEFAULT_COLORS.light),
      dark: normalizeHex(parsed?.dark, DEFAULT_COLORS.dark),
    };
  } catch {
    return { ...DEFAULT_COLORS };
  }
}

export function saveBoardColors(colors) {
  const next = {
    light: normalizeHex(colors.light, DEFAULT_COLORS.light),
    dark: normalizeHex(colors.dark, DEFAULT_COLORS.dark),
  };
  return store.set(COLORS_KEY, next);
}

/** Tune overlay contrast for last-move / selection / legal-move markers. */
function overlayVars(light, dark) {
  // Warm amber overlays read on both Carolina blue and beige/green.
  return {
    "--hl-last": "rgba(255, 200, 0, 0.42)",
    "--hl-sel": "rgba(255, 170, 0, 0.50)",
    "--move-dot": "rgba(20, 35, 55, 0.38)",
    "--move-ring": "rgba(20, 35, 55, 0.42)",
    "--coord-on-light": dark,
    "--coord-on-dark": light,
  };
}

export function applyBoardColors(colors) {
  const light = normalizeHex(colors.light, DEFAULT_COLORS.light);
  const dark = normalizeHex(colors.dark, DEFAULT_COLORS.dark);
  const root = document.documentElement;
  root.style.setProperty("--light", light);
  root.style.setProperty("--dark", dark);
  const overlays = overlayVars(light, dark);
  for (const [k, v] of Object.entries(overlays)) root.style.setProperty(k, v);
  return { light, dark };
}

export function resetBoardColors() {
  store.remove(COLORS_KEY);
  return applyBoardColors(DEFAULT_COLORS);
}

export function wireSettingsUI({ $, toast }) {
  const dlg = $("#settings");
  const lightIn = $("#setLight");
  const darkIn = $("#setDark");
  const presetsEl = $("#setPresets");
  if (!dlg || !lightIn || !darkIn) return;

  function syncInputs(colors) {
    lightIn.value = colors.light.toLowerCase();
    darkIn.value = colors.dark.toLowerCase();
  }

  function liveApplyFromInputs() {
    const colors = applyBoardColors({ light: lightIn.value, dark: darkIn.value });
    saveBoardColors(colors);
    syncInputs(colors);
  }

  // Initial apply from storage
  const initial = applyBoardColors(loadBoardColors());
  syncInputs(initial);

  if (presetsEl) {
    presetsEl.innerHTML = PRESETS.map((p) =>
      `<button type="button" class="set-preset" data-preset="${p.id}" title="${p.label}">
        <span class="swatch" style="background:linear-gradient(90deg,${p.light} 50%,${p.dark} 50%)"></span>
        <span>${p.label}</span>
      </button>`
    ).join("");
    presetsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset]");
      if (!btn) return;
      const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
      if (!preset) return;
      const colors = applyBoardColors({ light: preset.light, dark: preset.dark });
      saveBoardColors(colors);
      syncInputs(colors);
    });
  }

  lightIn.addEventListener("input", liveApplyFromInputs);
  darkIn.addEventListener("input", liveApplyFromInputs);

  const resetBtn = $("#setReset");
  if (resetBtn) {
    resetBtn.onclick = () => {
      const colors = resetBoardColors();
      syncInputs(colors);
      if (toast) toast("Board colors reset");
    };
  }

  const openBtn = $("#settingsBtn");
  if (openBtn) openBtn.onclick = () => {
    syncInputs(loadBoardColors());
    dlg.showModal();
  };
}
