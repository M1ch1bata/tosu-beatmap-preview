// beatmap.js - .osu parsing, mania note building, scroll mapping and the
// beatmap fetch/retry loop.
import { clamp, num, findLastLE, MODE_NAMES, state, renderCache, parseListingNames, RETRY_BASE_MS, RETRY_MAX_MS } from "./shared.js";

export function parseTiming(lines) {
  const raw = [];
  for (const line of lines) {
    const p = line.split(",");
    if (p.length < 2) continue;
    const time = parseFloat(p[0]);
    const beatLength = parseFloat(p[1]);
    if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue;
    raw.push({
      time,
      beatLength,
      meter: num(p[2], 4),
      uninherited: p[6] === undefined ? 1 : parseInt(p[6]) ? 1 : 0
    });
  }
  raw.sort((a, b) => a.time - b.time);
  const cps = [];
  let lastTime = null;
  let curBeat = 500;
  let curSv = 1;
  let outBeat = 500;
  let outSv = 1;
  for (const p of raw) {
    if (p.uninherited && p.beatLength > 0) curBeat = p.beatLength;
    if (p.uninherited) curSv = 1;
    else if (p.beatLength < 0) curSv = clamp(-100 / p.beatLength, 0.1, 10);
    if (lastTime === null || p.time !== lastTime) {
      if (lastTime !== null) cps.push({ time: lastTime, beatLength: outBeat, sv: outSv });
      lastTime = p.time;
      outBeat = curBeat;
      outSv = curSv;
    } else {
      outBeat = curBeat;
      outSv = curSv;
    }
  }
  if (lastTime !== null) cps.push({ time: lastTime, beatLength: outBeat, sv: outSv });
  return { raw, cps };
}

export function computeMostCommonBeatLength(raw, lastTime) {
  const reds = raw.filter((p) => p.uninherited && p.beatLength > 0);
  if (!reds.length) return 500;
  const totals = new Map();
  for (let i = 0; i < reds.length; i++) {
    const end = i + 1 < reds.length ? reds[i + 1].time : Math.max(lastTime, reds[i].time + 1);
    const duration = Math.max(0, end - reds[i].time);
    totals.set(reds[i].beatLength, (totals.get(reds[i].beatLength) || 0) + duration);
  }
  let best = reds[0].beatLength;
  let bestDuration = -1;
  totals.forEach((duration, beatLength) => {
    if (duration > bestDuration) {
      bestDuration = duration;
      best = beatLength;
    }
  });
  return best;
}

export function parseHitObject(line) {
  const p = line.split(",");
  if (p.length < 4) return null;
  const x = parseFloat(p[0]);
  const y = parseFloat(p[1]);
  const time = parseFloat(p[2]);
  const type = parseInt(p[3]) || 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time)) return null;
  const o = {
    x,
    y,
    time,
    type,
    slider: (type & 2) !== 0,
    spinner: (type & 8) !== 0,
    hold: (type & 128) !== 0
  };
  if (o.slider && p.length >= 8) {
    o.repeats = Math.max(1, parseInt(p[6]) || 1);
    o.pixelLength = num(p[7], 0);
  } else if (o.spinner && p.length >= 6) {
    o.endTime = num(p[5], time);
  } else if (o.hold && p.length >= 6) {
    o.endTime = num(String(p[5]).split(":")[0], time);
  }
  return o;
}

export function parseOsu(text) {
  const sections = {};
  let current = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line[0] === "[" && line.endsWith("]")) {
      current = line.slice(1, -1);
      continue;
    }
    (sections[current] = sections[current] || []).push(line);
  }
  const toKV = (lines) => {
    const o = {};
    for (const line of lines || []) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return o;
  };
  const general = toKV(sections.General);
  const difficulty = toKV(sections.Difficulty);
  const timing = parseTiming(sections.TimingPoints || []);
  const objects = [];
  for (const line of sections.HitObjects || []) {
    const o = parseHitObject(line);
    if (o) objects.push(o);
  }
  objects.sort((a, b) => a.time - b.time);
  const lastTime = objects.length ? objects[objects.length - 1].time : 0;
  timing.mostCommon = computeMostCommonBeatLength(timing.raw, lastTime);
  return { general, difficulty, timing, objects };
}

export function maniaCps(timing, svScale) {
  const mostCommon = timing.mostCommon || 500;
  return timing.cps.map((p) => ({
    time: p.time,
    m: ((svScale ? p.sv : 1) * mostCommon) / (p.beatLength || mostCommon)
  }));
}

export function buildManiaNative(parsed, keys) {
  const notes = [];
  for (const o of parsed.objects) {
    if (o.spinner) continue;
    const column = clamp(Math.floor((o.x * keys) / 512), 0, keys - 1);
    const endTime = o.hold ? Math.max(o.time, o.endTime === undefined ? o.time : o.endTime) : o.time;
    notes.push({ column, time: o.time, endTime, hold: !!o.hold });
  }
  notes.sort((a, b) => a.time - b.time);
  return {
    mode: "mania",
    keys,
    notes,
    cps: maniaCps(parsed.timing, true),
    notice: ""
  };
}

export function buildManiaFromStandard(parsed, keys) {
  const sliderMultiplier = num(parsed.difficulty.SliderMultiplier, 1.4);
  const cps = parsed.timing.cps;
  const beatAt = (t) => {
    const i = findLastLE(cps, t, (p) => p.time);
    return i < 0 ? (cps[0] ? cps[0].beatLength : 500) : cps[i].beatLength;
  };
  const svAt = (t) => {
    const i = findLastLE(cps, t, (p) => p.time);
    return i < 0 ? (cps[0] ? cps[0].sv : 1) : cps[i].sv;
  };
  const notes = [];
  for (const o of parsed.objects) {
    if (o.spinner) continue;
    const column = clamp(Math.floor((o.x * keys) / 512), 0, keys - 1);
    let endTime = o.time;
    if (o.slider) {
      const velocity = (100 * sliderMultiplier * svAt(o.time)) / (beatAt(o.time) || 500);
      const span = velocity > 0 ? (o.pixelLength || 0) / velocity : 0;
      endTime = o.time + span * (o.repeats || 1);
    }
    notes.push({ column, time: o.time, endTime, hold: !!o.slider });
  }
  notes.sort((a, b) => a.time - b.time);
  return {
    mode: "mania",
    keys,
    notes,
    cps: maniaCps(parsed.timing, false),
    notice: "converted from osu!standard (approximate)"
  };
}

export function modeName(index) {
  return MODE_NAMES[index] || "osu";
}

export function buildBeatmapFor(parsed) {
  const mapMode = parsed.general.Mode !== undefined ? modeName(parseInt(parsed.general.Mode)) : state.mapMode;
  const keys = clamp(Math.round(state.csConverted || num(parsed.difficulty.CircleSize, 4)), 1, 18);
  if (mapMode === "mania") return buildManiaNative(parsed, keys);
  if (mapMode === "osu" && state.gameMode === "mania") return buildManiaFromStandard(parsed, keys);
  return {
    mode: "mania",
    keys,
    notes: [],
    cps: [],
    notice: `${mapMode} charts are not supported (mania only)`
  };
}

export function makeScroll(cps, timeRange) {
  const pts = cps && cps.length ? cps : null;
  let cum = null;
  if (pts) {
    cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      cum[i] = cum[i - 1] + ((pts[i].time - pts[i - 1].time) / timeRange) * pts[i - 1].m;
    }
  }
  return {
    at(x) {
      if (!pts) return x / timeRange;
      let i = findLastLE(pts, x, (p) => p.time);
      if (i < 0) i = 0;
      return cum[i] + ((x - pts[i].time) / timeRange) * pts[i].m;
    }
  };
}

export function getScroll(map, timeRange) {
  if (renderCache.scroll && renderCache.scrollMap === map && renderCache.scrollRange === timeRange) {
    return renderCache.scroll;
  }
  const scroll = makeScroll(map.cps, timeRange);
  renderCache.scrollMap = map;
  renderCache.scrollRange = timeRange;
  renderCache.scroll = scroll;
  renderCache.cursorMap = null;
  return scroll;
}

export function findListedBeatmapFile(html, expectedName) {
  const target = String(expectedName || "").trim().toLowerCase();
  if (!target) return "";
  for (const name of parseListingNames(html)) {
    if (!name.toLowerCase().endsWith(".osu")) continue;
    if (name.trim().toLowerCase() === target) return name;
  }
  return "";
}

export function isRealFolderName(folder) {
  const value = String(folder || "").trim();
  return value !== "" && value !== "." && value !== "..";
}

export async function fetchBeatmapTextFromListing() {
  const folder = String(state.beatmapFolder || "").trim();
  const fileName = String(state.beatmapFileName || "").trim();
  if (!isRealFolderName(folder) || !fileName) return null;
  for (let folderPad = 0; folderPad <= 2; folderPad += 1) {
    const folderName = " ".repeat(folderPad) + folder;
    const listUrl = `/files/beatmap/${encodeURIComponent(folderName)}/`;
    let html = "";
    try {
      const response = await fetch(listUrl, { cache: "no-store" });
      if (!response.ok) continue;
      html = await response.text();
    } catch {
      continue;
    }
    const actualName = findListedBeatmapFile(html, fileName);
    if (!actualName) continue;
    const fileUrl = `${listUrl}${encodeURIComponent(actualName)}`;
    try {
      const response = await fetch(fileUrl, { cache: "no-store" });
      if (!response.ok) continue;
      const text = await response.text();
      if (text && text.includes("osu file format")) return text;
    } catch {
      continue;
    }
  }
  return null;
}

export async function fetchBeatmapText() {
  let primaryError = "";
  try {
    const response = await fetch("/files/beatmap/file", { cache: "no-store" });
    if (response.ok) {
      const text = await response.text();
      if (text && text.includes("osu file format")) return text;
      primaryError = "empty beatmap response";
    } else {
      primaryError = `file request failed (${response.status})`;
    }
  } catch (err) {
    primaryError = String((err && err.message) || err);
  }
  const fallback = await fetchBeatmapTextFromListing();
  if (fallback) return fallback;
  throw new Error(primaryError || "beatmap fetch failed");
}

export async function ensureBeatmap() {
  const identity = state.checksum || (isRealFolderName(state.beatmapFolder) && state.beatmapFileName ? `${state.beatmapFolder}/${state.beatmapFileName}` : "");
  if (!identity) return;
  const key = `${identity}|${state.gameMode}|${state.csConverted}`;
  if (state.loadedKey === key) return;
  if (state.pendingKey === key) return;
  if (state.retryKey !== key) state.retryCount = 0;
  if (state.retryKey === key && performance.now() < state.retryAt) return;
  state.pendingKey = key;
  const token = ++state.loadToken;
  try {
    const text = await fetchBeatmapText();
    if (token !== state.loadToken) return;
    const parsed = parseOsu(text);
    const map = buildBeatmapFor(parsed);
    state.beatmap = map;
    state.loadedKey = key;
    state.retryKey = "";
    state.retryCount = 0;
    state.loadError = "";
    renderCache.cursorMap = null;
  } catch (err) {
    if (token !== state.loadToken) return;
    state.beatmap = null;
    state.retryKey = key;
    state.retryCount += 1;
    state.retryAt = performance.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (state.retryCount - 1));
    state.loadError = String((err && err.message) || err);
    console.error("[BeatmapPreview] beatmap fetch failed:", err);
  } finally {
    if (token === state.loadToken) state.pendingKey = "";
  }
}
