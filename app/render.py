"""영상 렌더러: 원본 사진에 부드러운 확대·이동·전환을 적용하고 자막을 합성해 FFmpeg(H.264/AAC)로 인코딩한다.

- 사진은 '맞춤(fit)'이 기본: 제품 전체가 보이도록 비율을 유지해 배치하고, 빈 공간은 같은 사진을 흐리게 채운다.
  사진 내용(형태·색·라벨·로고·수량)은 바꾸지 않고 크기·위치만 움직인다.
- 자막은 최대 두 줄, 플랫폼 UI가 겹칠 수 있는 위·아래·좌우 안전 여백 안에 배치한다.
"""
import math
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from .config import FFMPEG, FONT_BOLD, FONT_REGULAR, VIDEO_DEFAULTS


class CaptionError(ValueError):
    pass


DEFAULT_RENDER_SETTINGS = {
    "safe_top": 0.06, "safe_bottom": 0.18, "safe_side": 0.06,
    "caption_pos": "bottom", "caption_offset": 0.0, "caption_scale": 1.0,
    "photo_mode": "fit", "transition": "fade", "transition_sec": 0.4,
    "accent_color": "#FFD54A", "video_disclosure": "", "url_text": "",
}


@lru_cache(maxsize=64)
def font(bold: bool, size: int) -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if bold else FONT_REGULAR
    if not path:
        raise RuntimeError("한국어 글꼴을 찾을 수 없습니다. assets/fonts 에 NanumGothic.ttf 를 넣어 주세요.")
    return ImageFont.truetype(path, size)


def _hex(c: str, alpha: int = 255) -> tuple:
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def text_w(f, s: str) -> float:
    return f.getlength(s)


def wrap(text: str, f, max_w: float) -> list[str]:
    """단어(공백) 단위로 줄바꿈하고, 단어 하나가 너무 길면 글자 단위로 자른다."""
    lines = []
    for para in text.split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            cand = (cur + " " + w).strip() if cur else w
            if text_w(f, cand) <= max_w:
                cur = cand
                continue
            if cur:
                lines.append(cur)
            cur = ""
            for ch in w:
                if text_w(f, cur + ch) <= max_w:
                    cur += ch
                else:
                    lines.append(cur)
                    cur = ch
        lines.append(cur)
    return lines


class Layout:
    def __init__(self, settings: dict, width: int, height: int):
        st = {**DEFAULT_RENDER_SETTINGS, **(settings or {})}
        self.st = st
        self.W, self.H = width, height
        self.s = width / 1080
        self.top = int(st["safe_top"] * height)
        self.bottom = int((1 - st["safe_bottom"]) * height)
        self.side = int(st["safe_side"] * width)
        self.cap_scale = float(st.get("caption_scale", 1.0))
        self.pos = st["caption_pos"]
        self.offset = int(float(st["caption_offset"]) * height)
        self.accent = st["accent_color"]
        self.badge = badge_image(st["video_disclosure"], self) if st.get("video_disclosure") else None
        self.content_top = self.top + (self.badge.height + int(16 * self.s) if self.badge else 0)
        self.reserve = int(330 * self.s * self.cap_scale)

    def caption_anchor(self, box_h: int) -> int:
        """자막 상자의 y(위쪽) 좌표"""
        if self.pos == "top":
            y = self.content_top + int(10 * self.s)
        elif self.pos == "middle":
            y = (self.H - box_h) // 2
        else:
            y = self.bottom - box_h
        return max(0, min(self.H - box_h, y + self.offset))

    def photo_region(self, style: str) -> tuple[int, int, int, int]:
        x0, x1 = int(24 * self.s), self.W - int(24 * self.s)
        if style == "card":
            return x0, self.content_top, x1, int(self.H * 0.50)
        gap = int(24 * self.s)
        if self.pos == "top":
            y0 = self.content_top + self.reserve + gap + max(0, self.offset)
            return x0, y0, x1, self.bottom
        if self.pos == "middle":
            return x0, self.content_top, x1, self.bottom
        y1 = self.bottom - self.reserve - gap + min(0, self.offset)
        return x0, self.content_top, x1, y1


def _panel(w: int, h: int, s: float, alpha=150) -> Image.Image:
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle((0, 0, w - 1, h - 1), radius=int(28 * s), fill=(0, 0, 0, alpha))
    return img


def badge_image(text: str, lay: "Layout") -> Image.Image:
    s = lay.s
    f = font(True, int(30 * s))
    tw = int(text_w(f, text))
    pad_x, pad_y = int(18 * s), int(10 * s)
    img = Image.new("RGBA", (tw + 2 * pad_x, int(30 * s * 1.25) + 2 * pad_y), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=int(12 * s), fill=(0, 0, 0, 165))
    d.text((pad_x, pad_y), text, font=f, fill=(255, 255, 255, 255))
    return img


def caption_image(text: str, style: str, lay: Layout) -> Image.Image | None:
    """자막 상자 이미지(RGBA). 두 줄에 들어가지 않으면 CaptionError."""
    text = (text or "").strip()
    if not text:
        return None
    s = lay.s * lay.cap_scale
    max_w = lay.W - 2 * lay.side - int(2 * 32 * s)
    pad_x, pad_y = int(32 * s), int(24 * s)
    white = (255, 255, 255, 255)
    stroke = (0, 0, 0, 255)
    if style == "title":
        parts = text.split("\n")
        if len(parts) > 2:
            raise CaptionError("제목 자막은 두 줄(브랜드명/상품명)까지만 가능합니다.")
        rows = []  # (텍스트, 글꼴, 색)
        if len(parts) == 2:
            f1 = _fit_one_line(parts[0], True, 46 * s, 34 * s, max_w)
            rows.append((parts[0], f1, _hex(lay.accent)))
            main = parts[1]
        else:
            main = parts[0]
        f2 = _fit_one_line(main, True, 86 * s, 50 * s, max_w)
        rows.append((main, f2, white))
    else:
        rows = None
        size = 68 * s
        while size >= 46 * s:
            f = font(True, int(size))
            lines = wrap(text, f, max_w)
            if len(lines) <= 2:
                rows = [(ln, f, white) for ln in lines]
                break
            size -= 2 * s
        if rows is None:
            raise CaptionError("자막이 길어 두 줄에 들어가지 않습니다. 문구를 줄여 주세요.")
    heights = [int(r[1].size * 1.3) for r in rows]
    box_w = int(max(text_w(r[1], r[0]) for r in rows)) + 2 * pad_x
    box_h = sum(heights) + 2 * pad_y
    img = _panel(box_w, box_h, s)
    d = ImageDraw.Draw(img)
    y = pad_y
    for (t, f, col), h in zip(rows, heights):
        x = (box_w - text_w(f, t)) / 2
        d.text((x, y + (h - f.size * 1.18) / 2), t, font=f, fill=col, stroke_width=max(1, int(2 * s)),
               stroke_fill=stroke)
        y += h
    return img


def _fit_one_line(text: str, bold: bool, start: float, minimum: float, max_w: float):
    size = start
    while size >= minimum:
        f = font(bold, int(size))
        if text_w(f, text) <= max_w:
            return f
        size -= 2
    raise CaptionError(f"‘{text}’ 이(가) 너무 길어 한 줄에 들어가지 않습니다.")


def card_image(brand: str, name: str, cta: str, url_text: str, lay: Layout) -> Image.Image:
    s = lay.s
    panel_w = lay.W - 2 * lay.side
    max_w = panel_w - int(80 * s)
    rows = []
    rows.append(("text", brand, _fit_one_line(brand, False, 50 * s, 32 * s, max_w), _hex(lay.accent)))
    size, name_lines, fn = 84 * s, None, None
    while size >= 48 * s:
        fn = font(True, int(size))
        name_lines = wrap(name, fn, max_w)
        if len(name_lines) <= 2:
            break
        size -= 2 * s
    if len(name_lines) > 2:
        raise CaptionError("상품명이 너무 길어 마무리 화면에 들어가지 않습니다.")
    for ln in name_lines:
        rows.append(("text", ln, fn, (255, 255, 255, 255)))
    if cta:
        rows.append(("gap", None, None, int(26 * s)))
        rows.append(("pill", cta, _fit_one_line(cta, True, 44 * s, 30 * s, max_w - int(60 * s)), None))
    if url_text:
        rows.append(("gap", None, None, int(14 * s)))
        rows.append(("text", url_text, _fit_one_line(url_text, False, 36 * s, 24 * s, max_w),
                     (230, 230, 230, 255)))
    h = int(56 * s)
    for kind, t, f, extra in rows:
        h += extra if kind == "gap" else (int(f.size * 1.3) + (int(28 * s) if kind == "pill" else 0))
    h += int(56 * s)
    img = _panel(panel_w, h, s, alpha=170)
    d = ImageDraw.Draw(img)
    y = int(56 * s)
    for kind, t, f, extra in rows:
        if kind == "gap":
            y += extra
            continue
        lh = int(f.size * 1.3)
        tw = text_w(f, t)
        if kind == "pill":
            pw, ph = tw + int(60 * s), lh + int(28 * s)
            px = (panel_w - pw) / 2
            d.rounded_rectangle((px, y, px + pw, y + ph), radius=ph / 2, fill=_hex(lay.accent))
            d.text(((panel_w - tw) / 2, y + (ph - f.size * 1.18) / 2), t, font=f, fill=(20, 20, 20, 255))
            y += ph
        else:
            d.text(((panel_w - tw) / 2, y + (lh - f.size * 1.18) / 2), t, font=f, fill=extra,
                   stroke_width=max(1, int(2 * s)), stroke_fill=(0, 0, 0, 255))
            y += lh
    return img


# ------------------------------------------------------------------ 사진 장면
MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left"]


def smooth(p: float) -> float:
    p = max(0.0, min(1.0, p))
    return p * p * (3 - 2 * p)


class PhotoScene:
    def __init__(self, photo_path: Path, style: str, motion: str, lay: Layout, index: int):
        self.lay = lay
        W, H = lay.W, lay.H
        photo = Image.open(photo_path).convert("RGB")
        self.mode = "fill" if (lay.st["photo_mode"] == "fill" and style != "card") else "fit"
        if motion == "auto":
            motion = MOTIONS[index % len(MOTIONS)] if style != "card" else "none"
        self.motion = motion
        # 배경: 같은 사진을 화면에 꽉 채워 흐리게, 어둡게
        bg = ImageOps.fit(photo, (W // 4, H // 4), Image.BILINEAR)
        bg = bg.filter(ImageFilter.GaussianBlur(10)).resize((W, H), Image.BILINEAR)
        bg = Image.eval(bg, lambda v: int(v * 0.55))
        if self.mode == "fill":
            scale = max(W / photo.width, H / photo.height)
            target = (math.ceil(photo.width * scale * 1.08), math.ceil(photo.height * scale * 1.08))
            self.src = photo.resize(target, Image.LANCZOS) if photo.width > target[0] else photo
            self.base_k = max(W / self.src.width, H / self.src.height)
            self.region = (0, 0, W, H)
            self.bg = bg
            return
        x0, y0, x1, y1 = lay.photo_region(style)
        self.region = (x0, y0, x1, y1)
        rw, rh = x1 - x0, y1 - y0
        fit = min(rw / photo.width, rh / photo.height)
        tw, th = max(1, round(photo.width * fit)), max(1, round(photo.height * fit))
        self.src = photo.resize((tw, th), Image.LANCZOS) if fit < 1 else photo
        self.src = self.src.convert("RGBA")
        self.base_k = min(rw / self.src.width, rh / self.src.height)
        # 그림자(정적)
        shadow = Image.new("L", (W, H), 0)
        sx, sy = x0 + (rw - tw) / 2, y0 + (rh - th) / 2
        ImageDraw.Draw(shadow).rectangle((sx + 6 * lay.s, sy + 14 * lay.s, sx + tw, sy + th + 10 * lay.s), fill=110)
        shadow = shadow.filter(ImageFilter.GaussianBlur(int(22 * lay.s) or 1))
        bg.paste((0, 0, 0), (0, 0), shadow)
        self.bg = bg

    def _params(self, p: float) -> tuple[float, float, float]:
        """(배율, x 이동비, y 이동비)"""
        e = smooth(p)
        m = self.motion
        if self.mode == "fill":
            if m == "zoom_in":
                return 1.0 + 0.08 * e, 0, 0
            if m == "zoom_out":
                return 1.08 - 0.08 * e, 0, 0
            if m == "pan_right":
                return 1.07, -1 + 2 * e, 0
            if m == "pan_left":
                return 1.07, 1 - 2 * e, 0
            return 1.0, 0, 0
        # 맞춤 모드: 사진을 자르지 않고 전체가 보이는 상태에서 크기·위치만 살짝 변화
        if m == "zoom_in":
            return 0.92 + 0.08 * e, 0, 0
        if m == "zoom_out":
            return 1.0 - 0.08 * e, 0, 0
        if m == "pan_right":
            return 0.94, -1 + 2 * e, 0
        if m == "pan_left":
            return 0.94, 1 - 2 * e, 0
        return 1.0, 0, 0

    def frame(self, p: float) -> Image.Image:
        k, dx, dy = self._params(p)
        x0, y0, x1, y1 = self.region
        rw, rh = x1 - x0, y1 - y0
        K = self.base_k * k
        sw, sh = self.src.size
        out_w, out_h = sw * K, sh * K
        slack_x = max(0.0, (rw - out_w) / 2) if self.mode == "fit" else max(0.0, (out_w - rw) / 2)
        slack_y = max(0.0, (rh - out_h) / 2) if self.mode == "fit" else max(0.0, (out_h - rh) / 2)
        cx = rw / 2 + dx * slack_x * 0.9
        cy = rh / 2 + dy * slack_y * 0.9
        # 출력 (x,y) → 원본 좌표
        a, c = 1 / K, sw / 2 - cx / K
        e, f = 1 / K, sh / 2 - cy / K
        frame = self.bg.copy()
        if self.mode == "fill":
            img = self.src.transform((rw, rh), Image.AFFINE, (a, 0, c, 0, e, f), Image.BILINEAR)
            frame.paste(img, (x0, y0))
        else:
            img = self.src.transform((rw, rh), Image.AFFINE, (a, 0, c, 0, e, f), Image.BILINEAR)
            frame.paste(img, (x0, y0), img)
        return frame


# ------------------------------------------------------------------ 타임라인
class Timeline:
    def __init__(self, scenes: list[dict], photo_paths: dict, product: dict, settings: dict, width: int, height: int):
        self.lay = Layout(settings, width, height)
        self.scenes = scenes
        self.td = float(settings.get("transition_sec", 0.4)) if settings.get("transition", "fade") == "fade" else 0.0
        self.starts = []
        t = 0.0
        for sc in scenes:
            self.starts.append(t)
            t += float(sc["duration"])
        self.total = t
        self._photo = {}
        self.photo_paths = photo_paths
        self.cues = self._build_cues(product, settings)

    def photo_scene(self, i: int) -> PhotoScene:
        if i not in self._photo:
            sc = self.scenes[i]
            self._photo[i] = PhotoScene(self.photo_paths[sc["photo_id"]], sc.get("style", "normal"),
                                        sc.get("motion", "auto"), self.lay, i)
            for k in list(self._photo):  # 메모리 절약: 가까운 장면만 유지
                if k < i - 1:
                    del self._photo[k]
        return self._photo[i]

    def _build_cues(self, product, settings) -> list[dict]:
        cues = []
        for i, sc in enumerate(self.scenes):
            start, end = self.starts[i], self.starts[i] + float(sc["duration"])
            if sc.get("style") == "card":
                img = card_image(product["brand"], product["name"], sc.get("cta", ""),
                                 settings.get("url_text", ""), self.lay)
                y = max(int(self.lay.H * 0.52), self.lay.bottom - img.height)
                y = min(y, self.lay.bottom - img.height)
                cues.append({"start": start, "end": end, "img": img, "pos": ((self.lay.W - img.width) // 2, y),
                             "key": ("card", i)})
                continue
            key = (sc.get("caption", "").strip(), sc.get("style", "normal"))
            if not key[0]:
                continue
            if cues and cues[-1]["key"] == key and abs(cues[-1]["end"] - start) < 1e-6:
                cues[-1]["end"] = end  # 같은 자막이 이어지면 끊지 않고 유지
                continue
            img = caption_image(key[0], key[1], self.lay)
            cues.append({"start": start, "end": end, "img": img,
                         "pos": ((self.lay.W - img.width) // 2, self.lay.caption_anchor(img.height)), "key": key})
        for c in cues:
            c["alpha"] = c["img"].split()[3]
        return cues

    def _scene_frame(self, i: int, t: float) -> Image.Image:
        dur = float(self.scenes[i]["duration"])
        local = t - self.starts[i]
        p = (local + self.td / 2) / (dur + self.td) if dur + self.td > 0 else 0
        return self.photo_scene(i).frame(p)

    def frame(self, t: float, captions: bool = True) -> Image.Image:
        n = len(self.scenes)
        i = 0
        while i + 1 < n and t >= self.starts[i + 1]:
            i += 1
        img = self._scene_frame(i, t)
        half = self.td / 2
        if half > 0:
            if i + 1 < n and t > self.starts[i + 1] - half:
                a = (t - (self.starts[i + 1] - half)) / self.td
                img = Image.blend(img, self._scene_frame(i + 1, t), smooth(a))
            elif i > 0 and t < self.starts[i] + half:
                a = (t - (self.starts[i] - half)) / self.td
                img = Image.blend(self._scene_frame(i - 1, t), img, smooth(a))
        if captions:
            for c in self.cues:
                if c["start"] - 0.001 <= t < c["end"]:
                    fade = 0.22
                    m = min(1.0, (t - c["start"]) / fade, (c["end"] - t) / fade) if fade else 1.0
                    m = max(0.0, m)
                    mask = c["alpha"] if m >= 0.999 else c["alpha"].point(lambda v, m=m: int(v * m))
                    img.paste(c["img"], c["pos"], mask)
            if self.lay.badge:
                b = self.lay.badge
                img.paste(b, (self.lay.side, self.lay.top), b)
        return img


def guide_overlay(img: Image.Image, lay: Layout) -> Image.Image:
    """미리보기용: 플랫폼 UI가 겹칠 수 있는 영역을 반투명 빨강으로 표시."""
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    red = (255, 40, 40, 70)
    d.rectangle((0, 0, lay.W, lay.top), fill=red)
    d.rectangle((0, lay.bottom, lay.W, lay.H), fill=red)
    d.rectangle((0, lay.top, lay.side, lay.bottom), fill=red)
    d.rectangle((lay.W - lay.side, lay.top, lay.W, lay.bottom), fill=red)
    f = font(True, max(12, int(24 * lay.s)))
    d.text((lay.side, lay.bottom + 8 * lay.s), "플랫폼 UI가 겹칠 수 있는 영역", font=f, fill=(255, 255, 255, 230))
    return Image.alpha_composite(img.convert("RGBA"), over).convert("RGB")


def validate_captions(scenes, product, settings) -> list[str]:
    lay = Layout(settings, 1080, 1920)
    errors = []
    for i, sc in enumerate(scenes, 1):
        try:
            if sc.get("style") == "card":
                card_image(product["brand"], product["name"], sc.get("cta", ""), settings.get("url_text", ""), lay)
            else:
                caption_image(sc.get("caption", ""), sc.get("style", "normal"), lay)
        except CaptionError as e:
            errors.append(f"{i}번 장면: {e}")
    try:
        if settings.get("video_disclosure"):
            if badge_image(settings["video_disclosure"], lay).width > 1080 - 2 * lay.side:
                errors.append("영상 내 광고 표시 문구가 너무 깁니다.")
    except Exception as e:  # noqa: BLE001
        errors.append(str(e))
    return errors


def render_video(tl: Timeline, audio_wav: Path, out_path: Path, fps: int, progress=None, log_path: Path | None = None):
    W, H = tl.lay.W, tl.lay.H
    total_frames = int(round(tl.total * fps))
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "warning",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
           "-i", str(audio_wav),
           "-map", "0:v:0", "-map", "1:a:0",
           "-c:v", VIDEO_DEFAULTS["video_codec"], "-preset", "medium", "-crf", str(VIDEO_DEFAULTS["crf"]),
           "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", str(fps), "-g", str(fps * 2),
           "-c:a", VIDEO_DEFAULTS["audio_codec"], "-b:a", VIDEO_DEFAULTS["audio_bitrate"], "-ar", "48000",
           "-movflags", "+faststart", "-t", f"{total_frames / fps:.3f}", str(out_path)]
    log = open(log_path, "wb") if log_path else subprocess.DEVNULL
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=log, stdout=subprocess.DEVNULL)
    try:
        for k in range(total_frames):
            frame = tl.frame(k / fps)
            proc.stdin.write(frame.tobytes())
            if progress and k % 15 == 0:
                progress(k / total_frames)
        proc.stdin.close()
        code = proc.wait(timeout=600)
    except BrokenPipeError:
        proc.wait(timeout=60)
        code = proc.returncode or 1
    finally:
        if log_path:
            log.close()
    if code != 0:
        detail = log_path.read_text(encoding="utf-8", errors="replace")[-600:] if log_path else ""
        raise RuntimeError(f"FFmpeg 인코딩 실패(코드 {code}). {detail}")
    if progress:
        progress(1.0)


def render_cover(tl: Timeline, product: dict, scene_index: int, cover_text: str, out_path: Path) -> None:
    scene_index = max(0, min(scene_index, len(tl.scenes) - 1))
    t = tl.starts[scene_index] + float(tl.scenes[scene_index]["duration"]) / 2
    img = tl.photo_scene(scene_index).frame(0.5).convert("RGBA")
    lay = tl.lay
    s = lay.s
    max_w = lay.W - 2 * lay.side - int(80 * s)
    rows = [(product["brand"], _fit_one_line(product["brand"], True, 56 * s, 34 * s, max_w), _hex(lay.accent))]
    fn, lines, size = None, [], 104 * s
    while size >= 56 * s:
        fn = font(True, int(size))
        lines = wrap(product["name"], fn, max_w)
        if len(lines) <= 2:
            break
        size -= 4 * s
    rows += [(ln, fn, (255, 255, 255, 255)) for ln in lines[:2]]
    if cover_text:
        ft = font(False, int(46 * s))
        for ln in wrap(cover_text, ft, max_w)[:2]:
            rows.append((ln, ft, (240, 240, 240, 255)))
    h = sum(int(r[1].size * 1.3) for r in rows) + int(100 * s)
    panel = _panel(lay.W - 2 * lay.side, h, s, alpha=165)
    d = ImageDraw.Draw(panel)
    y = int(50 * s)
    for t_, f, col in rows:
        lh = int(f.size * 1.3)
        d.text(((panel.width - text_w(f, t_)) / 2, y + (lh - f.size * 1.18) / 2), t_, font=f, fill=col,
               stroke_width=max(1, int(2 * s)), stroke_fill=(0, 0, 0, 255))
        y += lh
    py = lay.bottom - panel.height
    img.alpha_composite(panel, (lay.side, py))
    if lay.badge:
        img.alpha_composite(lay.badge, (lay.side, lay.top))
    img.convert("RGB").save(out_path, "JPEG", quality=92)


def probe(path: Path) -> dict:
    """ffmpeg -i 출력으로 코덱·해상도·길이를 확인하고, 전체 디코딩으로 손상 여부를 검사한다."""
    import re
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    info = r.stderr
    out = {"video_codec": None, "audio_codec": None, "width": None, "height": None, "fps": None, "duration": None}
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
    if m:
        out["duration"] = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
    m = re.search(r"Video: (\w+).*?, (\d{2,5})x(\d{2,5})", info)
    if m:
        out["video_codec"], out["width"], out["height"] = m[1], int(m[2]), int(m[3])
    m = re.search(r"([\d.]+) fps", info)
    if m:
        out["fps"] = float(m[1])
    m = re.search(r"Audio: (\w+)", info)
    if m:
        out["audio_codec"] = m[1]
    dec = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-f", "null", "-"], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", timeout=300)
    out["decode_errors"] = dec.stderr.strip()[:500]
    return out
