// main.js - entry point: canvas setup, render loop, tosu websocket wiring and
// settings handling. Modules: shared.js, socket.js, beatmap.js, osk.js,
// skin.js, renderer.js.
import { settings, state, renderKey, renderKeyScratch, buildRenderKey, renderKeyDiffers, renderTime, setTime, imageState, listingCache, isSafeAssetName, parseSkinIni, clamp, num, PREVIEW_STATES } from "./shared.js";
import { SocketManager } from "./socket.js";
import { ensureBeatmap, parseOsu, buildManiaNative, buildManiaFromStandard, buildBeatmapFor, makeScroll, getScroll, fetchBeatmapText } from "./beatmap.js";
import { releaseOsk, parseOsk, oskCandidates, findOskImage } from "./osk.js";
import { getManiaLayout, ensureSkin, maniaSkin, maniaImageNames, resolveManiaSource, ensureDefaultSkin, getColumnInfo, defaultManiaColumnIndex } from "./skin.js";
import { hexToRgba, stageBounds, currentViewport, renderMania, noteDrawHeight, notePassedLine } from "./renderer.js";

const canvas = document.getElementById("preview");
const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
const statusEl = document.getElementById("status");
let lastWidth = 0;
let lastHeight = 0;
let wasVisible = false;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(window.innerWidth * dpr));
  const height = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (width !== lastWidth || height !== lastHeight) {
    canvas.width = width;
    canvas.height = height;
    lastWidth = width;
    lastHeight = height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }
}

let lastFrameAt = 0;
let lastPaddedView = null;
let renderKeyValid = false;

function allowedState() {
  if (PREVIEW_STATES.has(state.gameState)) return !!settings.showInSongSelect;
  if (state.gameState === "play") return !settings.autoHideInGameplay;
  return false;
}

function statusText() {
  if (!state.gameState) return "waiting for tosu...";
  if (!allowedState()) return "";
  if (!state.checksum && !(state.beatmapFolder && state.beatmapFileName)) return "no beatmap selected";
  if (!state.beatmap) {
    if (state.loadError) return `beatmap fetch failed: ${state.loadError} (retrying)`;
    return "loading beatmap...";
  }
  if (state.client === "lazer" && settings.useSkin && state.oskKey && !state.osk) {
    const wanted = String(settings.lazerSkinFile || "").trim() || (state.skinName ? `${state.skinName}.osk` : "player.osk");
    return `lazer player skin not loaded: copy the exported skin into this counter folder as "${wanted}" (or set Lazer Skin File); using default skin`;
  }
  return state.beatmap.notice || "";
}

function updateSettings(message) {
  if (!message || typeof message !== "object") return;
  for (const [key, value] of Object.entries(message)) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    let next = value;
    if (typeof settings[key] === "number") next = Number(value);
    else if (typeof settings[key] === "boolean") next = typeof value === "string" ? value === "true" : Boolean(value);
    if (settings[key] === next || Number.isNaN(next)) continue;
    settings[key] = next;
    if (key === "useSkin") {
      imageState.clear();
      listingCache.clear();
      state.loadedSkinFolder = null;
      releaseOsk();
      state.oskKey = "";
    } else if (key === "lazerSkinFile") {
      imageState.clear();
      releaseOsk();
      state.oskKey = "";
    }
  }
}

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const fpsLimit = clamp(num(settings.fpsLimit, 0), 0, 1000);
  if (fpsLimit > 0 && nowMs - lastFrameAt < 1000 / fpsLimit - 1) return;
  lastFrameAt = nowMs;

  resize();
  const width = canvas.width;
  const height = canvas.height;
  const text = statusText();
  if (statusEl.textContent !== text) statusEl.textContent = text;

  const hasChart = state.beatmap && state.beatmap.notes && state.beatmap.notes.length > 0;
  if (!allowedState() || !hasChart) {
    if (wasVisible) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      lastPaddedView = null;
      renderKeyValid = false;
      wasVisible = false;
    }
    return;
  }

  const t = renderTime();
  const keys = state.beatmap.keys;
  buildRenderKey(renderKeyScratch, t, width, height);
  if (renderKeyValid && !renderKeyDiffers(renderKey, renderKeyScratch)) return;
  Object.assign(renderKey, renderKeyScratch);
  renderKeyValid = true;
  wasVisible = true;

  const bgOpacity = clamp(num(settings.backgroundOpacity, 0), 0, 1);
  const view = stageBounds(getManiaLayout(keys, renderKey.skin));
  const vp = currentViewport(width, height, view);
  const clear = vp.clear;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(clear.x, clear.y, clear.w, clear.h);
  if (
    lastPaddedView &&
    (lastPaddedView.x !== clear.x || lastPaddedView.y !== clear.y || lastPaddedView.w !== clear.w || lastPaddedView.h !== clear.h)
  ) {
    ctx.clearRect(lastPaddedView.x, lastPaddedView.y, lastPaddedView.w, lastPaddedView.h);
  }
  lastPaddedView = clear;
  ctx.setTransform(vp.scale, 0, 0, vp.scale, vp.offsetX, vp.offsetY);
  if (bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(settings.backgroundColor, bgOpacity);
    ctx.fillRect(view.x, view.y, view.w, view.h);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  ctx.clip();
  renderMania(ctx, state.beatmap, t, vp.scale, renderKey.skin);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

const sockets = new SocketManager(location.host);

const v2Filters = [
  "client",
  { field: "state", keys: ["name"] },
  {
    field: "settings",
    keys: [
      { field: "mode", keys: ["name"] },
      { field: "mania", keys: ["scrollSpeed"] },
      { field: "skin", keys: ["name"] }
    ]
  },
  {
    field: "beatmap",
    keys: [
      { field: "mode", keys: ["name"] },
      { field: "stats", keys: [{ field: "cs", keys: ["converted"] }] },
      { field: "time", keys: ["live"] },
      "checksum",
      "id"
    ]
  },
  { field: "folders", keys: ["skin", "beatmap"] },
  { field: "files", keys: ["beatmap"] }
];

function onV2(data) {
  if (!data) return;
  if (typeof data.client === "string" && data.client && data.client !== state.client) {
    state.client = data.client;
    imageState.clear();
    listingCache.clear();
    releaseOsk();
    state.oskKey = "";
    state.defaultSkinKey = "";
  }
  const stateName = data.state && data.state.name;
  if (stateName) state.gameState = stateName;
  const gameMode = data.settings && data.settings.mode && data.settings.mode.name;
  if (gameMode) state.gameMode = gameMode;
  const skinName = data.settings && data.settings.skin && data.settings.skin.name;
  if (typeof skinName === "string" && skinName !== state.skinName) state.skinName = skinName;
  const scrollSpeed = Number(data.settings && data.settings.mania && data.settings.mania.scrollSpeed);
  if (Number.isFinite(scrollSpeed)) state.maniaScrollSpeed = scrollSpeed;
  const mapMode = data.beatmap && data.beatmap.mode && data.beatmap.mode.name;
  if (mapMode) state.mapMode = mapMode;
  const csConverted = Number(data.beatmap && data.beatmap.stats && data.beatmap.stats.cs && data.beatmap.stats.cs.converted);
  if (Number.isFinite(csConverted)) state.csConverted = csConverted;
  const skinFolder = data.folders && data.folders.skin;
  if (typeof skinFolder === "string" && skinFolder !== state.skinFolder) state.skinFolder = skinFolder;
  if (data.folders && typeof data.folders.beatmap === "string") state.beatmapFolder = data.folders.beatmap;
  if (data.files && typeof data.files.beatmap === "string") state.beatmapFileName = data.files.beatmap;
  const checksum = data.beatmap ? String(data.beatmap.checksum || data.beatmap.id || "") : "";
  if (checksum && checksum !== state.checksum) {
    state.checksum = checksum;
    state.loadError = "";
    state.retryKey = "";
    state.retryCount = 0;
  }
  const live = Number(data.beatmap && data.beatmap.time && data.beatmap.time.live);
  if (Number.isFinite(live)) setTime(live);
  ensureSkin();
  ensureBeatmap();
}

function onCommand(data) {
  if (!data) return;
  if (data.command === "getSettings" || data.command === "updateSettings") updateSettings(data.message);
}

function requestSettings(attempt) {
  attempt = attempt || 0;
  const sent = sockets.send("/websocket/commands", `getSettings:${encodeURI(window.COUNTER_PATH || "")}`);
  if (!sent && attempt < 100) setTimeout(() => requestSettings(attempt + 1), 100);
}

sockets.open("/websocket/v2", onV2, v2Filters);
sockets.open("/websocket/commands", onCommand, null, { onOpen: () => requestSettings() });
requestSettings();

if (/[?&]debug(?:[=&]|$)/.test(location.search || "")) window.__beatmapPreview = {
  state,
  settings,
  parseOsu,
  parseSkinIni,
  buildManiaNative,
  buildManiaFromStandard,
  buildBeatmapFor,
  makeScroll,
  getScroll,
  renderMania,
  renderTime,
  setTime,
  updateSettings,
  ensureBeatmap,
  fetchBeatmapText,
  maniaSkin,
  maniaImageNames,
  resolveManiaSource,
  ensureDefaultSkin,
  parseOsk,
  oskCandidates,
  findOskImage,
  defaultManiaColumnIndex,
  noteDrawHeight,
  notePassedLine,
  stageBounds,
  currentViewport,
  isSafeAssetName,
  getColumnInfo,
  onV2,
  frame,
  allowedState,
  statusText,
  canvas,
  sockets
};

requestAnimationFrame(frame);
