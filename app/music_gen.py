"""내장 배경음악 생성기.

외부 음원·샘플을 쓰지 않고 이 코드가 수학적으로 직접 합성한 음악만 만든다.
그래서 출처·라이선스가 분명하다(앱 내 생성 음원, CC0 1.0 으로 배포).
처음 실행 시 assets/music/ 에 WAV 와 library.json 을 만든다.
"""
import hashlib
import json
import time
import wave
from pathlib import Path

import numpy as np

SR = 44100
GENERATOR_VERSION = "1.0"

TRACKS = {
    "bright": {"title": "밝고 경쾌한 분위기 — Sunny Shelf", "mood": "밝고 경쾌한 분위기", "bpm": 112},
    "calm": {"title": "차분하고 고급스러운 분위기 — Velvet Room", "mood": "차분하고 고급스러운 분위기", "bpm": 72},
    "warm": {"title": "따뜻하고 편안한 분위기 — Cozy Morning", "mood": "따뜻하고 편안한 분위기", "bpm": 88},
}

LICENSE_TEXT = ("클립 상품영상 스튜디오가 코드로 직접 합성한 음원입니다. 외부 음원·샘플·루프를 사용하지 않았습니다. "
                "CC0 1.0(퍼블릭 도메인 헌정)으로 제공되어 상업적 이용과 결과 영상 배포가 허용됩니다.")

NOTE = {n: i for i, n in enumerate(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])}


def hz(name: str, octave: int) -> float:
    midi = 12 * (octave + 1) + NOTE[name]
    return 440.0 * 2 ** ((midi - 69) / 12)


def chord(root: str, octave: int, intervals) -> list[float]:
    base = 12 * (octave + 1) + NOTE[root]
    return [440.0 * 2 ** ((base + i - 69) / 12) for i in intervals]


def env(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    e = np.full(n, s, dtype=np.float32)
    if a_n:
        e[:min(a_n, n)] = np.linspace(0, 1, a_n, dtype=np.float32)[:n]
    if d_n and a_n < n:
        seg = np.linspace(1, s, d_n, dtype=np.float32)
        e[a_n:a_n + d_n] = seg[:max(0, n - a_n)]
    if r_n:
        r_n = min(r_n, n)
        e[-r_n:] *= np.linspace(1, 0, r_n, dtype=np.float32)
    return e


def tone(freq: float, dur: float, harmonics=(1.0,), decay: float | None = None, detune=0.0,
         a=0.005, d=0.1, s=0.7, r=0.05) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float32) / SR
    sig = np.zeros(n, dtype=np.float32)
    for k, amp in enumerate(harmonics, 1):
        f = freq * k
        if f > SR / 2.2:
            break
        sig += amp * np.sin(2 * np.pi * f * t)
        if detune:
            sig += amp * 0.6 * np.sin(2 * np.pi * f * (1 + detune) * t + 0.7)
    sig *= env(n, a, d, s, r)
    if decay:
        sig *= np.exp(-t / decay).astype(np.float32)
    return sig


def kick(dur=0.35, level=1.0):
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float32) / SR
    f = 45 + 80 * np.exp(-t * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return level * np.sin(ph) * np.exp(-t * 9)


def noise_hit(dur, decay, rng, hp=True, level=1.0):
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float32) / SR
    x = rng.standard_normal(n).astype(np.float32)
    if hp:
        x = np.diff(x, prepend=0)
    return level * x * np.exp(-t / decay)


def place(buf: np.ndarray, sig: np.ndarray, start_sec: float, pan: float = 0.0, gain: float = 1.0):
    i = int(start_sec * SR) % buf.shape[0]
    l, r = gain * (1 - max(0, pan)), gain * (1 + min(0, pan))
    end = i + len(sig)
    if end <= buf.shape[0]:
        buf[i:end, 0] += sig * l
        buf[i:end, 1] += sig * r
    else:  # 루프 끝을 넘으면 앞으로 감싸 이어 붙인다(이음새 없는 반복)
        k = buf.shape[0] - i
        buf[i:, 0] += sig[:k] * l
        buf[i:, 1] += sig[:k] * r
        buf[:end - buf.shape[0], 0] += sig[k:] * l
        buf[:end - buf.shape[0], 1] += sig[k:] * r


def reverb(buf: np.ndarray, seconds=1.6, mix=0.22, seed=7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = buf.copy()
    L = buf.shape[0]
    for ch in range(2):
        ir = rng.standard_normal(n) * np.exp(-t * 4.5)
        ir[:int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        size = 1 << int(np.ceil(np.log2(L + n)))
        wet = np.fft.irfft(np.fft.rfft(buf[:, ch], size) * np.fft.rfft(ir, size), size)[:L + n]
        wet[:n] += wet[L:L + n]  # 꼬리를 앞으로 감싸 루프 이음새 제거
        out[:, ch] += mix * wet[:L].astype(np.float32)
    return out


def make_bright(rng) -> np.ndarray:
    bpm = TRACKS["bright"]["bpm"]
    beat = 60 / bpm
    bars = 16
    buf = np.zeros((int(bars * 4 * beat * SR), 2), dtype=np.float32)
    prog = [("C", [0, 4, 7, 11]), ("G", [0, 4, 7, 9]), ("A", [0, 3, 7, 10]), ("F", [0, 4, 7, 9])]
    for bar in range(bars):
        root, iv = prog[bar % 4]
        t0 = bar * 4 * beat
        notes = chord(root, 4, iv)
        # 패드
        for f in chord(root, 3, iv[:3]):
            place(buf, tone(f, 4 * beat, (1, .35, .15), detune=0.004, a=0.3, d=0.5, s=0.6, r=0.4), t0, 0, 0.05)
        # 플럭 아르페지오(16분음표)
        for k in range(16):
            f = notes[[0, 1, 2, 3, 2, 1, 2, 3][k % 8]] * (2 if k % 8 == 3 else 1)
            place(buf, tone(f, beat / 2, (1, .5, .25, .12), decay=0.12, a=0.002, s=1, r=0.02),
                  t0 + k * beat / 4, -0.3 if k % 2 else 0.3, 0.06)
        # 베이스(8분음표)
        bf = hz(root, 2)
        for k in range(8):
            place(buf, tone(bf, beat / 2 * 0.9, (1, .4, .1), decay=0.25, a=0.004, s=1, r=0.03), t0 + k * beat / 2, 0, 0.16)
        # 드럼
        for k in range(4):
            place(buf, kick(), t0 + k * beat, 0, 0.5)
            if k in (1, 3):
                place(buf, noise_hit(0.2, 0.05, rng, level=1), t0 + k * beat, 0, 0.12)
        for k in range(8):
            place(buf, noise_hit(0.06, 0.012, rng), t0 + k * beat / 2, 0.4 if k % 2 else -0.2,
                  0.05 if k % 2 else 0.03)
    return reverb(buf, 1.2, 0.15)


def make_calm(rng) -> np.ndarray:
    bpm = TRACKS["calm"]["bpm"]
    beat = 60 / bpm
    bars = 10
    buf = np.zeros((int(bars * 4 * beat * SR), 2), dtype=np.float32)
    prog = [("D", 3, [0, 4, 7, 11, 14]), ("B", 2, [0, 3, 7, 10, 14]), ("G", 2, [0, 4, 7, 11, 14]),
            ("A", 2, [0, 5, 7, 10, 14])]
    piano = (1, .45, .25, .12, .06)
    for bar in range(bars):
        root, octv, iv = prog[bar % 4]
        t0 = bar * 4 * beat
        notes = chord(root, octv + 1, iv)
        for f in chord(root, octv + 1, iv[:4]):
            place(buf, tone(f, 4 * beat + 0.5, (1, .2), detune=0.003, a=1.2, d=1, s=0.7, r=1.0), t0, 0, 0.035)
        # 부드러운 피아노 펼침화음
        pattern = [0, 2, 3, 4, 3, 2, 1, 2]
        for k, idx in enumerate(pattern):
            place(buf, tone(notes[idx], 2.2, piano, decay=0.9, a=0.004, s=1, r=0.3),
                  t0 + k * beat / 2, -0.35 + 0.1 * idx, 0.05 if k else 0.065)
        place(buf, tone(hz(root, 1 if root in "AB" else 2), 4 * beat, (1, .3), a=0.05, d=0.4, s=0.8, r=0.5),
              t0, 0, 0.13)
        for k in range(8):  # 아주 작은 셰이커
            place(buf, noise_hit(0.08, 0.02, rng), t0 + k * beat / 2, 0.5, 0.012 if k % 2 else 0.02)
    return reverb(buf, 2.4, 0.32)


def make_warm(rng) -> np.ndarray:
    bpm = TRACKS["warm"]["bpm"]
    beat = 60 / bpm
    bars = 12
    buf = np.zeros((int(bars * 4 * beat * SR), 2), dtype=np.float32)
    prog = [("F", [0, 4, 7, 11]), ("D", [0, 3, 7, 10]), ("A#", [0, 4, 7, 11]), ("C", [0, 4, 7, 10])]
    rhodes = (1, .3, .08, .04)
    for bar in range(bars):
        root, iv = prog[bar % 4]
        t0 = bar * 4 * beat
        voicing = chord(root, 3 if root in "FDC" else 2, iv)
        for hit, length in ((0, 1.5), (1.5, 1.0), (2.5, 1.5)):
            for j, f in enumerate(voicing):
                place(buf, tone(f, length * beat + 0.4, rhodes, decay=1.2, detune=0.002, a=0.006, s=1, r=0.25),
                      t0 + hit * beat + j * 0.012, -0.2 + 0.13 * j, 0.045)
        bf = hz(root, 2) if root in "CD" else hz(root, 1)
        for hit in (0, 1.5, 2, 3):
            place(buf, tone(bf, beat * 0.9, (1, .25), decay=0.4, a=0.006, s=1, r=0.05), t0 + hit * beat, 0, 0.17)
        place(buf, kick(level=0.8), t0, 0, 0.42)
        place(buf, kick(level=0.8), t0 + 2.5 * beat, 0, 0.32)
        for k in range(4):
            place(buf, noise_hit(0.25, 0.07, rng, level=1), t0 + k * beat + beat / 2, 0.3, 0.03)
            if k in (1, 3):
                place(buf, noise_hit(0.3, 0.09, rng), t0 + k * beat, -0.1, 0.06)
    return reverb(buf, 1.8, 0.25)


def _normalize(buf: np.ndarray, peak=0.8) -> np.ndarray:
    buf = buf - buf.mean(axis=0)
    m = np.max(np.abs(buf)) or 1
    return buf * (peak / m)


def write_wav(path: Path, buf: np.ndarray) -> None:
    pcm = (np.clip(buf, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def ensure_library(lib_dir: Path) -> list[dict]:
    lib_dir.mkdir(parents=True, exist_ok=True)
    meta_path = lib_dir / "library.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if all((lib_dir / m["file"]).exists() for m in meta) and len(meta) == len(TRACKS):
            return meta
    makers = {"bright": make_bright, "calm": make_calm, "warm": make_warm}
    meta = []
    for key, info in TRACKS.items():
        rng = np.random.default_rng({'bright': 11, 'calm': 23, 'warm': 37}[key])
        buf = _normalize(makers[key](rng))
        path = lib_dir / f"{key}.wav"
        write_wav(path, buf)
        meta.append({
            "id": key, "file": path.name, "title": info["title"], "mood": info["mood"], "bpm": info["bpm"],
            "duration": round(buf.shape[0] / SR, 2),
            "source": f"클립 상품영상 스튜디오 내장 생성기 (app/music_gen.py v{GENERATOR_VERSION})",
            "license": "CC0 1.0",
            "license_note": LICENSE_TEXT,
            "commercial_use": True,
            "redistribution_in_video": True,
            "created": time.strftime("%Y-%m-%d"),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "builtin": True,
        })
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta
