// 캔버스 렌더러: 원본 사진에 부드러운 확대·이동·전환을 적용하고 자막을 합성한다 (app/render.py 의 브라우저판).
// 사진 내용(형태·색·라벨·로고·수량)은 바꾸지 않고 크기·위치만 움직인다.

export const FONT = '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

export const DEFAULT_RENDER_SETTINGS = {
  safe_top: 0.06, safe_bottom: 0.18, safe_side: 0.06, caption_pos: "bottom", caption_offset: 0, caption_scale: 1,
  photo_mode: "fit", transition: "fade", transition_sec: 0.4, accent_color: "#FFD54A", video_disclosure: "", url_text: "",
};

export class CaptionError extends Error {}

export async function loadFonts() {
  if (!document.fonts) return;
  await Promise.all([document.fonts.load(`400 40px ${FONT}`, "가나다"), document.fonts.load(`700 40px ${FONT}`, "가나다")]);
}

const mk = (w, h) => {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  return c;
};
const meas = mk(10, 10).getContext("2d");
const fontStr = (bold, size) => `${bold ? 700 : 400} ${Math.round(size)}px ${FONT}`;
function textW(bold, size, s) { meas.font = fontStr(bold, size); return meas.measureText(s).width; }

export function wrap(text, bold, size, maxW) {
  const lines = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const w of para.split(" ")) {
      const cand = cur ? `${cur} ${w}` : w;
      if (textW(bold, size, cand) <= maxW) { cur = cand; continue; }
      if (cur) lines.push(cur);
      cur = "";
      for (const ch of w) {
        if (textW(bold, size, cur + ch) <= maxW) cur += ch;
        else { lines.push(cur); cur = ch; }
      }
    }
    lines.push(cur);
  }
  return lines;
}

function fitOneLine(text, bold, start, minimum, maxW) {
  for (let size = start; size >= minimum; size -= 2) if (textW(bold, size, text) <= maxW) return size;
  throw new CaptionError(`‘${text}’ 이(가) 너무 길어 한 줄에 들어가지 않습니다.`);
}

function roundRect(g, x, y, w, h, r, fill) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
}

function drawText(g, text, bold, size, cx, cy, color, s, stroke = true) {
  g.font = fontStr(bold, size);
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (stroke) {
    g.lineJoin = "round";
    g.lineWidth = Math.max(2, 4 * s);
    g.strokeStyle = "#000";
    g.strokeText(text, cx, cy);
  }
  g.fillStyle = color;
  g.fillText(text, cx, cy);
}

export class Layout {
  constructor(settings, W, H) {
    const st = { ...DEFAULT_RENDER_SETTINGS, ...(settings || {}) };
    this.st = st; this.W = W; this.H = H; this.s = W / 1080;
    this.top = Math.round(st.safe_top * H);
    this.bottom = Math.round((1 - st.safe_bottom) * H);
    this.side = Math.round(st.safe_side * W);
    this.capScale = +st.caption_scale || 1;
    this.pos = st.caption_pos;
    this.offset = Math.round(+st.caption_offset * H);
    this.accent = st.accent_color;
    this.badge = st.video_disclosure ? badgeImage(st.video_disclosure, this) : null;
    this.contentTop = this.top + (this.badge ? this.badge.height + Math.round(16 * this.s) : 0);
    this.reserve = Math.round(330 * this.s * this.capScale);
  }
  captionAnchor(boxH) {
    let y;
    if (this.pos === "top") y = this.contentTop + Math.round(10 * this.s);
    else if (this.pos === "middle") y = (this.H - boxH) / 2;
    else y = this.bottom - boxH;
    return Math.max(0, Math.min(this.H - boxH, y + this.offset));
  }
  photoRegion(style) {
    const x0 = Math.round(24 * this.s), x1 = this.W - x0;
    if (style === "card") return [x0, this.contentTop, x1, Math.round(this.H * 0.5)];
    const gap = Math.round(24 * this.s);
    if (this.pos === "top") return [x0, this.contentTop + this.reserve + gap + Math.max(0, this.offset), x1, this.bottom];
    if (this.pos === "middle") return [x0, this.contentTop, x1, this.bottom];
    return [x0, this.contentTop, x1, this.bottom - this.reserve - gap + Math.min(0, this.offset)];
  }
}

function badgeImage(text, lay) {
  const s = lay.s, size = 30 * s;
  const tw = textW(true, size, text);
  const px = 18 * s, py = 10 * s;
  const c = mk(Math.ceil(tw + 2 * px), Math.ceil(size * 1.25 + 2 * py));
  const g = c.getContext("2d");
  roundRect(g, 0, 0, c.width, c.height, 12 * s, "rgba(0,0,0,0.65)");
  drawText(g, text, true, size, c.width / 2, c.height / 2, "#fff", s, false);
  return c;
}

export function captionImage(text, style, lay) {
  text = (text || "").trim();
  if (!text) return null;
  const s = lay.s * lay.capScale;
  const maxW = lay.W - 2 * lay.side - 64 * s;
  const padX = 32 * s, padY = 24 * s;
  let rows; // [text, bold, size, color]
  if (style === "title") {
    const parts = text.split("\n");
    if (parts.length > 2) throw new CaptionError("제목 자막은 두 줄(브랜드명/상품명)까지만 가능합니다.");
    rows = [];
    let main = parts[0];
    if (parts.length === 2) { rows.push([parts[0], true, fitOneLine(parts[0], true, 46 * s, 34 * s, maxW), lay.accent]); main = parts[1]; }
    rows.push([main, true, fitOneLine(main, true, 86 * s, 50 * s, maxW), "#fff"]);
  } else {
    for (let size = 68 * s; size >= 46 * s; size -= 2 * s) {
      const lines = wrap(text, true, size, maxW);
      if (lines.length <= 2) { rows = lines.map((l) => [l, true, size, "#fff"]); break; }
    }
    if (!rows) throw new CaptionError("자막이 길어 두 줄에 들어가지 않습니다. 문구를 줄여 주세요.");
  }
  const hs = rows.map((r) => Math.round(r[2] * 1.3));
  const boxW = Math.ceil(Math.max(...rows.map((r) => textW(r[1], r[2], r[0]))) + 2 * padX);
  const boxH = Math.ceil(hs.reduce((a, b) => a + b, 0) + 2 * padY);
  const c = mk(boxW, boxH);
  const g = c.getContext("2d");
  roundRect(g, 0, 0, boxW, boxH, 28 * s, "rgba(0,0,0,0.59)");
  let y = padY;
  rows.forEach((r, i) => { drawText(g, r[0], r[1], r[2], boxW / 2, y + hs[i] / 2, r[3], s); y += hs[i]; });
  return c;
}

export function cardImage(brand, name, cta, urlText, lay) {
  const s = lay.s;
  const panelW = lay.W - 2 * lay.side;
  const maxW = panelW - 80 * s;
  const rows = [["text", brand, false, fitOneLine(brand, false, 50 * s, 32 * s, maxW), lay.accent]];
  let size = 84 * s, lines;
  for (; size >= 48 * s; size -= 2 * s) { lines = wrap(name, true, size, maxW); if (lines.length <= 2) break; }
  if (lines.length > 2) throw new CaptionError("상품명이 너무 길어 마무리 화면에 들어가지 않습니다.");
  lines.forEach((l) => rows.push(["text", l, true, size, "#fff"]));
  if (cta) { rows.push(["gap", 26 * s]); rows.push(["pill", cta, true, fitOneLine(cta, true, 44 * s, 30 * s, maxW - 60 * s)]); }
  if (urlText) { rows.push(["gap", 14 * s]); rows.push(["text", urlText, false, fitOneLine(urlText, false, 36 * s, 24 * s, maxW), "#e6e6e6"]); }
  let h = 112 * s;
  for (const r of rows) h += r[0] === "gap" ? r[1] : Math.round(r[3] * 1.3) + (r[0] === "pill" ? 28 * s : 0);
  const c = mk(panelW, Math.ceil(h));
  const g = c.getContext("2d");
  roundRect(g, 0, 0, panelW, c.height, 28 * s, "rgba(0,0,0,0.67)");
  let y = 56 * s;
  for (const r of rows) {
    if (r[0] === "gap") { y += r[1]; continue; }
    const lh = Math.round(r[3] * 1.3);
    if (r[0] === "pill") {
      const pw = textW(true, r[3], r[1]) + 60 * s, ph = lh + 28 * s;
      roundRect(g, (panelW - pw) / 2, y, pw, ph, ph / 2, lay.accent);
      drawText(g, r[1], true, r[3], panelW / 2, y + ph / 2, "#141414", s, false);
      y += ph;
    } else {
      drawText(g, r[1], r[2], r[3], panelW / 2, y + lh / 2, r[4], s);
      y += lh;
    }
  }
  return c;
}

/* ---------------------------------------------------------------- 사진 장면 */
const MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left"];
const smooth = (p) => { p = Math.max(0, Math.min(1, p)); return p * p * (3 - 2 * p); };

class PhotoScene {
  static async create(blob, style, motion, lay, index) {
    const sc = new PhotoScene();
    const { W, H } = lay;
    const full = await createImageBitmap(blob);
    sc.mode = lay.st.photo_mode === "fill" && style !== "card" ? "fill" : "fit";
    sc.motion = motion === "auto" ? (style === "card" ? "none" : MOTIONS[index % MOTIONS.length]) : motion;
    // 배경: 같은 사진을 꽉 채워 흐리게·어둡게
    const small = mk(Math.round(W / 4), Math.round(H / 4));
    const sg = small.getContext("2d");
    const cs = Math.max(small.width / full.width, small.height / full.height);
    sg.drawImage(full, (small.width - full.width * cs) / 2, (small.height - full.height * cs) / 2, full.width * cs, full.height * cs);
    const bg = mk(W, H);
    const bgg = bg.getContext("2d");
    bgg.filter = `blur(${Math.round(40 * lay.s)}px)`;
    bgg.drawImage(small, -20 * lay.s, -20 * lay.s, W + 40 * lay.s, H + 40 * lay.s);
    bgg.filter = "none";
    bgg.fillStyle = "rgba(0,0,0,0.45)";
    bgg.fillRect(0, 0, W, H);
    sc.bg = bg;
    if (sc.mode === "fill") {
      sc.region = [0, 0, W, H];
      const scale = Math.max(W / full.width, H / full.height) * 1.08;
      sc.src = scale < 1 ? await createImageBitmap(full, { resizeWidth: Math.ceil(full.width * scale), resizeHeight: Math.ceil(full.height * scale), resizeQuality: "high" }) : full;
      sc.baseK = Math.max(W / sc.src.width, H / sc.src.height);
      return sc;
    }
    const [x0, y0, x1, y1] = lay.photoRegion(style);
    sc.region = [x0, y0, x1, y1];
    const rw = x1 - x0, rh = y1 - y0;
    const fit = Math.min(rw / full.width, rh / full.height);
    sc.src = fit < 1 ? await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * fit)), resizeHeight: Math.max(1, Math.round(full.height * fit)), resizeQuality: "high" }) : full;
    sc.baseK = Math.min(rw / sc.src.width, rh / sc.src.height);
    const tw = sc.src.width * sc.baseK, th = sc.src.height * sc.baseK;
    const sx = x0 + (rw - tw) / 2, sy = y0 + (rh - th) / 2;
    bgg.filter = `blur(${Math.round(22 * lay.s)}px)`;
    bgg.fillStyle = "rgba(0,0,0,0.43)";
    bgg.fillRect(sx + 6 * lay.s, sy + 14 * lay.s, tw, th);
    bgg.filter = "none";
    return sc;
  }
  params(p) {
    const e = smooth(p), m = this.motion;
    if (this.mode === "fill") {
      if (m === "zoom_in") return [1 + 0.08 * e, 0];
      if (m === "zoom_out") return [1.08 - 0.08 * e, 0];
      if (m === "pan_right") return [1.07, -1 + 2 * e];
      if (m === "pan_left") return [1.07, 1 - 2 * e];
      return [1, 0];
    }
    // 맞춤: 사진을 자르지 않고 전체가 보이는 상태에서 크기·위치만 살짝 변화
    if (m === "zoom_in") return [0.92 + 0.08 * e, 0];
    if (m === "zoom_out") return [1 - 0.08 * e, 0];
    if (m === "pan_right") return [0.94, -1 + 2 * e];
    if (m === "pan_left") return [0.94, 1 - 2 * e];
    return [1, 0];
  }
  draw(g, p) {
    const [k, dx] = this.params(p);
    const [x0, y0, x1, y1] = this.region;
    const rw = x1 - x0, rh = y1 - y0;
    const K = this.baseK * k;
    const ow = this.src.width * K, oh = this.src.height * K;
    const slack = this.mode === "fit" ? Math.max(0, (rw - ow) / 2) : Math.max(0, (ow - rw) / 2);
    const cx = x0 + rw / 2 + dx * slack * 0.9, cy = y0 + rh / 2;
    g.drawImage(this.bg, 0, 0);
    g.save();
    g.beginPath(); g.rect(x0, y0, rw, rh); g.clip();
    g.imageSmoothingQuality = "high";
    g.drawImage(this.src, cx - ow / 2, cy - oh / 2, ow, oh);
    g.restore();
  }
}

/* ---------------------------------------------------------------- 타임라인 */
export class Timeline {
  static async create(scenes, photoBlobs, product, settings, W, H) {
    const tl = new Timeline();
    tl.lay = new Layout(settings, W, H);
    tl.scenes = scenes;
    tl.td = settings.transition === "none" ? 0 : +(settings.transition_sec ?? 0.4);
    tl.starts = [];
    let t = 0;
    for (const sc of scenes) { tl.starts.push(t); t += +sc.duration; }
    tl.total = t;
    tl.photo = await Promise.all(scenes.map((sc, i) => {
      const b = photoBlobs[sc.photo_id];
      if (!b) throw new Error(`${i + 1}번 장면의 사진을 찾을 수 없습니다.`);
      return PhotoScene.create(b, sc.style || "normal", sc.motion || "auto", tl.lay, i);
    }));
    tl.cues = tl.buildCues(product, settings);
    tl.tmp = mk(W, H);
    return tl;
  }
  buildCues(product, settings) {
    const cues = [];
    this.scenes.forEach((sc, i) => {
      const start = this.starts[i], end = start + +sc.duration;
      if (sc.style === "card") {
        const img = cardImage(product.brand, product.name, sc.cta || "", settings.url_text || "", this.lay);
        const y = Math.min(Math.max(Math.round(this.lay.H * 0.52), this.lay.bottom - img.height), this.lay.bottom - img.height);
        cues.push({ start, end, img, x: (this.lay.W - img.width) / 2, y, key: "card" + i });
        return;
      }
      const text = (sc.caption || "").trim();
      if (!text) return;
      const key = text + "|" + (sc.style || "normal");
      const last = cues[cues.length - 1];
      if (last && last.key === key && Math.abs(last.end - start) < 1e-6) { last.end = end; return; } // 같은 자막은 이어서 유지
      const img = captionImage(text, sc.style || "normal", this.lay);
      cues.push({ start, end, img, x: (this.lay.W - img.width) / 2, y: this.lay.captionAnchor(img.height), key });
    });
    return cues;
  }
  sceneP(i, t) {
    const dur = +this.scenes[i].duration;
    return (t - this.starts[i] + this.td / 2) / (dur + this.td);
  }
  draw(g, t, captions = true) {
    const n = this.scenes.length;
    let i = 0;
    while (i + 1 < n && t >= this.starts[i + 1]) i++;
    const half = this.td / 2;
    // 전환 구간: 앞 장면(A) 위에 뒤 장면(B)을 alpha 로 겹친다
    let A = i, B = null, alpha = 0;
    if (half > 0 && i + 1 < n && t > this.starts[i + 1] - half) { B = i + 1; alpha = smooth((t - (this.starts[i + 1] - half)) / this.td); }
    else if (half > 0 && i > 0 && t < this.starts[i] + half) { A = i - 1; B = i; alpha = smooth((t - (this.starts[i] - half)) / this.td); }
    this.photo[A].draw(g, this.sceneP(A, t));
    if (B !== null) this.blend(g, B, t, alpha);
    if (!captions) return;
    for (const c of this.cues) {
      if (t >= c.start - 0.001 && t < c.end) {
        const m = Math.max(0, Math.min(1, (t - c.start) / 0.22, (c.end - t) / 0.22));
        g.globalAlpha = m;
        g.drawImage(c.img, c.x, c.y);
        g.globalAlpha = 1;
      }
    }
    if (this.lay.badge) g.drawImage(this.lay.badge, this.lay.side, this.lay.top);
  }
  blend(g, idx, t, alpha) {
    const tg = this.tmp.getContext("2d");
    this.photo[idx].draw(tg, this.sceneP(idx, t));
    g.globalAlpha = alpha;
    g.drawImage(this.tmp, 0, 0);
    g.globalAlpha = 1;
  }
}

export function drawGuide(g, lay) {
  g.fillStyle = "rgba(255,40,40,0.28)";
  g.fillRect(0, 0, lay.W, lay.top);
  g.fillRect(0, lay.bottom, lay.W, lay.H - lay.bottom);
  g.fillRect(0, lay.top, lay.side, lay.bottom - lay.top);
  g.fillRect(lay.W - lay.side, lay.top, lay.side, lay.bottom - lay.top);
  g.font = fontStr(true, Math.max(12, 24 * lay.s));
  g.textAlign = "left"; g.textBaseline = "top"; g.fillStyle = "#fff";
  g.fillText("플랫폼 UI가 겹칠 수 있는 영역", lay.side, lay.bottom + 8 * lay.s);
}

export function validateCaptions(scenes, product, settings) {
  const lay = new Layout(settings, 1080, 1920);
  const errors = [];
  scenes.forEach((sc, i) => {
    try {
      if (sc.style === "card") cardImage(product.brand, product.name, sc.cta || "", settings.url_text || "", lay);
      else captionImage(sc.caption || "", sc.style || "normal", lay);
    } catch (e) { if (e instanceof CaptionError) errors.push(`${i + 1}번 장면: ${e.message}`); else throw e; }
  });
  if (lay.badge && lay.badge.width > 1080 - 2 * lay.side) errors.push("영상 내 광고 표시 문구가 너무 깁니다.");
  return errors;
}

export async function renderCover(tl, product, sceneIndex, coverText) {
  const lay = tl.lay, s = lay.s;
  const c = mk(lay.W, lay.H);
  const g = c.getContext("2d");
  sceneIndex = Math.max(0, Math.min(sceneIndex, tl.scenes.length - 1));
  tl.photo[sceneIndex].draw(g, 0.5);
  const maxW = lay.W - 2 * lay.side - 80 * s;
  const rows = [[product.brand, true, fitOneLine(product.brand, true, 56 * s, 34 * s, maxW), lay.accent]];
  let size = 104 * s, lines;
  for (; size >= 56 * s; size -= 4 * s) { lines = wrap(product.name, true, size, maxW); if (lines.length <= 2) break; }
  lines.slice(0, 2).forEach((l) => rows.push([l, true, size, "#fff"]));
  if (coverText) wrap(coverText, false, 46 * s, maxW).slice(0, 2).forEach((l) => rows.push([l, false, 46 * s, "#f0f0f0"]));
  const h = rows.reduce((a, r) => a + Math.round(r[2] * 1.3), 0) + 100 * s;
  const py = lay.bottom - h;
  roundRect(g, lay.side, py, lay.W - 2 * lay.side, h, 28 * s, "rgba(0,0,0,0.65)");
  let y = py + 50 * s;
  for (const r of rows) { const lh = Math.round(r[2] * 1.3); drawText(g, r[0], r[1], r[2], lay.W / 2, y + lh / 2, r[3], s); y += lh; }
  if (lay.badge) g.drawImage(lay.badge, lay.side, lay.top);
  return c.convertToBlob ? c.convertToBlob({ type: "image/jpeg", quality: 0.92 }) : new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
}
