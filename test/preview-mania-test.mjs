import fs from "node:fs";
import vm from "node:vm";
import zlib from "node:zlib";

const code = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");

class E {
  constructor() {
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, contains() { return false; } };
    this.children = [];
    this.textContent = "";
    this.width = 640;
    this.height = 480;
  }
  appendChild(n) { this.children.push(n); return n; }
  getContext() { return ctxStub; }
  get relList() { return { supports: () => true }; }
  animate() { return { cancel() {} }; }
}
const drawCalls = [];
const ctxTarget = {
  globalAlpha: 1,
  _m: [1, 0, 0, 1, 0, 0],
  _stack: [],
  setTransform(a, b, c, d, e, f) { this._m = [a, b, c, d, e, f]; drawCalls.push(["setTransform", a, b, c, d, e, f]); },
  save() { this._stack.push(this._m.slice()); drawCalls.push(["save"]); },
  restore() { if (this._stack.length) this._m = this._stack.pop(); drawCalls.push(["restore"]); },
  translate(x, y) { const m = this._m; this._m = [m[0], m[1], m[2], m[3], m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; drawCalls.push(["translate", x, y]); },
  scale(x, y) { const m = this._m; this._m = [m[0] * x, m[1] * x, m[2] * y, m[3] * y, m[4], m[5]]; drawCalls.push(["scale", x, y]); },
  fillRect(x, y, w, h) { drawCalls.push(["fillRect", x, y, w, h, this._m.slice()]); }
};
const ctxStub = new Proxy(ctxTarget, {
  get: (t, p) => (p in t ? t[p] : (...a) => drawCalls.push([String(p), ...a])),
  set: (t, p, v) => { t[p] = v; return true; }
});
const bySel = new Map();
const doc = {
  createElement: (tag) => new E(),
  createDocumentFragment: () => new E(),
  querySelector: (s) => bySel.get(s) || null,
  querySelectorAll: () => [],
  documentElement: new E(),
  body: new E(),
  getElementById: () => new E()
};
bySel.set(".arrow", new E());
bySel.set(".tick-container", new E());
bySel.set(".colors-container", new E());

class WS { constructor(u) { this.url = u; this.readyState = 1; this.sent = []; } send(d) { this.sent.push(d); } close() {} }
class Img {
  constructor() { this.width = 512; this.height = 164; }
  set src(v) {
    this._src = v;
    setTimeout(() => {
      if (String(v).includes("default-skin") || String(v).startsWith("blob:")) this.onload && this.onload();
      else this.onerror && this.onerror();
    }, 0);
  }
  get src() { return this._src; }
}

let oskServe = null;
const fetchCalls = [];
const sb = {
  console, Date, Math, JSON, Number, Object, Array, Map, Set, String, Boolean, Error, Promise, Float64Array,
  parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
  DataView, Uint8Array, TextDecoder, Blob, Response, DecompressionStream, URL,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, performance,
  WebSocket: WS, Image: Img,
  fetch: async (url) => {
    fetchCalls.push(String(url));
    if (oskServe && String(url).includes("Test.osk")) {
      return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => oskServe };
    }
    return { ok: false, status: 404, text: async () => "" };
  },
  location: { host: "127.0.0.1:24050", search: "?debug" },
  document: doc,
  window: { self: {}, top: {}, COUNTER_PATH: "Beatmap Preview", innerWidth: 640, innerHeight: 480, devicePixelRatio: 1, addEventListener() {} }
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: "main.js" });

const api = sb.window.__beatmapPreview;
const results = [];
const check = (name, ok, info) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info !== undefined ? "  " + JSON.stringify(info) : ""}`);
};

const native = `osu file format v14

[General]
Mode: 3

[Difficulty]
CircleSize:4
OverallDifficulty:8
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0,100,1,0
2000,-100,4,2,0,100,0,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
192,192,1500,128,0,1900:0:0:0:
320,192,2000,128,0,2600:0:0:0:
448,192,3000,1,0,0:0:0:0:
`;

const parsed = api.parseOsu(native);
check("parse mania objects", parsed.objects.length === 4, { got: parsed.objects.length });
const map = api.buildManiaNative(parsed, 4);
check("native notes", map.notes.length === 4 && map.notes.every((n) => n.column >= 0 && n.column < 4));
check("hold end times", map.notes[1].hold && map.notes[1].endTime === 1900);
check("scroll monotonic", (() => { const s = api.makeScroll(map.cps, 1000); return s.at(0) < s.at(1000) && s.at(1000) < s.at(2000); })());

const std = native.replace("Mode: 3", "Mode: 0");
const conv = api.buildManiaFromStandard(api.parseOsu(std), 4);
check("std conversion notes", conv.notes.length >= 2, { got: conv.notes.length });
check("std conversion notice", typeof conv.notice === "string" && conv.notice.includes("converted"));

const layout = api.maniaSkin(4);
check("layout default columns", layout.cols.length === 4 && layout.hitPosition === 402);
const expected = { 4: "1221", 5: "12S21", 6: "121121", 7: "121S121", 8: "12122121", 9: "1212S2121" };
for (const [k, want] of Object.entries(expected)) {
  const got = Array.from({ length: Number(k) }, (_, i) => api.defaultManiaColumnIndex(Number(k), i)).join("");
  check(`${k}K layout`, got === want, got);
}
const names = api.maniaImageNames(4, 0);
check("default image names", names.note === "mania-note1" && names.body === "mania-note1L" && names.key === "mania-key1", names);

api.state.beatmap = map;
api.state.gameState = "selectPlay";
drawCalls.length = 0;
let renderError = null;
try {
  // 模拟每帧推进；cursor 应随时间前进且渲染无异常
  for (let i = 0; i < 120; i += 1) api.renderMania(ctxStub, map, 500 + i * 50, 2);
} catch (err) {
  renderError = err;
}
check("render 120 frames no error", !renderError, renderError ? renderError.message : undefined);
check("render produced draws", drawCalls.length > 0, { draws: drawCalls.length });

api.settings.backgroundOpacity = 1;
drawCalls.length = 0;
api.frame();
const bgFill = drawCalls.find((c) => Array.isArray(c) && c[0] === "fillRect" && c[3] === 480 && c[4] === 480 && Array.isArray(c[5]) && c[5][4] === 80);
check("background respects viewport transform", !!bgFill, bgFill);

check("note height keeps image aspect ratio", api.noteDrawHeight({ width: 512, height: 164 }, 30) === (30 * 164) / 512, api.noteDrawHeight({ width: 512, height: 164 }, 30));
check("reject traversal asset name", api.isSafeAssetName("../../secret") === false && api.isSafeAssetName("C:/x") === false);
check("accept subdir asset name", api.isSafeAssetName("sub/img") === true && api.isSafeAssetName("mania-note1") === true);

api.state.checksum = "";
api.state.beatmapFolder = ".";
api.state.beatmapFileName = "nekodex - circles! (peppy).osu";
api.state.loadedKey = "";
api.state.pendingKey = "";
api.state.retryKey = "";
api.state.retryCount = 0;
fetchCalls.length = 0;
await api.ensureBeatmap();
check("'.' folder (theme song) does not fetch beatmap", fetchCalls.length === 0, fetchCalls);

api.settings.useSkin = true;
api.state.client = "stable";
api.state.loadedSkinFolder = "PlayerSkin";
api.state.skin = api.parseSkinIni("[General]\nVersion: 2.7\n[Mania]\nKeys: 9\nNoteImage0: custom/missing\nKeyImage0: custom/missingkey\n");
api.state.skinFilePresent = true;
api.state.skinRev += 1;

const layout10 = api.maniaSkin(10);
check("unconfigured keycount uses default layout", layout10.cols.length === 10 && layout10.hitPosition === 402, { cols: layout10.cols.length, hit: layout10.hitPosition });

const map9 = { keys: 9, notes: [], cps: [] };
const layout9 = api.maniaSkin(9);
api.getColumnInfo(map9, layout9);
await new Promise((resolve) => setTimeout(resolve, 60));
const info9 = api.getColumnInfo(map9, layout9);
check(
  "missing skin image falls back to default assets",
  !!info9[0].note && info9[0].note.src.includes("default-skin") && !!info9[0].key && info9[0].key.src.includes("default-skin"),
  { note: info9[0].note ? info9[0].note.src : null, key: info9[0].key ? info9[0].key.src : null }
);

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data);
    const comp = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += local.length + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const total = Buffer.concat([...chunks, centralBuf, eocd]);
  return total.buffer.slice(total.byteOffset, total.byteOffset + total.byteLength);
}

const oskBuffer = makeZip([
  { name: "skin.ini", data: "[General]\nVersion: 2.7\n[Mania]\nKeys: 4\nColumnWidth: 40\n", deflate: true },
  { name: "mania-note1@2x.png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), deflate: true },
  { name: "sub/img.png", data: Buffer.from([1, 2, 3, 4]), deflate: false }
]);
const osk = await api.parseOsk(oskBuffer);
check("parse .osk reads deflated skin.ini", osk.skinIni.includes("ColumnWidth: 40"), osk.skinIni.split("\n").pop());
check("parse .osk lists entries", osk.files.has("mania-note1@2x.png") && osk.files.has("sub/img.png"));

api.settings.lazerSkinFile = "";
api.state.skinName = "My Skin";
const candidates = api.oskCandidates();
check(
  "osk candidates include skin name and fallbacks",
  candidates.includes("My Skin.osk") && candidates.includes("player.osk") && candidates.includes("skin.osk"),
  candidates
);
api.settings.lazerSkinFile = "../evil";
const safeCandidates = api.oskCandidates();
check("osk candidates reject unsafe names", safeCandidates.every((n) => !n.includes("..")), safeCandidates);
api.settings.lazerSkinFile = "";

api.state.osk = osk;
const oskImage = await api.findOskImage("mania-note1");
check("osk image lookup by image name", !!oskImage && String(oskImage.src).startsWith("blob:"), oskImage ? oskImage.src : null);
const oskSub = await api.findOskImage("sub/img");
check("osk image lookup in subfolder", !!oskSub && String(oskSub.src).startsWith("blob:"), oskSub ? oskSub.src : null);
api.state.osk = null;

oskServe = oskBuffer;
api.settings.useSkin = true;
api.settings.lazerSkinFile = "";
api.state.client = "lazer";
api.state.skinName = "";
api.state.oskKey = "";
await api.onV2({
  client: "lazer",
  state: { name: "selectPlay" },
  settings: { mode: { name: "mania" }, mania: { scrollSpeed: 5 }, skin: { name: "Test" } }
});
await new Promise((resolve) => setTimeout(resolve, 40));
check("lazer .osk loaded from counter folder", !!api.state.osk && api.state.oskFile === "Test.osk", { file: api.state.oskFile, hasOsk: !!api.state.osk });
api.getColumnInfo({ keys: 4, notes: [], cps: [] }, api.maniaSkin(4));
await new Promise((resolve) => setTimeout(resolve, 40));
const oskInfo = api.getColumnInfo({ keys: 4, notes: [], cps: [] }, api.maniaSkin(4));
check("lazer .osk image used for rendering", !!oskInfo[0].note && String(oskInfo[0].note.src).startsWith("blob:"), oskInfo[0].note ? oskInfo[0].note.src : null);

console.log("Summary:", results.filter((r) => r.ok).length + "/" + results.length + " passed");
process.exit(results.every((r) => r.ok) ? 0 : 1);
