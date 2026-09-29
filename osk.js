// osk.js - in-browser .osk (zip) reading for osu!lazer skins.
import { OSK_MAX_ENTRY_BYTES, OSK_FALLBACK_FILES, state, settings, imageState, splitSkinPath, isSafeAssetName, encodeSkinPath, tryImageUrl, parseSkinIni, applySkinConfig } from "./shared.js";

export function decodeZipName(bytes, flags) {
  if (flags & 0x0800) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function oskEntryBytes(entry) {
  if (entry.bytes) return entry.bytes;
  if (entry.uncompSize > OSK_MAX_ENTRY_BYTES) throw new Error("osk entry too large");
  const buffer = entry.buffer;
  if (entry.method === 0) {
    entry.bytes = new Uint8Array(buffer, entry.dataStart, entry.compSize);
    return entry.bytes;
  }
  if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`);
  if (typeof DecompressionStream === "undefined") throw new Error("DecompressionStream is not supported by this browser");
  const compressed = new Uint8Array(buffer, entry.dataStart, entry.compSize);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  entry.bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (entry.bytes.length > OSK_MAX_ENTRY_BYTES) throw new Error("osk entry too large");
  return entry.bytes;
}

export async function parseOsk(buffer) {
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  let eocd = -1;
  const minOffset = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= minOffset; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip/osk archive");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map();
  let skinIniEntry = null;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("bad zip central directory");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const uncompSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("zip64 .osk is not supported");
    if (uncompSize > OSK_MAX_ENTRY_BYTES) throw new Error("osk entry too large");
    const name = decodeZipName(new Uint8Array(buffer, offset + 46, nameLen), flags);
    if (localOffset + 30 > length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("bad zip local header");
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > length) throw new Error("truncated zip entry");
    const path = name.replace(/\\/g, "/").replace(/^\.\//, "");
    if (path && !path.endsWith("/")) {
      const entry = { path, method, compSize, uncompSize, dataStart, buffer, bytes: null, img: null, objectUrl: "", failed: false };
      files.set(path.toLowerCase(), entry);
      if (path.toLowerCase() === "skin.ini") skinIniEntry = entry;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  let skinIni = "";
  if (skinIniEntry) skinIni = new TextDecoder("utf-8").decode(await oskEntryBytes(skinIniEntry));
  return { files, skinIni };
}

export async function loadOskImage(entry) {
  if (entry.img) return entry.img;
  if (entry.failed) return null;
  try {
    const bytes = await oskEntryBytes(entry);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    entry.objectUrl = url;
    const img = await tryImageUrl(url);
    if (!img) {
      entry.failed = true;
      URL.revokeObjectURL(url);
      entry.objectUrl = "";
      return null;
    }
    entry.img = img;
    return img;
  } catch (err) {
    entry.failed = true;
    return null;
  }
}

export async function findOskImage(name) {
  const osk = state.osk;
  if (!osk) return null;
  const { dir, base } = splitSkinPath(name);
  const candidates = [`${base}@2x.png`, `${base}.png`, `${base}-0@2x.png`, `${base}-0.png`];
  for (const candidate of candidates) {
    const entry = osk.files.get(`${dir}${candidate}`.toLowerCase());
    if (!entry) continue;
    const img = await loadOskImage(entry);
    if (img) return img;
  }
  return null;
}

export function releaseOsk() {
  if (state.osk) {
    for (const entry of state.osk.files.values()) {
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      entry.img = null;
    }
  }
  state.osk = null;
  state.oskFile = "";
}

export function oskCandidates() {
  const list = [];
  const configured = String(settings.lazerSkinFile || "").trim();
  if (configured) list.push(configured.toLowerCase().endsWith(".osk") ? configured : `${configured}.osk`);
  if (state.skinName) list.push(`${state.skinName}.osk`);
  for (const fallback of OSK_FALLBACK_FILES) list.push(fallback);
  const seen = new Set();
  const out = [];
  for (const name of list) {
    const clean = name.replace(/\\/g, "/");
    if (seen.has(clean.toLowerCase()) || !isSafeAssetName(clean)) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

export async function fetchBinary(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

export async function ensureLazerOsk() {
  const candidates = oskCandidates();
  const key = `${state.client}|${state.skinName}|${candidates.join("|")}`;
  if (state.oskKey === key) return;
  state.oskKey = key;
  const token = ++state.oskToken;
  releaseOsk();
  imageState.clear();
  applySkinConfig(parseSkinIni(""), false);
  for (const name of candidates) {
    const buffer = await fetchBinary(`./${encodeSkinPath(name)}`);
    if (token !== state.oskToken) return;
    if (!buffer) continue;
    try {
      const osk = await parseOsk(buffer);
      if (token !== state.oskToken) return;
      state.osk = osk;
      state.oskFile = name;
      applySkinConfig(parseSkinIni(osk.skinIni), true);
      return;
    } catch (err) {
      console.warn(`[BeatmapPreview] failed to read ${name}:`, err);
    }
  }
}
