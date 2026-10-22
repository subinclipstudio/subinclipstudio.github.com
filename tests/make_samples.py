"""테스트용 가상 상품 사진 10장 생성 (실제 상품 아님). tests/samples/ 에 저장."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import FONT_BOLD, FONT_REGULAR  # noqa: E402

OUT = Path(__file__).resolve().parent / "samples"


def f(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def gradient(w, h, top, bottom):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3)))
    return img


def tumbler(d, cx, base_y, height, color=(70, 120, 160), label=True):
    w = height * 0.38
    top = base_y - height
    d.rounded_rectangle((cx - w / 2, top + height * 0.12, cx + w / 2, base_y), radius=w * 0.15, fill=color,
                        outline=(30, 40, 50), width=4)
    d.rounded_rectangle((cx - w * 0.54, top, cx + w * 0.54, top + height * 0.15), radius=w * 0.08,
                        fill=(40, 40, 45))
    if label:
        lw = w * 0.8
        d.rectangle((cx - lw / 2, top + height * 0.45, cx + lw / 2, top + height * 0.7), fill=(245, 240, 230))
        fs = int(height * 0.06)
        d.text((cx, top + height * 0.53), "TESTBRAND", font=f(fs, True), fill=(30, 30, 30), anchor="mm")
        d.text((cx, top + height * 0.63), "500ml", font=f(int(fs * 0.8)), fill=(80, 80, 80), anchor="mm")


def main():
    OUT.mkdir(exist_ok=True)
    specs = [
        ("01_hero_square.jpg", (1600, 1600)), ("02_detail_43.jpg", (1600, 1200)), ("03_usage_34.jpg", (1200, 1600)),
        ("04_package_169.jpg", (1920, 1080)), ("05_hero2.jpg", (1400, 1400)), ("06_detail2.jpg", (1500, 1000)),
        ("07_usage2.jpg", (1080, 1920)), ("08_other.jpg", (1600, 1200)), ("09_color.jpg", (1600, 1600)),
        ("10_set.jpg", (2000, 1300)),
    ]
    for i, (name, (w, h)) in enumerate(specs):
        img = gradient(w, h, (235 - i * 8, 230 - i * 3, 220), (180, 190 - i * 5, 205 + i * 4))
        d = ImageDraw.Draw(img)
        if "package" in name:
            d.rectangle((w * 0.3, h * 0.2, w * 0.7, h * 0.85), fill=(200, 160, 110), outline=(120, 90, 60), width=6)
            d.text((w * 0.5, h * 0.5), "TESTBRAND\n텀블러 500ml", font=f(int(h * 0.07), True), fill=(60, 40, 20),
                   anchor="mm", align="center")
        elif "detail" in name:
            d.ellipse((w * 0.2, h * 0.15, w * 0.8, h * 0.95), fill=(40, 40, 45))
            d.ellipse((w * 0.35, h * 0.35, w * 0.65, h * 0.75), fill=(90, 90, 100))
            d.text((w * 0.5, h * 0.55), "LOCK", font=f(int(h * 0.08), True), fill=(230, 230, 230), anchor="mm")
        elif "usage" in name:
            d.rectangle((0, h * 0.7, w, h), fill=(150, 110, 80))
            d.rectangle((w * 0.05, h * 0.5, w * 0.5, h * 0.72), fill=(60, 60, 70))
            tumbler(d, w * 0.72, h * 0.75, h * 0.45)
        elif "set" in name:
            for k, col in enumerate([(70, 120, 160), (180, 90, 90), (90, 150, 100)]):
                tumbler(d, w * (0.25 + 0.25 * k), h * 0.9, h * 0.7, col)
        else:
            tumbler(d, w * 0.5, h * 0.92, h * 0.8, (70 + i * 10, 120, 160 - i * 5))
        d.text((20, 20), f"SAMPLE {i + 1:02d} (테스트용 가상 이미지)", font=f(int(min(w, h) * 0.03)), fill=(20, 20, 20))
        img.save(OUT / name, quality=92)
    print("saved", len(specs), "to", OUT)


if __name__ == "__main__":
    main()
