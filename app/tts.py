"""한국어 내레이션(TTS) 제공자.

- windows: Windows 내장 음성(Microsoft Heami 등, System.Speech). 로컬 실행·무료. 설치된 경우에만 '연결됨'.
- clova:   NAVER CLOVA Voice (NCP, 유료). .env 에 키가 있을 때만 시도하며, 실제 호출이 성공해야 '연결 확인'으로 표시.
연결되지 않은 제공자로는 음성을 만들지 않는다(음성이 생성된 것처럼 표시하지 않음).
"""
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import httpx

from .config import CLOVA_CLIENT_ID, CLOVA_CLIENT_SECRET, CLOVA_SPEAKER, CLOVA_TTS_URL, TMP_DIR

_PS_SCRIPT = r"""
param([string]$TextFile, [string]$OutFile, [int]$Rate, [string]$Voice)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) { $s.SelectVoice($Voice) }
$s.Rate = $Rate
$s.SetOutputToWaveFile($OutFile)
$t = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$s.Speak($t)
$s.Dispose()
"""

_LIST_SCRIPT = r"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }
"""

_status_cache: dict = {}
_clova_verified = {"ok": None, "error": ""}
_lock = threading.Lock()


def _powershell() -> str | None:
    if sys.platform != "win32":
        return None
    return shutil.which("powershell") or shutil.which("pwsh")


def windows_voices() -> list[str]:
    if "win_voices" in _status_cache:
        return _status_cache["win_voices"]
    voices = []
    ps = _powershell()
    if ps:
        try:
            out = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", _LIST_SCRIPT],
                                 capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace")
            for line in out.stdout.splitlines():
                name, _, culture = line.strip().partition("|")
                if culture.lower().startswith("ko"):
                    voices.append(name)
        except Exception:
            pass
    _status_cache["win_voices"] = voices
    return voices


def status() -> dict:
    win = windows_voices()
    providers = [{
        "id": "windows", "label": "Windows 내장 한국어 음성", "connected": bool(win),
        "voices": win, "paid": False,
        "detail": ("로컬에서 무료로 생성합니다. 음질은 기본 수준입니다." if win
                   else "이 PC에 한국어 Windows 음성이 없습니다. (설정 > 시간 및 언어 > 음성에서 한국어 음성 설치)"),
    }]
    if CLOVA_CLIENT_ID and CLOVA_CLIENT_SECRET:
        ok = _clova_verified["ok"]
        providers.append({
            "id": "clova", "label": "NAVER CLOVA Voice (유료)", "connected": ok is True, "paid": True,
            "voices": [CLOVA_SPEAKER], "key_configured": True,
            "detail": ("키 설정됨 — ‘연결 확인’으로 실제 호출을 검증하세요." if ok is None
                       else ("연결 확인됨" if ok else f"연결 실패: {_clova_verified['error']}")),
        })
    else:
        providers.append({"id": "clova", "label": "NAVER CLOVA Voice (유료)", "connected": False, "paid": True,
                          "voices": [], "key_configured": False,
                          "detail": "미연결 — .env 에 NCP_CLOVA_CLIENT_ID / NCP_CLOVA_CLIENT_SECRET 를 넣으면 사용할 수 있습니다."})
    return {"providers": providers, "any_connected": any(p["connected"] for p in providers)}


def available(provider: str) -> bool:
    return any(p["id"] == provider and p["connected"] for p in status()["providers"])


def synthesize(text: str, out_path: Path, provider: str, voice: str = "", rate: int = 0) -> Path:
    """text 를 음성 파일로 만든다. 실패하면 예외 — 호출 측이 실패로 처리한다."""
    text = text.replace("\n", " ").strip()
    if not text:
        raise ValueError("빈 내레이션")
    if provider == "windows":
        ps = _powershell()
        if not ps or not windows_voices():
            raise RuntimeError("Windows 한국어 음성을 사용할 수 없습니다.")
        voice = voice if voice in windows_voices() else windows_voices()[0]
        script = TMP_DIR / "tts_windows.ps1"
        if not script.exists() or script.read_text(encoding="utf-8-sig") != _PS_SCRIPT:
            script.write_text(_PS_SCRIPT, encoding="utf-8-sig")
        txt = out_path.with_suffix(".txt")
        txt.write_text(text, encoding="utf-8")
        with _lock:  # SAPI 는 동시 호출에 약하다
            r = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script),
                                "-TextFile", str(txt), "-OutFile", str(out_path), "-Rate", str(int(rate)),
                                "-Voice", voice], capture_output=True, text=True, timeout=120,
                               encoding="utf-8", errors="replace")
        txt.unlink(missing_ok=True)
        if r.returncode != 0 or not out_path.exists() or out_path.stat().st_size < 2000:
            raise RuntimeError("Windows 음성 생성 실패: " + (r.stderr.strip()[:300] or "출력 파일 없음"))
        return out_path
    if provider == "clova":
        if not (CLOVA_CLIENT_ID and CLOVA_CLIENT_SECRET):
            raise RuntimeError("CLOVA Voice 키가 설정되지 않았습니다.")
        mp3 = out_path.with_suffix(".mp3")
        resp = httpx.post(CLOVA_TTS_URL, timeout=60, headers={
            "X-NCP-APIGW-API-KEY-ID": CLOVA_CLIENT_ID, "X-NCP-APIGW-API-KEY": CLOVA_CLIENT_SECRET,
        }, data={"speaker": voice or CLOVA_SPEAKER, "text": text, "format": "mp3",
                 "speed": str(-int(rate)), "volume": "0", "pitch": "0"})
        if resp.status_code != 200 or not resp.content:
            _clova_verified.update(ok=False, error=f"HTTP {resp.status_code} {resp.text[:200]}")
            raise RuntimeError(f"CLOVA Voice 호출 실패: HTTP {resp.status_code} {resp.text[:200]}")
        _clova_verified.update(ok=True, error="")
        mp3.write_bytes(resp.content)
        return mp3
    raise RuntimeError(f"알 수 없는 음성 제공자: {provider}")


def test_provider(provider: str, voice: str = "") -> dict:
    out = TMP_DIR / f"tts_test_{provider}.wav"
    try:
        path = synthesize("안녕하세요. 내레이션 연결 확인입니다.", out, provider, voice)
        return {"ok": True, "file": path.name}
    except Exception as e:  # noqa: BLE001
        if provider == "clova":
            _clova_verified.update(ok=False, error=str(e)[:200])
        return {"ok": False, "error": str(e)}
