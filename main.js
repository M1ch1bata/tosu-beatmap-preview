const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const findLastLE = (arr, x, key) => {
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
const findFirstGE = (arr, x, key) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const MODE_NAMES = ["osu", "taiko", "fruits", "mania"];
const MANIA_FALLBACK = [
  "#ffffff",
  "#ffd966",
  "#8cd9ff",
  "#ff9d9d",
  "#c9a7ff",
  "#9dffbd",
  "#ffe29d",
  "#9db4ff"
];
const DEFAULT_SKIN_FILES = new Set([
  "mania-key1@2x.png",
  "mania-key1D@2x.png",
  "mania-key2@2x.png",
  "mania-key2D@2x.png",
  "mania-keyS@2x.png",
  "mania-keySD@2x.png",
  "mania-note1@2x.png",
  "mania-note1H@2x.png",
  "mania-note1L-0@2x.png",
  "mania-note2@2x.png",
  "mania-note2H@2x.png",
  "mania-note2L-0@2x.png",
  "mania-noteS@2x.png",
  "mania-noteSH@2x.png",
  "mania-noteSL-0@2x.png",
  "mania-stage-hint@2x.png"
]);

const settings = {
  backgroundColor: "#000000",
  backgroundOpacity: 0,
  renderScale: 100,
  showInSongSelect: true,
  autoHideInGameplay: true,
  useSkin: true,
  maniaScrollSpeedOverride: 0,
  playfieldOpacity: 1,
  fpsLimit: 0
};

const state = {
  gameState: "",
  client: "stable",
  gameMode: "osu",
  mapMode: "osu",
  checksum: "",
  skinFolder: "",
  loadedSkinFolder: null,
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
  loadError: "",
  loadToken: 0,
  time: 0,
  timeLocal: 0,
  timeSpeed: 1,
  preciseAt: 0
};

const imageState = new Map();
const listingCache = new Map();

const renderCache = {
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

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

class SocketManager {
  constructor(host) {
    this.host = host;
    this.sockets = {};
  }
  open(path, onMessage, filters) {
    if (this.sockets[path]) return;
    const url = `ws://${this.host}${path}?l=${encodeURIComponent(window.COUNTER_PATH || "")}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      setTimeout(() => this.open(path, onMessage, filters), 1000);
      return;
    }
    this.sockets[path] = ws;
    ws.onopen = () => {
      if (filters) ws.send(`applyFilters:${JSON.stringify(filters)}`);
    };
    ws.onclose = () => {
      delete this.sockets[path];
      setTimeout(() => this.open(path, onMessage, filters), 1000);
    };
    ws.onerror = () => {};
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data === "object" && "error" in data) return;
        onMessage(data);
      } catch (err) {
        console.error("[BeatmapPreview]", err);
      }
    };
  }
  send(path, text) {
    const ws = this.sockets[path];
    if (ws && ws.readyState === 1) {
      ws.send(text);
      return true;
    }
    return false;
  }
}

function setTime(t, precise) {
  if (!Number.isFinite(t)) return;
  const now = performance.now();
  const dt = now - state.timeLocal;
  if (dt > 0 && dt < 1000) {
    const inst = (t - state.time) / dt;
    if (inst >= 0 && inst < 3) state.timeSpeed = state.timeSpeed * 0.75 + inst * 0.25;
    else if (inst < -0.01) state.timeSpeed = 1;
  } else {
    state.timeSpeed = 1;
  }
  state.time = t;
  state.timeLocal = now;
  if (precise) state.preciseAt = now;
}

function renderTime() {
  const now = performance.now();
  const window_ = state.preciseAt && now - state.preciseAt < 500 ? 400 : 300;
  const dt = clamp(now - state.timeLocal, 0, window_);
  return state.time + dt * clamp(state.timeSpeed, 0, 3);
}

function parseTiming(lines) {
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

function computeMostCommonBeatLength(raw, lastTime) {
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

function parseHitObject(line) {
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

function parseOsu(text) {
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

function maniaCps(timing, svScale) {
  const mostCommon = timing.mostCommon || 500;
  return timing.cps.map((p) => ({
    time: p.time,
    m: ((svScale ? p.sv : 1) * mostCommon) / (p.beatLength || mostCommon)
  }));
}

function buildManiaNative(parsed, keys) {
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

function buildManiaFromStandard(parsed, keys) {
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

function modeName(index) {
  return MODE_NAMES[index] || "osu";
}

function buildBeatmapFor(parsed) {
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

function parseSkinIni(text) {
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

function skinContentRev() {
  return `${state.loadedSkinFolder || ""}|${settings.useSkin ? "1" : "0"}|${settings.useSkin ? "" : state.client}`;
}

function skinBodyStyleDefault() {
  if (!settings.useSkin) return 0;
  const version = Number.parseFloat(state.skin && state.skin.general ? state.skin.general.version : "");
  if (Number.isFinite(version) && version < 2.5) return 0;
  return 1;
}

function maniaSkin(keys) {
  const cfg = settings.useSkin && state.skin && state.skin.mania ? state.skin.mania[keys] : null;
  const parseArray = (name, count, fallback) => {
    const out = new Array(count).fill(fallback);
    const raw = cfg ? cfg[name] : null;
    if (raw) {
      const parts = String(raw).split(",");
      for (let i = 0; i < count && i < parts.length; i++) {
        const v = parseFloat(parts[i]);
        if (Number.isFinite(v)) out[i] = v;
      }
    }
    return out;
  };
  const widths = parseArray("columnwidth", keys, 30);
  const spacings = parseArray("columnspacing", Math.max(0, keys - 1), 0);
  const hitPosition = clamp(num(cfg && cfg.hitposition, 402), 240, 480);
  const noteHeightScale = num(cfg && cfg.widthfornoteheightscale, 0);
  const total = widths.reduce((a, b) => a + b, 0) + spacings.reduce((a, b) => a + b, 0);
  const explicitStart = cfg && cfg.columnstart !== undefined ? parseFloat(cfg.columnstart) : NaN;
  let x = Number.isFinite(explicitStart) ? explicitStart : (480 - total) / 2;
  const cols = [];
  for (let i = 0; i < keys; i++) {
    cols.push({ x, w: widths[i] });
    x += widths[i] + (spacings[i] || 0);
  }
  const stageHint = cfg && cfg.stagehint ? String(cfg.stagehint) : "mania-stage-hint";
  const defaultStyle = skinBodyStyleDefault();
  const globalRaw = cfg && cfg.notebodystyle !== undefined ? parseInt(cfg.notebodystyle, 10) : NaN;
  const globalStyle = Number.isFinite(globalRaw) ? globalRaw : defaultStyle;
  const bodyStyles = new Array(keys);
  for (let i = 0; i < keys; i++) {
    const raw = cfg && cfg[`notebodystyle${i}`] !== undefined ? parseInt(cfg[`notebodystyle${i}`], 10) : NaN;
    bodyStyles[i] = Number.isFinite(raw) ? raw : globalStyle;
  }
  return { cols, hitPosition, noteHeightScale: noteHeightScale > 0 ? noteHeightScale : 0, stageHint, bodyStyles };
}

function getManiaLayout(keys) {
  const rev = skinContentRev();
  if (renderCache.layout && renderCache.layoutKeys === keys && renderCache.layoutRev === rev) {
    return renderCache.layout;
  }
  const layout = maniaSkin(keys);
  renderCache.layout = layout;
  renderCache.layoutKeys = keys;
  renderCache.layoutRev = rev;
  return layout;
}

function assetDirPrefix() {
  if (settings.useSkin) return "/files/skin/";
  const folder = state.client === "lazer" ? "lazer" : "stable";
  return `./default-skin/${folder}/`;
}

function splitSkinPath(name) {
  const path = String(name).replace(/\\/g, "/");
  const idx = path.lastIndexOf("/");
  return idx >= 0
    ? { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) }
    : { dir: "", base: path };
}

function encodeSkinPath(path) {
  return String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
}

function skinAssetUrl(base) {
  return `${assetDirPrefix()}${encodeSkinPath(String(base).replace(/\\/g, "/"))}.png`;
}

function tryImageUrl(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function tryImage(base) {
  return tryImageUrl(skinAssetUrl(base));
}

function parseListingNames(html) {
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

function getListing(dir) {
  const key = dir;
  if (!listingCache.has(key)) {
    listingCache.set(
      key,
      fetch(encodeSkinPath(dir), { cache: "no-store" })
        .then((res) => (res.ok ? res.text() : null))
        .then((html) => (html === null ? null : parseListingNames(html)))
        .catch(() => null)
    );
  }
  return listingCache.get(key);
}

async function resolveImage(name) {
  const { dir, base } = splitSkinPath(name);
  const fullDir = assetDirPrefix() + dir;
  const listing = settings.useSkin ? await getListing(fullDir) : DEFAULT_SKIN_FILES;
  if (listing) {
    const lower = new Map();
    for (const actual of listing) lower.set(actual.toLowerCase(), actual);
    const candidates = [`${base}@2x.png`, `${base}.png`, `${base}-0@2x.png`, `${base}-0.png`];
    for (const candidate of candidates) {
      const actual = lower.get(candidate.toLowerCase());
      if (!actual) continue;
      const img = await tryImageUrl(encodeSkinPath(fullDir + actual));
      if (img) return img;
    }
    return null;
  }
  // Listing unavailable (player skin without directory index): probe variants.
  const hd = await tryImage(`${name}@2x`);
  if (hd) return hd;
  const sd = await tryImage(name);
  if (sd) return sd;
  const animHd = await tryImage(`${name}-0@2x`);
  if (animHd) return animHd;
  return tryImage(`${name}-0`);
}

function requestImage(name) {
  let entry = imageState.get(name);
  if (!entry) {
    entry = { img: null };
    imageState.set(name, entry);
    resolveImage(name)
      .then((img) => {
        entry.img = img;
        renderCache.loadedImages += 1;
      })
      .catch(() => {
        renderCache.loadedImages += 1;
      });
  }
  return entry.img;
}

function drawImage2(ctx, img, cx, cy, w, h) {
  if (!img) return false;
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  return true;
}

function makeScroll(cps, timeRange) {
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

function getScroll(map, timeRange) {
  if (renderCache.scroll && renderCache.scrollMap === map && renderCache.scrollRange === timeRange) {
    return renderCache.scroll;
  }
  const scroll = makeScroll(map.cps, timeRange);
  renderCache.scrollMap = map;
  renderCache.scrollRange = timeRange;
  renderCache.scroll = scroll;
  return scroll;
}

function defaultManiaColumnIndex(keys, column) {
  if (keys === 1) return "S";
  const hasSpecial = keys >= 5 && keys % 2 === 1;
  const special = hasSpecial ? Math.floor(keys / 2) : -1;
  if (column === special) return "S";
  let left = 0;
  let right = 0;
  for (let i = 0; i < keys; i++) {
    if (i === special) continue;
    if (i < column) left++;
    else if (i > column) right++;
  }
  return Math.min(left, right) % 2 === 0 ? "1" : "2";
}

function maniaImageNames(keys, column) {
  const cfg = settings.useSkin && state.skin && state.skin.mania ? state.skin.mania[keys] : null;
  const index = defaultManiaColumnIndex(keys, column);
  const custom = (key) => (cfg && cfg[key] ? String(cfg[key]) : "");
  return {
    note: custom(`noteimage${column}`) || `mania-note${index}`,
    head: custom(`noteimage${column}h`) || `mania-note${index}H`,
    tail: custom(`noteimage${column}t`) || `mania-note${index}T`,
    body: custom(`noteimage${column}l`) || `mania-note${index}L`,
    key: custom(`keyimage${column}`) || `mania-key${index}`
  };
}

function getColumnNames(keys) {
  const rev = skinContentRev();
  if (renderCache.names && renderCache.namesKeys === keys && renderCache.namesRev === rev) {
    return renderCache.names;
  }
  const names = new Array(keys);
  for (let i = 0; i < keys; i++) names[i] = maniaImageNames(keys, i);
  renderCache.names = names;
  renderCache.namesKeys = keys;
  renderCache.namesRev = rev;
  return names;
}

function getColumnInfo(map, layout) {
  const rev = skinContentRev();
  if (
    renderCache.info &&
    renderCache.infoKeys === map.keys &&
    renderCache.infoRev === rev &&
    renderCache.infoLoaded === renderCache.loadedImages
  ) {
    return renderCache.info;
  }
  const names = getColumnNames(map.keys);
  const info = [];
  for (let i = 0; i < map.keys; i++) {
    const n = names[i];
    const note = requestImage(n.note);
    const head = requestImage(n.head);
    info.push({
      key: requestImage(n.key),
      note,
      head,
      tail: requestImage(n.tail) || head || note,
      body: requestImage(n.body)
    });
  }
  info.hint = requestImage(layout.stageHint);
  renderCache.info = info;
  renderCache.infoKeys = map.keys;
  renderCache.infoRev = rev;
  renderCache.infoLoaded = renderCache.loadedImages;
  return info;
}

function drawManiaStatic(g, layout, info) {
  const hitPosition = layout.hitPosition;
  for (let i = 0; i < layout.cols.length; i++) {
    const col = layout.cols[i];
    g.globalAlpha = 0.55;
    g.fillStyle = "rgba(10,10,14,0.65)";
    g.fillRect(col.x, 0, col.w, hitPosition);
    const key = info[i] ? info[i].key : null;
    if (key) {
      const keyHeight = Math.max(1, col.w * (key.height / Math.max(1, key.width)));
      g.globalAlpha = 1;
      drawImage2(g, key, col.x + col.w / 2, hitPosition - keyHeight / 2, col.w, keyHeight);
    }
  }
  const stageLeft = layout.cols.length ? layout.cols[0].x : 0;
  const lastCol = layout.cols.length ? layout.cols[layout.cols.length - 1] : null;
  const stageRight = lastCol ? lastCol.x + lastCol.w : 480;
  const stageWidth = Math.max(1, stageRight - stageLeft);
  const hint = info.hint;
  if (hint) {
    const hintHeight = Math.max(1, stageWidth * (hint.height / Math.max(1, hint.width)));
    g.globalAlpha = 1;
    drawImage2(g, hint, (stageLeft + stageRight) / 2, hitPosition, stageWidth, hintHeight);
  } else {
    g.globalAlpha = 0.35;
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillRect(stageLeft, hitPosition - 1, stageWidth, 2);
  }
  g.globalAlpha = 1;
}

function stageBounds(layout) {
  let minX = 0;
  let maxX = 480;
  if (layout.cols.length) {
    minX = Math.min(minX, layout.cols[0].x);
    const last = layout.cols[layout.cols.length - 1];
    maxX = Math.max(maxX, last.x + last.w);
  }
  return { x: minX, y: 0, w: maxX - minX, h: 480 };
}

function getStaticLayer(layout, info, view, layerScale) {
  if (
    renderCache.staticLayer &&
    renderCache.staticLayout === layout &&
    renderCache.staticLoaded === renderCache.loadedImages &&
    renderCache.staticScale === layerScale
  ) {
    return renderCache.staticLayer;
  }
  const px = Math.max(1, Math.round(view.w * layerScale));
  const py = Math.max(1, Math.round(view.h * layerScale));
  const layer = document.createElement("canvas");
  layer.width = px;
  layer.height = py;
  const g = layer.getContext("2d");
  g.setTransform(px / view.w, 0, 0, py / view.h, (-view.x * px) / view.w, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  drawManiaStatic(g, layout, info);
  renderCache.staticLayer = layer;
  renderCache.staticLayout = layout;
  renderCache.staticLoaded = renderCache.loadedImages;
  renderCache.staticScale = layerScale;
  return layer;
}

function drawHoldBody(ctx, ci, style, colX, colW, yHead, yTail, visTop, visBottom) {
  const img = ci.body;
  if (!img) return false;
  const rawTop = Math.min(yHead, yTail);
  const rawBottom = Math.max(yHead, yTail);
  const top = Math.max(rawTop, visTop);
  const bottom = Math.min(rawBottom, visBottom);
  if (bottom <= top) return true;
  const bodyLen = Math.max(2, bottom - top);
  if (style === 0) {
    ctx.drawImage(img, colX, top, colW, bodyLen);
    return true;
  }
  const s = colW / Math.max(1, img.width);
  if (!Number.isFinite(s) || s <= 0) {
    ctx.drawImage(img, colX, top, colW, bodyLen);
    return true;
  }
  const tileH = Math.max(0.5, img.height * s);
  const maxTiles = 64;
  let drawn = 0;
  if (style === 2) {
    const k = Math.max(0, Math.floor((yHead - bottom) / tileH));
    for (let tileBottom = yHead - k * tileH; tileBottom > top && drawn < maxTiles; tileBottom -= tileH, drawn += 1) {
      const tileTop = tileBottom - tileH;
      const drawTop = Math.max(tileTop, top);
      const drawBottom = Math.min(tileBottom, bottom);
      if (drawBottom <= drawTop) continue;
      const srcTop = (drawTop - tileTop) / s;
      const srcBottom = (drawBottom - tileTop) / s;
      ctx.drawImage(img, 0, srcTop, img.width, srcBottom - srcTop, colX, drawTop, colW, drawBottom - drawTop);
    }
  } else {
    const start = yTail + Math.floor((top - yTail) / tileH) * tileH;
    for (let tileTop = start; tileTop < bottom && drawn < maxTiles; tileTop += tileH, drawn += 1) {
      const tileBottom = tileTop + tileH;
      const drawTop = Math.max(tileTop, top);
      const drawBottom = Math.min(tileBottom, bottom);
      if (drawBottom <= drawTop) continue;
      const srcTop = (drawTop - tileTop) / s;
      const srcBottom = (drawBottom - tileTop) / s;
      ctx.drawImage(img, 0, srcTop, img.width, srcBottom - srcTop, colX, drawTop, colW, drawBottom - drawTop);
    }
  }
  return true;
}

function visibleStartIndex(map, scroll, now, t) {
  const notes = map.notes;
  if (renderCache.cursorMap !== map || t < renderCache.cursorTime - 1500) {
    renderCache.cursorMap = map;
    renderCache.cursor = Math.max(0, findFirstGE(notes, t - 30000, (n) => n.time));
  }
  let i = renderCache.cursor;
  while (i < notes.length) {
    const n = notes[i];
    const end = n.hold ? n.endTime : n.time;
    if (scroll.at(end) - now < -0.35) {
      i++;
      continue;
    }
    break;
  }
  renderCache.cursor = i;
  renderCache.cursorTime = t;
  return i;
}

function renderMania(ctx, map, t, scale) {
  if (!map.notes || !map.notes.length) return;
  const layout = getManiaLayout(map.keys);
  const hitPosition = layout.hitPosition;
  const speed = num(settings.maniaScrollSpeedOverride, 0) > 0 ? num(settings.maniaScrollSpeedOverride, 0) : clamp(state.maniaScrollSpeed || 5, 1, 40);
  const timeRange = (11485 / speed) * (hitPosition / 402);
  const scroll = getScroll(map, timeRange);
  const now = scroll.at(t);
  const opacity = clamp(num(settings.playfieldOpacity, 1), 0, 1);
  const info = getColumnInfo(map, layout);

  const layerScale = clamp(Number.isFinite(scale) ? scale : 1, 1, 4);
  const view = stageBounds(layout);
  const layer = getStaticLayer(layout, info, view, Math.round(layerScale * 2) / 2);
  ctx.globalAlpha = opacity;
  ctx.drawImage(layer, view.x, view.y, view.w, view.h);
  ctx.globalAlpha = 1;

  const start = visibleStartIndex(map, scroll, now, t);
  ctx.globalAlpha = opacity;
  for (let i = start; i < map.notes.length; i++) {
    const note = map.notes[i];
    const fracHead = scroll.at(note.time) - now;
    if (fracHead > 1.3) break;
    const fracTail = note.hold ? scroll.at(note.endTime) - now : fracHead;
    const yHead = hitPosition - fracHead * hitPosition;
    const yTail = hitPosition - fracTail * hitPosition;
    if (Math.min(yHead, yTail) > hitPosition + 80) continue;
    if (Math.max(yHead, yTail) < -80) continue;
    const col = layout.cols[note.column];
    if (!col) continue;
    const ci = info[note.column];
    if (!ci) continue;
    const height = layout.noteHeightScale > 0 ? layout.noteHeightScale : col.w;
    const cx = col.x + col.w / 2;
    if (note.hold) {
      const style = layout.bodyStyles ? layout.bodyStyles[note.column] : 0;
      if (!drawHoldBody(ctx, ci, style ?? 0, col.x, col.w, yHead, yTail, -200, 680)) {
        const top = Math.min(yHead, yTail);
        const bottom = Math.max(yHead, yTail);
        ctx.fillStyle = MANIA_FALLBACK[note.column % MANIA_FALLBACK.length];
        ctx.fillRect(col.x, top, col.w, Math.max(1, bottom - top));
      }
    }
    const head = note.hold ? (ci.head || ci.note) : ci.note;
    if (head) drawImage2(ctx, head, cx, yHead, col.w, height);
    else {
      ctx.fillStyle = MANIA_FALLBACK[note.column % MANIA_FALLBACK.length];
      ctx.fillRect(col.x, yHead - height / 2, col.w, height);
    }
    if (note.hold && ci.tail) drawImage2(ctx, ci.tail, cx, yTail, col.w, height);
  }
  ctx.globalAlpha = 1;
}

function allowedState() {
  if (state.gameState === "selectPlay" || state.gameState === "selectEdit") return !!settings.showInSongSelect;
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
    }
  }
}

async function ensureSkin() {
  if (!settings.useSkin) return;
  if (state.skinFolder === state.loadedSkinFolder) return;
  state.loadedSkinFolder = state.skinFolder;
  imageState.clear();
  listingCache.clear();
  state.skin = parseSkinIni("");
  try {
    let res = await fetch("/files/skin/skin.ini", { cache: "no-store" });
    if (!res.ok) res = await fetch("/files/skin/Skin.ini", { cache: "no-store" });
    if (res.ok) state.skin = parseSkinIni(await res.text());
  } catch (err) {
    console.error("[BeatmapPreview] skin", err);
  }
}

function findListedBeatmapFile(html, expectedName) {
  const target = String(expectedName || "").trim().toLowerCase();
  if (!target) return "";
  for (const name of parseListingNames(html)) {
    if (!name.toLowerCase().endsWith(".osu")) continue;
    if (name.trim().toLowerCase() === target) return name;
  }
  return "";
}

async function fetchBeatmapTextFromListing() {
  const folder = String(state.beatmapFolder || "").trim();
  const fileName = String(state.beatmapFileName || "").trim();
  if (!folder || !fileName) return null;
  const host = location.host;
  for (let folderPad = 0; folderPad <= 2; folderPad += 1) {
    const folderName = " ".repeat(folderPad) + folder;
    const listUrl = `http://${host}/files/beatmap/${encodeURIComponent(folderName)}/`;
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
    const fileUrl = `http://${host}/files/beatmap/${encodeURIComponent(folderName)}/${encodeURIComponent(actualName)}`;
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

async function fetchBeatmapText() {
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

async function ensureBeatmap() {
  const identity = state.checksum || (state.beatmapFolder && state.beatmapFileName ? `${state.beatmapFolder}/${state.beatmapFileName}` : "");
  if (!identity) return;
  const key = `${identity}|${state.gameMode}|${state.csConverted}`;
  if (state.loadedKey === key) return;
  if (state.pendingKey === key) return;
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
    state.loadError = "";
    renderCache.cursorMap = null;
  } catch (err) {
    if (token !== state.loadToken) return;
    state.beatmap = null;
    state.retryKey = key;
    state.retryAt = performance.now() + 2000;
    state.loadError = String((err && err.message) || err);
    console.error("[BeatmapPreview] beatmap fetch failed:", err);
  } finally {
    if (token === state.loadToken) state.pendingKey = "";
  }
}

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
let lastDrawRev = "";

function currentViewport(width, height, view) {
  const padBase = 100;
  const scale = Math.min(width / view.w, height / view.h) * (clamp(num(settings.renderScale, 100), 1, 1000) / 100);
  const offsetX = (width - view.w * scale) / 2 - view.x * scale;
  const offsetY = (height - view.h * scale) / 2 - view.y * scale;
  const pad = padBase * scale;
  const left = Math.max(0, offsetX + view.x * scale - pad);
  const top = Math.max(0, offsetY + view.y * scale - pad);
  const right = Math.min(width, offsetX + (view.x + view.w) * scale + pad);
  const bottom = Math.min(height, offsetY + (view.y + view.h) * scale + pad);
  return {
    scale,
    offsetX,
    offsetY,
    clear: { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
  };
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
      lastDrawRev = "";
      wasVisible = false;
    }
    return;
  }

  const t = renderTime();
  const keys = state.beatmap.keys;
  const rev = `${t.toFixed(3)}|${keys}|${skinContentRev()}|${renderCache.loadedImages}|${state.maniaScrollSpeed}|${settings.maniaScrollSpeedOverride}|${settings.playfieldOpacity}|${settings.renderScale}|${settings.backgroundOpacity}|${settings.backgroundColor}|${width}|${height}`;
  if (rev === lastDrawRev) return;
  lastDrawRev = rev;
  wasVisible = true;

  const bgOpacity = clamp(num(settings.backgroundOpacity, 0), 0, 1);
  const view = stageBounds(getManiaLayout(keys));
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
  if (bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(settings.backgroundColor, bgOpacity);
    ctx.fillRect(view.x, view.y, view.w, view.h);
  }

  ctx.setTransform(vp.scale, 0, 0, vp.scale, vp.offsetX, vp.offsetY);
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  ctx.clip();
  renderMania(ctx, state.beatmap, t, vp.scale);
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
      { field: "mania", keys: ["scrollSpeed"] }
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
    if (!settings.useSkin) {
      imageState.clear();
      listingCache.clear();
    }
  }
  const stateName = data.state && data.state.name;
  if (stateName) state.gameState = stateName;
  const gameMode = data.settings && data.settings.mode && data.settings.mode.name;
  if (gameMode) state.gameMode = gameMode;
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
  }
  const live = Number(data.beatmap && data.beatmap.time && data.beatmap.time.live);
  if (Number.isFinite(live)) setTime(live, false);
  ensureSkin();
  ensureBeatmap();
}

function onPrecise(data) {
  if (data && Number.isFinite(Number(data.currentTime))) setTime(Number(data.currentTime), true);
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
sockets.open("/websocket/v2/precise", onPrecise, ["currentTime"]);
sockets.open("/websocket/commands", onCommand, null);
requestSettings();

window.__beatmapPreview = {
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
  updateSettings,
  ensureBeatmap,
  fetchBeatmapText,
  maniaSkin,
  maniaImageNames,
  defaultManiaColumnIndex,
  getColumnInfo,
  onV2,
  onPrecise,
  frame,
  allowedState,
  statusText,
  canvas,
  sockets
};

requestAnimationFrame(frame);
