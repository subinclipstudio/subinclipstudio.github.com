"""프로젝트(초안) 생성과 렌더링 작업 관리. 작업은 한 번에 하나씩 백그라운드 스레드에서 실행한다."""
import json
import shutil
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import audio, copywriter, render, store, tts
from .config import VIDEO_DEFAULTS

STAGES = [
    ("validate", "입력 검증"),
    ("photos", "사진 준비"),
    ("captions", "자막·마무리 화면 준비"),
    ("narration", "내레이션 생성"),
    ("audio", "배경음악·오디오 믹싱"),
    ("video", "영상 렌더링(H.264/AAC)"),
    ("cover", "표지 이미지 생성"),
    ("verify", "결과 파일 검증"),
]

DEFAULT_SETTINGS = {
    "duration": VIDEO_DEFAULTS["duration"],
    "music": "bright",
    "music_gain_db": -8, "narration_gain_db": 0, "duck_db": -12, "master_gain_db": 0,
    "fade_in": 1.0, "fade_out": 2.0,
    "narration": False, "tts_provider": "windows", "tts_voice": "", "tts_rate": 0,
    "cta_mode": "unset", "cta_custom": "",
    "post_include_link": True, "disclosure_position": "top", "show_price": True,
    "cover_scene": 0, "cover_text": "",
    "quality": "final",
    **render.DEFAULT_RENDER_SETTINGS,
}

_jobs: dict[str, dict] = {}
_executor = ThreadPoolExecutor(max_workers=1)


def make_project(product: dict, settings: dict | None, hook: str | None = None) -> dict:
    st = {**DEFAULT_SETTINGS, **(settings or {})}
    hooks = copywriter.hook_candidates(product)
    hook = (hook or "").strip() or hooks[0]
    scenes = copywriter.build_scenes(product, float(st["duration"]), hook, st)
    post = copywriter.build_post(product, st, hook)
    return {"product_id": product["id"], "settings": st, "hook": hook, "hook_candidates": hooks,
            "scenes": scenes, "post": {"text": post["text"], "include_link": post["include_link"], "auto": True},
            "post_report": post, "renders": [], "created": time.time()}


def check_project(product: dict, project: dict) -> dict:
    p = copywriter.check_product(product)
    s = copywriter.check_scenes(product, project["scenes"], project["settings"])
    cap_errors = render.validate_captions(project["scenes"], product, project["settings"])
    errors = p["errors"] + s["errors"] + cap_errors
    warnings = p["warnings"] + s["warnings"]
    st = project["settings"]
    if st.get("narration") and not tts.available(st.get("tts_provider", "windows")):
        errors.append("내레이션이 켜져 있지만 선택한 음성(TTS) 서비스가 연결되어 있지 않습니다. 내레이션을 끄거나 연결을 확인하세요.")
    if st.get("music", "none") != "none" and not audio.find_track(st["music"]):
        errors.append("선택한 배경음악 파일을 찾을 수 없습니다. 다른 음악을 고르거나 ‘음악 없음’을 선택하세요.")
    if st.get("cta_mode") == "custom" and not st.get("cta_custom", "").strip():
        errors.append("구매 안내 문구를 ‘직접 입력’으로 선택했다면 문구를 입력하세요.")
    return {"errors": errors, "warnings": list(dict.fromkeys(warnings))}


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)


def public_job(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def start_render(product_id: str) -> dict:
    for j in _jobs.values():
        if j["product_id"] == product_id and j["status"] in ("queued", "running"):
            return j
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    job = {"id": job_id, "product_id": product_id, "status": "queued", "progress": 0.0,
           "stages": [{"key": k, "label": label, "status": "pending", "message": ""} for k, label in STAGES],
           "warnings": [], "error": None, "failed_stage": None, "result": None, "created": time.time()}
    _jobs[job_id] = job
    _executor.submit(_run, job)
    return job


def _stage(job, key, status, message=""):
    for s in job["stages"]:
        if s["key"] == key:
            s["status"] = status
            if message:
                s["message"] = message
    job["current"] = key


RETRY_HINTS = {
    "validate": "표시된 입력 오류를 고친 뒤 ‘다시 생성’을 누르세요.",
    "photos": "문제가 된 사진을 삭제하고 다시 올린 뒤 재시도하세요.",
    "captions": "길거나 줄이 많은 자막을 줄인 뒤 재시도하세요.",
    "narration": "음성 서비스 연결을 확인하거나 내레이션을 끄고 다시 생성하세요(자막·음악만으로 영상을 만들 수 있습니다).",
    "audio": "다른 배경음악을 고르거나 ‘음악 없음’으로 바꿔 재시도하세요.",
    "video": "잠시 후 다시 생성하세요. 반복되면 ‘빠른 미리보기’ 화질로 시도하고 로그를 확인하세요.",
    "cover": "표지 장면을 다른 장면으로 바꾼 뒤 재시도하세요.",
    "verify": "결과 파일이 올바르지 않습니다. 다시 생성하세요.",
}


def _run(job):
    job["status"] = "running"
    pid = job["product_id"]
    key = "validate"
    out_dir = store.product_dir(pid) / "renders" / job["id"]
    try:
        product = store.get_product(pid)
        project = store.get_project(pid)
        if not product or not project:
            raise RuntimeError("상품 또는 제작 초안이 없습니다. 먼저 ‘초안 만들기’를 실행하세요.")
        # 렌더 시점의 상품 정보·장면을 고정해 둔다(이후 수정과 무관하게 결과 재현 가능)
        snapshot = json.loads(json.dumps({"product": product, "project": {k: v for k, v in project.items()
                                                                             if k != "renders"}}))
        st = project["settings"]
        scenes = project["scenes"]

        _stage(job, key, "running")
        chk = check_project(product, project)
        job["warnings"] += chk["warnings"]
        if chk["errors"]:
            raise RuntimeError(" / ".join(chk["errors"]))
        _stage(job, key, "done")
        out_dir.mkdir(parents=True, exist_ok=True)

        key = "photos"
        _stage(job, key, "running")
        photo_paths = {p["id"]: store.photo_path(pid, p["id"]) for p in product["photos"]}
        for sc in scenes:
            if not photo_paths.get(sc["photo_id"]) or not photo_paths[sc["photo_id"]].exists():
                raise RuntimeError("장면에 쓰인 사진 파일을 찾을 수 없습니다.")
        _stage(job, key, "done", f"{len(set(s['photo_id'] for s in scenes))}장 사용")

        key = "captions"
        _stage(job, key, "running")
        preview = st.get("quality") == "preview"
        w, h = (540, 960) if preview else (VIDEO_DEFAULTS["width"], VIDEO_DEFAULTS["height"])
        tl = render.Timeline(scenes, photo_paths, product, st, w, h)
        _stage(job, key, "done", f"자막 {len([c for c in tl.cues])}개")

        key = "narration"
        narrations = []
        narr_info = {"enabled": bool(st.get("narration")), "provider": None, "clips": 0}
        if st.get("narration"):
            _stage(job, key, "running")
            provider = st.get("tts_provider", "windows")
            ndir = out_dir / "narration"
            ndir.mkdir(exist_ok=True)
            starts = tl.starts
            idx = [i for i, sc in enumerate(scenes) if sc.get("narration", "").strip()]
            for n_i, i in enumerate(idx):
                end = starts[idx[n_i + 1]] if n_i + 1 < len(idx) else tl.total
                start = starts[i] + 0.15
                allowed = max(0.3, end - start - 0.1)
                rate = int(st.get("tts_rate", 0))
                path = tts.synthesize(scenes[i]["narration"], ndir / f"n{i:02d}.wav", provider,
                                      st.get("tts_voice", ""), rate)
                length = audio.speech_length(path)
                if length > allowed and provider == "windows" and rate < 4:
                    # 장면보다 길면 말하기 속도를 올려 다시 만든다
                    path = tts.synthesize(scenes[i]["narration"], ndir / f"n{i:02d}_fast.wav", provider,
                                          st.get("tts_voice", ""), min(5, rate + 3))
                    length = audio.speech_length(path)
                if allowed < length <= allowed * 1.3:
                    path = audio.speed_up(path, ndir / f"n{i:02d}_tempo.wav", length / allowed * 1.02)
                narrations.append((start, allowed, path))
            narr_info.update(provider=provider, clips=len(narrations))
            _stage(job, key, "done", f"{len(narrations)}개 문장 생성 ({provider})")
        else:
            _stage(job, key, "skipped", "내레이션 꺼짐")

        key = "audio"
        _stage(job, key, "running")
        music = audio.find_track(st["music"]) if st.get("music", "none") != "none" else None
        wav = out_dir / "mix.wav"
        mix_info = audio.mix(tl.total, wav, music, narrations, st)
        job["warnings"] += mix_info["warnings"]
        msg = (f"음악: {music['title']}" if music else "음악 없음") + (f", 내레이션 {mix_info['narration_clips']}개" if narrations else "")
        _stage(job, key, "done", msg)

        key = "video"
        _stage(job, key, "running")
        mp4 = out_dir / "video.mp4"

        def prog(f):
            job["progress"] = round(f, 3)
            _stage(job, "video", "running", f"{int(f * 100)}%")

        t0 = time.time()
        render.render_video(tl, wav, mp4, VIDEO_DEFAULTS["fps"], prog, out_dir / "ffmpeg.log")
        _stage(job, key, "done", f"{time.time() - t0:.0f}초 소요")

        key = "cover"
        _stage(job, key, "running")
        cover_tl = tl if not preview else render.Timeline(scenes, photo_paths, product, st, 1080, 1920)
        cover = out_dir / "cover.jpg"
        render.render_cover(cover_tl, product, int(st.get("cover_scene", 0)),
                            st.get("cover_text", "") or project.get("hook", ""), cover)
        _stage(job, key, "done")

        key = "verify"
        _stage(job, key, "running")
        pr = render.probe(mp4)
        problems = []
        if pr["video_codec"] != "h264":
            problems.append(f"영상 코덱이 H.264가 아닙니다({pr['video_codec']})")
        if pr["audio_codec"] != "aac":
            problems.append(f"오디오 코덱이 AAC가 아닙니다({pr['audio_codec']})")
        if (pr["width"], pr["height"]) != (w, h):
            problems.append(f"해상도 불일치 {pr['width']}x{pr['height']}")
        if pr["duration"] is None or abs(pr["duration"] - tl.total) > 0.25:
            problems.append(f"길이 불일치 {pr['duration']} / {tl.total:.2f}")
        if pr["decode_errors"]:
            problems.append("디코딩 오류: " + pr["decode_errors"][:200])
        if not cover.exists() or cover.stat().st_size < 10000:
            problems.append("표지 이미지가 생성되지 않았습니다")
        if problems:
            raise RuntimeError("; ".join(problems))
        _stage(job, key, "done", f"{pr['width']}x{pr['height']} · {pr['fps']}fps · {pr['duration']:.2f}초")
        wav.unlink(missing_ok=True)

        result = {
            "video": f"/files/{pid}/renders/{job['id']}/video.mp4",
            "cover": f"/files/{pid}/renders/{job['id']}/cover.jpg",
            "size_bytes": mp4.stat().st_size, "probe": pr, "quality": "preview" if preview else "final",
            "duration": round(tl.total, 2), "music": mix_info["music"], "narration": narr_info,
            "silent_audio": mix_info["silent"], "scene_count": len(scenes),
        }
        (out_dir / "render.json").write_text(json.dumps({"job": public_job(job), "result": result,
                                                         "snapshot": snapshot}, ensure_ascii=False, indent=2),
                                             encoding="utf-8")
        project = store.get_project(pid)
        project.setdefault("renders", []).insert(0, {"job_id": job["id"], "created": job["created"], **result})
        # 오래된 렌더 정리(최근 5개 유지)
        for old in project["renders"][5:]:
            shutil.rmtree(store.product_dir(pid) / "renders" / old["job_id"], ignore_errors=True)
        project["renders"] = project["renders"][:5]
        store.save_project(pid, project)
        job["result"] = result
        job["progress"] = 1.0
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        _stage(job, key, "failed", str(e)[:500])
        job["status"] = "failed"
        job["failed_stage"] = key
        job["error"] = str(e)
        job["retry_hint"] = RETRY_HINTS.get(key, "다시 시도하세요.")
        job["_trace"] = traceback.format_exc()
        # 실패한 결과물은 성공처럼 보이지 않도록 지운다(로그는 남김)
        for name in ("video.mp4", "cover.jpg", "mix.wav"):
            (out_dir / name).unlink(missing_ok=True)
        print(job["_trace"])
    finally:
        job["finished"] = time.time()
