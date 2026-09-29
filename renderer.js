// renderer.js - canvas drawing: static lane layer, falling notes and the
// viewport mapping.
import { clamp, num, findFirstGE, STAGE_SIZE, DEFAULT_HIT_POSITION, SCROLL_TIME_REFERENCE_MS, SPAWN_MARGIN, NOTE_VIEW_MARGIN, NOTE_BODY_MAX_TILES, DEFAULT_NOTE_ASPECT, NOTE_LOOKBACK_MS, MANIA_FALLBACK, settings, state, renderCache } from "./shared.js";
import { getManiaLayout, getColumnInfo } from "./skin.js";
import { getScroll } from "./beatmap.js";

export function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function drawImage2(ctx, img, cx, cy, w, h, flipY) {
  if (!img) return false;
  if (flipY) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, -1);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }
  return true;
}

export function noteDrawHeight(img, heightScale) {
  const ratio = img ? img.height / Math.max(1, img.width) : DEFAULT_NOTE_ASPECT;
  return Math.max(1, heightScale * ratio);
}

export function drawManiaStatic(g, layout, info) {
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
  const stageRight = lastCol ? lastCol.x + lastCol.w : STAGE_SIZE;
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

export function stageBounds(layout) {
  if (layout.cols.length) {
    // tight bounds around the actual columns so the stage is centred in the
    // counter regardless of the skin's ColumnStart
    const first = layout.cols[0];
    const last = layout.cols[layout.cols.length - 1];
    return { x: first.x, y: 0, w: Math.max(1, last.x + last.w - first.x), h: STAGE_SIZE };
  }
  return { x: 0, y: 0, w: STAGE_SIZE, h: STAGE_SIZE };
}

export function getStaticLayer(layout, info, view, layerScale) {
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

export function drawHoldBody(ctx, ci, style, colX, colW, yHead, yTail, visTop, visBottom) {
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
  const maxTiles = NOTE_BODY_MAX_TILES;
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

export function visibleStartIndex(map, scroll, now, t) {
  const notes = map.notes;
  if (renderCache.cursorMap !== map || t < renderCache.cursorTime - 1500) {
    renderCache.cursorMap = map;
    renderCache.cursor = Math.max(0, findFirstGE(notes, t - NOTE_LOOKBACK_MS, (n) => n.time));
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

export function notePassedLine(note, yHead, yTail, hitPosition) {
  // normal notes vanish once their leading (bottom) edge reaches the judgement
  // line; hold notes stay visible until their tail does
  return (note.hold ? yTail : yHead) > hitPosition;
}

export function renderMania(ctx, map, t, scale, rev) {
  if (!map.notes || !map.notes.length) return;
  const layout = getManiaLayout(map.keys, rev);
  const hitPosition = layout.hitPosition;
  const speed = num(settings.maniaScrollSpeedOverride, 0) > 0 ? num(settings.maniaScrollSpeedOverride, 0) : clamp(state.maniaScrollSpeed || 5, 1, 40);
  const timeRange = (SCROLL_TIME_REFERENCE_MS / speed) * (hitPosition / DEFAULT_HIT_POSITION);
  const scroll = getScroll(map, timeRange);
  const now = scroll.at(t);
  const opacity = clamp(num(settings.playfieldOpacity, 1), 0, 1);
  const info = getColumnInfo(map, layout, rev);

  const layerScale = clamp(Number.isFinite(scale) ? scale : 1, 1, 4);
  const view = stageBounds(layout);
  const layer = getStaticLayer(layout, info, view, Math.round(layerScale * 2) / 2);
  ctx.globalAlpha = opacity;
  ctx.drawImage(layer, view.x, view.y, view.w, view.h);
  ctx.globalAlpha = 1;

  // Clip the falling notes to the play area: nothing may be drawn past the
  // judgement line (the lane / key images below it belong to the static layer).
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, Math.max(0, hitPosition - view.y));
  ctx.clip();

  const start = visibleStartIndex(map, scroll, now, t);
  ctx.globalAlpha = opacity;
  for (let i = start; i < map.notes.length; i++) {
    const note = map.notes[i];
    const fracHead = scroll.at(note.time) - now;
    if (fracHead > SPAWN_MARGIN) break;
    const fracTail = note.hold ? scroll.at(note.endTime) - now : fracHead;
    const yHead = hitPosition - fracHead * hitPosition;
    const yTail = hitPosition - fracTail * hitPosition;
    if (notePassedLine(note, yHead, yTail, hitPosition)) continue;
    if (Math.max(yHead, yTail) < -NOTE_VIEW_MARGIN) continue;
    const col = layout.cols[note.column];
    if (!col) continue;
    const ci = info[note.column];
    if (!ci) continue;
    const heightScale = layout.noteHeightScale > 0 ? layout.noteHeightScale : col.w;
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
    if (head) {
      const height = noteDrawHeight(head, heightScale);
      drawImage2(ctx, head, cx, yHead - height / 2, col.w, height);
    } else {
      const height = noteDrawHeight(null, heightScale);
      ctx.fillStyle = MANIA_FALLBACK[note.column % MANIA_FALLBACK.length];
      ctx.fillRect(col.x, yHead - height, col.w, height);
    }
    if (note.hold && ci.tail) {
      const height = noteDrawHeight(ci.tail, heightScale);
      drawImage2(ctx, ci.tail, cx, yTail + height / 2, col.w, height, true);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function currentViewport(width, height, view) {
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
