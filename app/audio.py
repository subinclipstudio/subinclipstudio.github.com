"""배경음악 라이브러리와 오디오 믹싱(음악 반복·페이드·내레이션 구간 자동 볼륨 낮춤)."""
import json
import subprocess
import time
import wave
from pathlib import Path

import numpy as np

from .config import FFMPEG, MUSIC_LIB_DIR, UPLOADED_MUSIC_DIR
from . import music_gen

SR = 48000
MOODS = {"bright": "밝고 경쾌한 분위기", "calm": "차분하고 고급스러운 분위기", "warm": "따뜻하고 편안한 분위기",
         "none": "음악 없음"}


def library() -> list[dict]:
    """사용 가능한 음악 목록(내장 + 업로드). 파일이 실제로 있는 것만."""
    items = []
    try:
        for m in music_gen.ensure_library(MUSIC_LIB_DIR):
            if (MUSIC_LIB_DIR / m["file"]).exists():
                items.append({**m, "path": str(MUSIC_LIB_DIR / m["file"])})
    except Exception:
        pass
    meta_path = UPLOADED_MUSIC_DIR / "uploads.json"
    if meta_path.exists():
        for m in json.loads(meta_path.read_text(encoding="utf-8")):
            if (UPLOADED_MUSIC_DIR / m["file"]).exists():
                items.append({**m, "path": str(UPLOADED_MUSIC_DIR / m["file"])})
    return items


def public_library() -> list[dict]:
    return [{k: v for k, v in m.items() if k != "path"} for m in library()]


def find_track(track_id: str) -> dict | None:
    return next((m for m in library() if m["id"] == track_id), None)


def save_upload(filename: str, raw: bytes, title: str, source: str, license_name: str, confirmed: bool) -> dict:
    if not confirmed:
        raise ValueError("상업적 이용과 결과 영상 배포가 허용된 음악인지 확인해 주세요.")
    if not source.strip() or not license_name.strip():
        raise ValueError("음악 출처와 라이선스 정보를 입력해 주세요.")
    ext = Path(filename).suffix.lower()
    if ext not in (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"):
        raise ValueError("mp3, wav, m4a, aac, ogg, flac 파일만 올릴 수 있습니다.")
    import uuid
    mid = "up_" + uuid.uuid4().hex[:10]
    path = UPLOADED_MUSIC_DIR / f"{mid}{ext}"
    path.write_bytes(raw)
    try:
        dur = len(decode(path)) / SR
    except Exception:
        path.unlink(missing_ok=True)
        raise ValueError("음악 파일을 읽을 수 없습니다.")
    meta_path = UPLOADED_MUSIC_DIR / "uploads.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else []
    item = {"id": mid, "file": path.name, "title": title.strip() or Path(filename).stem, "mood": "업로드한 음악",
            "duration": round(dur, 2), "source": source.strip(), "license": license_name.strip(),
            "license_note": "사용자가 업로드하며 상업적 이용·결과 영상 배포 허용을 확인함",
            "commercial_use": True, "redistribution_in_video": True, "created": time.strftime("%Y-%m-%d"),
            "builtin": False, "original_name": filename}
    meta.append(item)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return item


def decode(path: Path) -> np.ndarray:
    """오디오 파일 → float32 (n, 2) @48kHz"""
    r = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
                       capture_output=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError("오디오 디코딩 실패: " + r.stderr.decode("utf-8", "replace")[:200])
    return np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).copy()


def _db(v: float) -> float:
    return float(10 ** (v / 20))


def _loop_to(x: np.ndarray, n: int, xfade: int) -> np.ndarray:
    """x 를 n 샘플 길이로 반복. 내장 음원은 마디 단위로 이음새 없이 만들어져 xfade=0 으로 그대로 잇는다."""
    if len(x) >= n:
        return x[:n].copy()
    xfade = min(xfade, len(x) // 4)
    out = np.zeros((n + len(x), 2), dtype=np.float32)
    out[:len(x)] = x
    pos = len(x)
    up = np.linspace(0, 1, xfade, dtype=np.float32)[:, None]
    while pos < n:
        start = pos - xfade
        seg = x.copy()
        if xfade:
            out[start:pos] *= 1 - up
            seg[:xfade] *= up
        out[start:start + len(x)] += seg
        pos = start + len(x)
    return out[:n]


def mix(duration: float, out_wav: Path, music: dict | None, narrations: list[tuple[float, float, Path]],
        settings: dict) -> dict:
    """narrations: (시작초, 허용 길이초, 파일). 결과 정보 dict 반환."""
    n = int(round(duration * SR))
    master = np.zeros((n, 2), dtype=np.float32)
    info = {"music": None, "narration_clips": 0, "warnings": []}
    duck = np.ones(n, dtype=np.float32)

    narr_gain = _db(float(settings.get("narration_gain_db", 0)))
    voice_track = np.zeros((n, 2), dtype=np.float32)
    for start, allowed, path in narrations:
        clip = decode(path) * narr_gain
        # 앞뒤 무음 제거
        mag = np.abs(clip).max(axis=1)
        nz = np.nonzero(mag > 0.01)[0]
        if len(nz):
            clip = clip[max(0, nz[0] - 800): nz[-1] + 2400]
        max_len = int(allowed * SR)
        if len(clip) > max_len:
            info["warnings"].append(f"{start:.1f}초 내레이션이 장면보다 {len(clip) / SR - allowed:.1f}초 길어 끝을 줄였습니다. "
                                    "내레이션 문구를 줄이거나 장면 길이를 늘리세요.")
            clip = clip[:max_len]
            fade = min(len(clip), SR // 5)
            clip[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)[:, None]
        s = int(start * SR)
        e = min(n, s + len(clip))
        voice_track[s:e] += clip[:e - s]
        a, r = int(0.15 * SR), int(0.4 * SR)
        duck[max(0, s - a):min(n, e + r)] = 0  # 표시만, 아래에서 부드럽게
        info["narration_clips"] += 1

    if music:
        x = decode(Path(music["path"]))
        bed = _loop_to(x, n, 0 if music.get("builtin") else SR // 2) * _db(float(settings.get("music_gain_db", -6)))
        fi = int(float(settings.get("fade_in", 1.0)) * SR)
        fo = int(float(settings.get("fade_out", 2.0)) * SR)
        if fi > 0:
            bed[:fi] *= np.linspace(0, 1, fi, dtype=np.float32)[:, None]
        if fo > 0:
            bed[-fo:] *= np.linspace(1, 0, fo, dtype=np.float32)[:, None]
        if info["narration_clips"]:
            level = _db(float(settings.get("duck_db", -12)))
            target = np.where(duck == 0, level, 1.0).astype(np.float32)
            # 0.25초 이동 평균으로 볼륨 변화를 부드럽게
            k = int(0.25 * SR)
            kernel = np.ones(k, dtype=np.float32) / k
            smooth = np.convolve(target, kernel, mode="same").astype(np.float32)
            bed *= smooth[:, None]
        master += bed
        info["music"] = {k: music[k] for k in ("id", "title", "source", "license") if k in music}
    master += voice_track
    master *= _db(float(settings.get("master_gain_db", 0)))
    peak = float(np.abs(master).max()) if n else 0
    if peak > 0.98:
        master *= 0.98 / peak
        info["warnings"].append("음량이 커서 전체 볼륨을 자동으로 낮췄습니다.")
    end_fade = int(0.3 * SR)
    master[-end_fade:] *= np.linspace(1, 0, end_fade, dtype=np.float32)[:, None]
    pcm = (np.clip(master, -1, 1) * 32767).astype("<i2")
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    info["silent"] = info["music"] is None and info["narration_clips"] == 0
    return info


def speech_length(path: Path) -> float:
    """앞뒤 무음을 뺀 실제 발화 길이(초)"""
    clip = decode(path)
    nz = np.nonzero(np.abs(clip).max(axis=1) > 0.01)[0]
    return (nz[-1] - nz[0]) / SR if len(nz) else 0.0


def speed_up(src: Path, dst: Path, factor: float) -> Path:
    """음높이를 유지한 채 재생 속도만 높인다(atempo)."""
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(src), "-filter:a", f"atempo={factor:.3f}", str(dst)],
                       capture_output=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError("내레이션 속도 조절 실패")
    return dst
