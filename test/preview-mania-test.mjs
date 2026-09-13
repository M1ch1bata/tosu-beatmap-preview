import fs from "node:fs";
import vm from "node:vm";

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
const ctxStub = new Proxy({ globalAlpha: 1 }, {
  get: (t, p) => (p in t ? t[p] : (...a) => drawCalls.push(String(p))),
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
class Img { constructor() { this.width = 128; this.height = 128; } set src(v) { this._src = v; setTimeout(() => this.onerror && this.onerror(), 0); } get src() { return this._src; } }

const sb = {
  console, Date, Math, JSON, Number, Object, Array, Map, Set, String, Boolean, Error, Promise, Float64Array,
  parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, performance,
  WebSocket: WS, Image: Img,
  fetch: async () => ({ ok: false, status: 404, text: async () => "" }),
  location: { host: "127.0.0.1:24050" },
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

console.log("Summary:", results.filter((r) => r.ok).length + "/" + results.length + " passed");
process.exit(results.every((r) => r.ok) ? 0 : 1);
