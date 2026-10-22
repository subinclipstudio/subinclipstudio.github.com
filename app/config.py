"""앱 전역 설정: 경로, 환경 변수, FFmpeg·글꼴 위치, 기본 제작값."""
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PRODUCTS_DIR = DATA / "products"
UPLOADED_MUSIC_DIR = DATA / "music"
TMP_DIR = DATA / "tmp"
MUSIC_LIB_DIR = ROOT / "assets" / "music"
STATIC_DIR = ROOT / "static"

for d in (PRODUCTS_DIR, UPLOADED_MUSIC_DIR, TMP_DIR, MUSIC_LIB_DIR):
    d.mkdir(parents=True, exist_ok=True)


def _load_dotenv() -> None:
    """.env 파일의 KEY=VALUE 를 환경 변수로 읽는다(이미 설정된 값은 덮어쓰지 않음)."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _find_ffmpeg() -> str | None:
    if os.environ.get("FFMPEG_PATH"):
        return os.environ["FFMPEG_PATH"]
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG = _find_ffmpeg()


def _find_font(candidates: list[str]) -> str | None:
    custom_dirs = [ROOT / "assets" / "fonts"]
    win_fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    search = custom_dirs + [win_fonts, Path("/usr/share/fonts/truetype/nanum"), Path("/Library/Fonts"),
                            Path("/System/Library/Fonts")]
    for name in candidates:
        for d in search:
            p = d / name
            if p.exists():
                return str(p)
    return None


FONT_REGULAR = os.environ.get("FONT_REGULAR") or _find_font(
    ["NanumGothic.ttf", "malgun.ttf", "AppleSDGothicNeo.ttc", "NotoSansKR-Regular.otf"])
FONT_BOLD = os.environ.get("FONT_BOLD") or _find_font(
    ["NanumGothicBold.ttf", "malgunbd.ttf", "AppleSDGothicNeo.ttc", "NotoSansKR-Bold.otf"]) or FONT_REGULAR

# 외부 API 키 — 서버에서만 읽고 브라우저로 보내지 않는다.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
VISION_MODEL = os.environ.get("VISION_MODEL", "claude-opus-5-5")
CLOVA_CLIENT_ID = os.environ.get("NCP_CLOVA_CLIENT_ID", "")
CLOVA_CLIENT_SECRET = os.environ.get("NCP_CLOVA_CLIENT_SECRET", "")
CLOVA_TTS_URL = os.environ.get("CLOVA_TTS_URL", "https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts")
CLOVA_SPEAKER = os.environ.get("CLOVA_SPEAKER", "nara")

# 앱 기본 제작값 (네이버 공식 업로드 요건이 아님 — 최신 공식 안내를 확인해 조정)
VIDEO_DEFAULTS = {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "duration": 25,
    "duration_options": [15, 25, 35],
    "video_codec": "libx264",
    "audio_codec": "aac",
    "audio_bitrate": "192k",
    "crf": 20,
}

PHOTO_MIN = 5
PHOTO_MAX = 10
FEATURE_MIN = 1
FEATURE_MAX = 3
POST_LIMIT = 300
