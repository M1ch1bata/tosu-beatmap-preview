// shared.js - pure helpers, constants, global state and timing/render key.
// Everything here is side-effect free at module load except the initial object
// literals, so it can be imported by every other module without cycles.

// scroll/algorithm helpers
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
export const findLastLE = (arr, x, key) => {
  let lo = 0;
  let hi = arr.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) {
      res = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res;
};
export const findFirstGE = (arr, x, key) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export const MODE_NAMES = ["osu", "taiko", "fruits", "mania"];
export const MANIA_FALLBACK = [
  "#ffffff",
  "#ffd966",
  "#8cd9ff",
  "#ff9d9d",
  "#c9a7ff",
  "#9dffbd",
  "#ffe29d",
  "#9db4ff"
];
// bundled default skin (蓝白砖皮) file names, used as the "listing" for
// ./default-skin/<client>/ so no directory request is needed
export const DEFAULT_SKIN_FILES = new Set([
  "mania-key1.png",
  "mania-key1D.png",
  "mania-key2.png",
  "mania-key2D.png",
  "mania-keyS.png",
  "mania-keySD.png",
  "mania-note1.png",
  "mania-note1H.png",
  "mania-note1L.png",
  "mania-note1T.png",
  "mania-note2.png",
  "mania-note2H.png",
  "mania-note2L.png",
  "mania-note2T.png",
  "mania-noteS.png",
  "mania-noteSH.png",
  "mania-noteSL.png",
  "mania-noteST.png",
  "mania-stage-hint.png"
]);

export const STAGE_SIZE = 480;
export const DEFAULT_HIT_POSITION = 402;
export const HIT_POSITION_MIN = 240;
export const SCROLL_TIME_REFERENCE_MS = 11485;
export const NOTE_LOOKBACK_MS = 30000;
export const TIME_REWIND_MS = 500;
export const TIME_EXTRAPOLATE_MS = 300;
export const OSK_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const SPAWN_MARGIN = 1.3;
export const NOTE_VIEW_MARGIN = 80;
export const NOTE_BODY_MAX_TILES = 64;
export const DEFAULT_NOTE_ASPECT = 150 / 256;
export const OPTIONAL_SOCKET_RETRY_LIMIT = 5;
export const OSK_FALLBACK_FILES = ["player.osk", "skin.osk"];
// states where a beatmap is selected and the preview can follow it
// (matchSetup / selectMulti are the osu!stable multiplayer room / room song select)
export const PREVIEW_STATES = new Set(["selectPlay", "selectEdit", "selectMulti", "matchSetup"]);
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 30000;

export const settings = {
  backgroundColor: "#000000",
  backgroundOpacity: 0,
  renderScale: 100,
  showInSongSelect: true,
  autoHideInGameplay: true,
  useSkin: true,
  lazerSkinFile: "",
  maniaScrollSpeedOverride: 0,
  playfieldOpacity: 1,
  fpsLimit: 0
};

export const state = {
  gameState: "",
  client: "stable",
  gameMode: "osu",
  mapMode: "osu",
  checksum: "",
  skinFolder: "",
  skinName: "",
  loadedSkinFolder: null,
  skinRev: 0,
  skinFilePresent: false,
  defaultSkin: null,
  defaultSkinPresent: false,
  defaultSkinKey: "",
  osk: null,
  oskFile: "",
  oskKey: "",
  oskToken: 0,
  csConverted: 4,
  maniaScrollSpeed: 0,
  beatmap: null,
  skin: null,
  beatmapFolder: "",
  beatmapFileName: "",
  loadedKey: "",
  pendingKey: "",
  retryKey: "",
  retryAt: 0,
  retryCount: 0,
  loadError: "",
  loadToken: 0,
  time: 0,
  timeLocal: 0,
  timeSpeed: 1
};

export const imageState = new Map();
export const listingCache = new Map();

export const renderCache = {
  loadedImages: 0,
  layout: null,
  layoutKeys: -1,
  layoutRev: "",
  names: null,
  namesKeys: -1,
  namesRev: "",
  info: null,
  infoKeys: -1,
  infoRev: "",
  infoLoaded: -1,
  scroll: null,
  scrollMap: null,
  scrollRange: 0,
  cursorMap: null,
  cursorTime: -Infinity,
  cursor: 0,
  staticLayer: null,
  staticLayout: null,
  staticLoaded: -1,
  staticScale: -1
};

// Consolidated render inputs. Compared field by field instead of building a
// per-frame string; the skin revision and loaded-image count live here too so
// every render cache is invalidated from the same source.
export const renderKey = {
  time: 0,
  keys: 0,
  skin: "",
  loadedImages: -1,
  scrollSpeed: 0,
  scrollOverride: 0,
  playfieldOpacity: 1,
  renderScale: 100,
  backgroundOpacity: 0,
  backgroundColor: "#000000",
  width: 0,
  height: 0
};
export const renderKeyScratch = { ...renderKey };

export function buildRenderKey(out, t, width, height) {
  out.time = Math.round(t * 1000);
  out.keys = state.beatmap ? state.beatmap.keys : 0;
  out.skin = skinContentRev();
  out.loadedImages = renderCache.loadedImages;
  out.scrollSpeed = state.maniaScrollSpeed;
  out.scrollOverride = settings.maniaScrollSpeedOverride;
  out.playfieldOpacity = settings.playfieldOpacity;
  out.renderScale = settings.renderScale;
  out.backgroundOpacity = settings.backgroundOpacity;
  out.backgroundColor = settings.backgroundColor;
  out.width = width;
  out.height = height;
  return out;
}

export function renderKeyDiffers(a, b) {
  return (
    a.time !== b.time ||
    a.keys !== b.keys ||
    a.skin !== b.skin ||
    a.loadedImages !== b.loadedImages ||
    a.scrollSpeed !== b.scrollSpeed ||
    a.scrollOverride !== b.scrollOverride ||
    a.playfieldOpacity !== b.playfieldOpacity ||
    a.renderScale !== b.renderScale ||
    a.backgroundOpacity !== b.backgroundOpacity ||
    a.backgroundColor !== b.backgroundColor ||
    a.width !== b.width ||
    a.height !== b.height
  );
}

export function splitSkinPath(name) {
  const path = String(name).replace(/\\/g, "/");
  const idx = path.lastIndexOf("/");
  return idx >= 0
    ? { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) }
    : { dir: "", base: path };
}

export function isSafeAssetName(name) {
  const path = String(name || "").replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function encodeSkinPath(path) {
  return String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function tryImageUrl(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function parseListingNames(html) {
  const names = new Set();
  const re = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ""))) !== null) {
    const href = match[1];
    if (href.endsWith("/")) continue;
    const raw = href.split("/").pop();
    if (!raw) continue;
    try {
      names.add(decodeURIComponent(raw));
    } catch {
      names.add(raw);
    }
  }
  return names;
}

export function parseSkinIni(text) {
  const sections = [];
  let currentSection = { name: "", props: {} };
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line[0] === "[" && line.endsWith("]")) {
      currentSection = { name: line.slice(1, -1).trim().toLowerCase(), props: {} };
      sections.push(currentSection);
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    currentSection.props[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const general = (sections.find((s) => s.name === "general") || { props: {} }).props;
  const mania = {};
  for (const s of sections) {
    if (s.name !== "mania") continue;
    const keys = parseInt(s.props.keys || "0") || 0;
    if (keys) mania[keys] = s.props;
  }
  return { general, mania };
}

export function skinContentRev() {
  return `${state.loadedSkinFolder || ""}|${state.skinRev}|${settings.useSkin ? "1" : "0"}|${state.client}|${state.oskFile}`;
}

export function applySkinConfig(config, filePresent) {
  state.skin = config;
  state.skinFilePresent = !!filePresent;
  state.skinRev += 1;
}

export function setTime(t) {
  if (!Number.isFinite(t)) return;
  const now = performance.now();
  const dt = now - state.timeLocal;
  const delta = t - state.time;
  if (!state.timeLocal || dt <= 0 || dt >= 1000 || delta < -TIME_REWIND_MS) {
    // first sample, long gap, or a real seek/restart: snap to the reported time
    state.time = t;
    state.timeLocal = now;
    state.timeSpeed = 1;
  } else if (delta > 0) {
    const inst = delta / dt;
    if (inst >= 0 && inst < 3) {
      state.timeSpeed = state.timeSpeed > 0.01 ? state.timeSpeed * 0.75 + inst * 0.25 : inst;
    }
    state.time = t;
    state.timeLocal = now;
  } else {
    // Source stalled (pause) or stepped back slightly: keep the currently
    // rendered position instead of re-anchoring, otherwise every 100 ms
    // message pulls the preview back and the notes visibly vibrate.
    state.time = state.time + clamp(now - state.timeLocal, 0, TIME_EXTRAPOLATE_MS) * clamp(state.timeSpeed, 0, 3);
    state.timeLocal = now;
    state.timeSpeed = 0;
  }
}

export function renderTime() {
  const now = performance.now();
  const dt = clamp(now - state.timeLocal, 0, TIME_EXTRAPOLATE_MS);
  return state.time + dt * clamp(state.timeSpeed, 0, 3);
}
