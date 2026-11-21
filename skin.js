// skin.js - skin.ini config resolution, mania layout/column names, image
// lookup (player skin folder + bundled default) and skin loading.
import { clamp, num, STAGE_SIZE, DEFAULT_HIT_POSITION, HIT_POSITION_MIN, DEFAULT_SKIN_FILES, settings, state, renderCache, imageState, listingCache, splitSkinPath, isSafeAssetName, encodeSkinPath, tryImageUrl, parseListingNames, parseSkinIni, applySkinConfig, skinContentRev } from "./shared.js?v=0.8.1";
import { findOskImage, releaseOsk, ensureLazerOsk } from "./osk.js?v=0.8.1";

// Effective mania config for a key count: the player skin (folder / .osk) wins
// when it defines that key count, otherwise the bundled default skin is used.
// This mirrors osu! falling back to the default skin for unconfigured key counts.
export function resolveManiaSource(keys) {
  const playerConfig = settings.useSkin ? state.skin : null;
  if (playerConfig && playerConfig.mania && playerConfig.mania[keys]) {
    return { cfg: playerConfig.mania[keys], general: playerConfig.general || {}, filePresent: !!state.skinFilePresent };
  }
  if (state.defaultSkin && state.defaultSkin.mania && state.defaultSkin.mania[keys]) {
    return { cfg: state.defaultSkin.mania[keys], general: state.defaultSkin.general || {}, filePresent: !!state.defaultSkinPresent };
  }
  if (playerConfig) return { cfg: null, general: playerConfig.general || {}, filePresent: !!state.skinFilePresent };
  return { cfg: null, general: state.defaultSkin ? state.defaultSkin.general || {} : {}, filePresent: !!state.defaultSkinPresent };
}

export function skinBodyStyleDefault(general) {
  const versionRaw = general ? general.version : undefined;
  // an unset NoteBodyStyle defaults to the cascade behaviour (osu!lazer uses
  // the tiling path for null), not to stretch
  if (versionRaw === undefined) return 1;
  if (String(versionRaw).trim().toLowerCase() === "latest") return 1;
  const version = Number.parseFloat(versionRaw);
  if (!Number.isFinite(version)) return 1;
  return version < 2.5 ? 0 : 1;
}

export function maniaSkin(keys) {
  const source = resolveManiaSource(keys);
  const cfg = source.cfg;
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
  const rawHitPosition = clamp(num(cfg && cfg.hitposition, DEFAULT_HIT_POSITION), HIT_POSITION_MIN, STAGE_SIZE);
  // [Mania] UpsideDown flips the stage vertically (DDR style): notes rise from
  // the bottom and the judgement line is mirrored. The Force Upside Down
  // setting wins so players whose skin does not declare it still get DDR.
  const skinFlip = cfg && cfg.upsidedown !== undefined ? String(cfg.upsidedown).trim().toLowerCase() : "";
  const upsideDown = !!settings.flipPlayfield || skinFlip === "1" || skinFlip === "true" || skinFlip === "yes";
  const hitPosition = upsideDown ? STAGE_SIZE - rawHitPosition : rawHitPosition;
  const noteHeightScale = num(cfg && cfg.widthfornoteheightscale, 0);
  const total = widths.reduce((a, b) => a + b, 0) + spacings.reduce((a, b) => a + b, 0);
  // osu!lazer ignores ColumnStart (unimplemented upstream) and centres the stage
  const explicitStart = state.client === "lazer" || !cfg || cfg.columnstart === undefined ? NaN : parseFloat(cfg.columnstart);
  let x = Number.isFinite(explicitStart) ? explicitStart : (STAGE_SIZE - total) / 2;
  const cols = [];
  for (let i = 0; i < keys; i++) {
    cols.push({ x, w: widths[i] });
    x += widths[i] + (spacings[i] || 0);
  }
  const stageHint = cfg && cfg.stagehint ? String(cfg.stagehint) : "mania-stage-hint";
  const defaultStyle = skinBodyStyleDefault(source.general);
  const globalRaw = cfg && cfg.notebodystyle !== undefined ? parseInt(cfg.notebodystyle, 10) : NaN;
  const globalStyle = Number.isFinite(globalRaw) ? globalRaw : defaultStyle;
  const bodyStyles = new Array(keys);
  for (let i = 0; i < keys; i++) {
    const raw = cfg && cfg[`notebodystyle${i}`] !== undefined ? parseInt(cfg[`notebodystyle${i}`], 10) : NaN;
    bodyStyles[i] = Number.isFinite(raw) ? raw : globalStyle;
  }
  return { cols, hitPosition, rawHitPosition, upsideDown, noteHeightScale: noteHeightScale > 0 ? noteHeightScale : 0, stageHint, bodyStyles };
}

export function getManiaLayout(keys, rev) {
  rev = rev !== undefined ? rev : skinContentRev();
  if (renderCache.layout && renderCache.layoutKeys === keys && renderCache.layoutRev === rev) {
    return renderCache.layout;
  }
  const layout = maniaSkin(keys);
  renderCache.layout = layout;
  renderCache.layoutKeys = keys;
  renderCache.layoutRev = rev;
  return layout;
}

export function defaultSkinPrefix() {
  const folder = state.client === "lazer" ? "lazer" : "stable";
  return `./default-skin/${folder}/`;
}

export function getListing(dir) {
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

export async function findImage(dirPrefix, files, name) {
  const { dir, base } = splitSkinPath(name);
  const fullDir = dirPrefix + dir;
  const listing = files || (await getListing(fullDir));
  const candidates = [`${base}@2x.png`, `${base}.png`, `${base}-0@2x.png`, `${base}-0.png`];
  if (listing) {
    const lower = new Map();
    for (const actual of listing) lower.set(actual.toLowerCase(), actual);
    for (const candidate of candidates) {
      const actual = lower.get(candidate.toLowerCase());
      if (!actual) continue;
      const img = await tryImageUrl(encodeSkinPath(fullDir + actual));
      if (img) return img;
    }
    return null;
  }
  // Listing unavailable (player skin without directory index): probe variants.
  for (const candidate of candidates) {
    const img = await tryImageUrl(encodeSkinPath(fullDir + candidate));
    if (img) return img;
  }
  return null;
}

export async function resolveImage(name, fallbackName) {
  if (!isSafeAssetName(name) || (fallbackName && !isSafeAssetName(fallbackName))) {
    console.warn("[BeatmapPreview] rejected unsafe skin asset name:", name);
    return null;
  }
  if (!settings.useSkin) return findImage(defaultSkinPrefix(), DEFAULT_SKIN_FILES, name);
  if (state.osk) {
    const oskImage = await findOskImage(name);
    if (oskImage) return oskImage;
    return findImage(defaultSkinPrefix(), DEFAULT_SKIN_FILES, fallbackName || name);
  }
  const own = await findImage("/files/skin/", null, name);
  if (own) return own;
  // Elements missing from the player skin fall back to the client default skin
  // (matches osu!stable/lazer behaviour for key counts the skin has no config for).
  return findImage(defaultSkinPrefix(), DEFAULT_SKIN_FILES, fallbackName || name);
}

export function requestImage(name, fallbackName) {
  const cacheKey = fallbackName && fallbackName !== name ? `${name}|${fallbackName}` : name;
  let entry = imageState.get(cacheKey);
  if (!entry) {
    entry = { img: null };
    imageState.set(cacheKey, entry);
    resolveImage(name, fallbackName)
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

export function defaultManiaColumnIndex(keys, column) {
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

export function maniaImageNames(keys, column) {
  const cfg = resolveManiaSource(keys).cfg;
  const index = defaultManiaColumnIndex(keys, column);
  const custom = (key) => (cfg && cfg[key] ? String(cfg[key]) : "");
  const fallback = {
    note: `mania-note${index}`,
    head: `mania-note${index}H`,
    tail: `mania-note${index}T`,
    body: `mania-note${index}L`,
    key: `mania-key${index}`
  };
  return {
    note: custom(`noteimage${column}`) || fallback.note,
    head: custom(`noteimage${column}h`) || fallback.head,
    tail: custom(`noteimage${column}t`) || fallback.tail,
    body: custom(`noteimage${column}l`) || fallback.body,
    key: custom(`keyimage${column}`) || fallback.key,
    fallbackNote: fallback.note,
    fallbackHead: fallback.head,
    fallbackTail: fallback.tail,
    fallbackBody: fallback.body,
    fallbackKey: fallback.key
  };
}

export function getColumnNames(keys, rev) {
  rev = rev !== undefined ? rev : skinContentRev();
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

export function getColumnInfo(map, layout, rev) {
  rev = rev !== undefined ? rev : skinContentRev();
  if (
    renderCache.info &&
    renderCache.infoKeys === map.keys &&
    renderCache.infoRev === rev &&
    renderCache.infoLoaded === renderCache.loadedImages
  ) {
    return renderCache.info;
  }
  const names = getColumnNames(map.keys, rev);
  const info = [];
  for (let i = 0; i < map.keys; i++) {
    const n = names[i];
    const note = requestImage(n.note, n.fallbackNote);
    const head = requestImage(n.head, n.fallbackHead);
    info.push({
      key: requestImage(n.key, n.fallbackKey),
      note,
      head,
      tail: requestImage(n.tail, n.fallbackTail) || head || note,
      body: requestImage(n.body, n.fallbackBody)
    });
  }
  info.hint = requestImage(layout.stageHint, "mania-stage-hint");
  renderCache.info = info;
  renderCache.infoKeys = map.keys;
  renderCache.infoRev = rev;
  renderCache.infoLoaded = renderCache.loadedImages;
  return info;
}

// Load the bundled default skin config (./default-skin/<client>/skin.ini) once
// per client. It is always available and is used whenever the player skin does
// not define a key count, so unconfigured key counts match the game.
export async function ensureDefaultSkin() {
  const prefix = defaultSkinPrefix();
  if (state.defaultSkinKey === prefix) return;
  state.defaultSkinKey = prefix;
  state.defaultSkin = parseSkinIni("");
  state.defaultSkinPresent = false;
  try {
    let res = await fetch(`${prefix}skin.ini`, { cache: "no-store" });
    if (!res.ok) res = await fetch(`${prefix}Skin.ini`, { cache: "no-store" });
    if (res.ok) {
      state.defaultSkin = parseSkinIni(await res.text());
      state.defaultSkinPresent = true;
    }
  } catch (err) {
    state.defaultSkinKey = "";
    console.error("[BeatmapPreview] default skin", err);
  }
  state.skinRev += 1;
}

export async function ensureSkin() {
  await ensureDefaultSkin();
  if (!settings.useSkin) return;
  if (state.client === "lazer") {
    await ensureLazerOsk();
    return;
  }
  if (state.osk) {
    releaseOsk();
    state.oskKey = "";
    imageState.clear();
  }
  if (state.skinFolder === state.loadedSkinFolder) return;
  state.loadedSkinFolder = state.skinFolder;
  imageState.clear();
  listingCache.clear();
  applySkinConfig(parseSkinIni(""), false);
  try {
    let res = await fetch("/files/skin/skin.ini", { cache: "no-store" });
    if (!res.ok) res = await fetch("/files/skin/Skin.ini", { cache: "no-store" });
    if (res.ok) applySkinConfig(parseSkinIni(await res.text()), true);
  } catch (err) {
    state.loadedSkinFolder = null;
    console.error("[BeatmapPreview] skin", err);
  }
}
