"""클립 상품영상 스튜디오 — API 서버 (FastAPI)."""
import io
import re
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import audio, copywriter, jobs, render, store, tts, vision
from .config import FFMPEG, FONT_BOLD, FONT_REGULAR, PHOTO_MAX, PHOTO_MIN, STATIC_DIR, VIDEO_DEFAULTS

app = FastAPI(title="클립 상품영상 스튜디오")


def _product_or_404(pid: str) -> dict:
    try:
        p = store.get_product(pid)
    except ValueError:
        p = None
    if not p:
        raise HTTPException(404, "상품을 찾을 수 없습니다.")
    return p


@app.middleware("http")
async def _no_cache_static(request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith(("/api", "/files")):
        resp.headers["Cache-Control"] = "no-cache"  # 앱 업데이트 후 예전 화면 파일이 남지 않게
    return resp


@app.exception_handler(ValueError)
async def _value_error(_, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ------------------------------------------------------------------ 상태
@app.get("/api/status")
def status():
    lib = audio.public_library()
    return {
        "app": "클립 상품영상 스튜디오", "version": "1.0.0",
        "ffmpeg": {"ok": bool(FFMPEG), "path_hint": Path(FFMPEG).name if FFMPEG else None},
        "fonts": {"ok": bool(FONT_REGULAR), "regular": Path(FONT_REGULAR).name if FONT_REGULAR else None,
                  "bold": Path(FONT_BOLD).name if FONT_BOLD else None},
        "tts": tts.status(),
        "vision": vision.status(),
        "music": {"count": len(lib), "builtin": sum(1 for m in lib if m.get("builtin"))},
        "naver_upload": {"connected": False, "detail": "네이버 계정 자동 게시는 1차 버전 범위 밖입니다(별도 연동 과제)."},
        "video_defaults": VIDEO_DEFAULTS,
        "video_defaults_note": "앱의 기본 제작값입니다. 네이버 클립 공식 업로드 요건이 아니며, 실제 적용 시 최신 공식 안내를 확인해 조정하세요.",
        "photo_range": [PHOTO_MIN, PHOTO_MAX],
        "roles": store.PHOTO_ROLES, "tones": copywriter.TONES, "cta_modes": copywriter.CTA_MODES,
        "segments": copywriter.SEGMENTS, "moods": audio.MOODS,
        "risky_expressions": copywriter.RISKY_EXPRESSIONS,
    }


# ------------------------------------------------------------------ 상품
@app.get("/api/products")
def products():
    return store.list_products()


@app.post("/api/products")
def create_product(data: dict):
    return store.save_product(None, data)


@app.get("/api/products/{pid}")
def product(pid: str):
    p = _product_or_404(pid)
    return {"product": p, "check": copywriter.check_product(p), "project": store.get_project(pid)}


@app.put("/api/products/{pid}")
def update_product(pid: str, data: dict):
    _product_or_404(pid)
    p = store.save_product(pid, data)
    return {"product": p, "check": copywriter.check_product(p)}


@app.delete("/api/products/{pid}")
def delete_product(pid: str):
    _product_or_404(pid)
    store.delete_product(pid)
    return {"ok": True}


# ------------------------------------------------------------------ 사진
@app.post("/api/products/{pid}/photos")
async def upload_photos(pid: str, files: list[UploadFile] = File(...), replace: bool = Form(False)):
    _product_or_404(pid)
    if replace:
        store.clear_photos(pid)
    added, errors = [], []
    for f in files:
        try:
            added.append(store.add_photo(pid, f.filename or "photo", await f.read()))
        except ValueError as e:
            errors.append(str(e))
    p = store.get_product(pid)
    return {"added": added, "errors": errors, "product": p, "check": copywriter.check_product(p)}


class PhotoOrder(BaseModel):
    items: list[dict]


@app.put("/api/products/{pid}/photos")
def update_photos(pid: str, body: PhotoOrder):
    _product_or_404(pid)
    p = store.update_photos(pid, body.items)
    return {"product": p, "check": copywriter.check_product(p)}


@app.delete("/api/products/{pid}/photos/{photo_id}")
def delete_photo(pid: str, photo_id: str):
    _product_or_404(pid)
    p = store.delete_photo(pid, photo_id)
    return {"product": p, "check": copywriter.check_product(p)}


@app.get("/api/products/{pid}/photos/suggest-order")
def suggest_order(pid: str):
    p = _product_or_404(pid)
    return {"order": copywriter.suggest_order(p["photos"])}


@app.post("/api/products/{pid}/analyze")
def analyze(pid: str):
    p = _product_or_404(pid)
    if not vision.status()["connected"]:
        raise HTTPException(400, "사진 자동 분석 API가 연결되지 않았습니다. 사진 역할을 직접 선택하세요.")
    if not p["photos"]:
        raise HTTPException(400, "분석할 사진이 없습니다.")
    try:
        res = vision.analyze([store.photo_path(pid, ph["id"]) for ph in p["photos"]])
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    by_id = {}
    for r in res:
        if 0 <= r["index"] < len(p["photos"]):
            by_id[p["photos"][r["index"]]["id"]] = {
                "role": r["role"] if r["role"] in store.PHOTO_ROLES else "other",
                "confidence": max(0.0, min(1.0, float(r["confidence"]))),
                "reason": r["reason"], "visible_text": [t for t in r["visible_text"] if t.strip()][:8]}
    p = store.set_photo_analysis(pid, by_id)
    return {"product": p, "note": "자동 분석 결과는 추정입니다. 역할과 문자 후보는 확인 후 사용하세요."}


# ------------------------------------------------------------------ 초안·프로젝트
class DraftReq(BaseModel):
    settings: dict = {}
    hook: str = ""


@app.post("/api/products/{pid}/draft")
def draft(pid: str, req: DraftReq):
    p = _product_or_404(pid)
    chk = copywriter.check_product(p)
    if chk["errors"]:
        raise HTTPException(400, " / ".join(chk["errors"]))
    old = store.get_project(pid)
    try:
        project = jobs.make_project(p, req.settings, req.hook)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if old:
        project["renders"] = old.get("renders", [])
    store.save_project(pid, project)
    return {"project": project, "check": jobs.check_project(p, project)}


@app.get("/api/products/{pid}/project")
def get_project(pid: str):
    p = _product_or_404(pid)
    project = store.get_project(pid)
    if not project:
        raise HTTPException(404, "아직 초안이 없습니다.")
    return {"project": project, "check": jobs.check_project(p, project)}


class ProjectUpdate(BaseModel):
    settings: dict | None = None
    scenes: list[dict] | None = None
    hook: str | None = None
    post: dict | None = None


@app.put("/api/products/{pid}/project")
def update_project(pid: str, body: ProjectUpdate):
    p = _product_or_404(pid)
    project = store.get_project(pid)
    if not project:
        raise HTTPException(404, "아직 초안이 없습니다.")
    if body.settings is not None:
        project["settings"] = {**jobs.DEFAULT_SETTINGS, **project["settings"], **body.settings}
        # 마무리 화면 구매 안내는 설정을 따른다(사용자가 장면에서 직접 바꾼 경우 제외)
        cta = copywriter.cta_text(project["settings"]["cta_mode"], p.get("tone", "friendly"),
                                  project["settings"].get("cta_custom", ""))
        for sc in project["scenes"]:
            if sc.get("style") == "card" and not sc.get("cta_locked"):
                sc["cta"] = cta
                sc["narration"] = copywriter.outro_narration(p["brand"], p["name"], project["settings"]["cta_mode"],
                                                             p.get("tone", "friendly"), cta)
    if body.scenes is not None:
        clean = []
        for i, sc in enumerate(body.scenes):
            clean.append({
                "id": str(sc.get("id") or f"s{i + 1}"), "segment": sc.get("segment", "feature"),
                "photo_id": sc.get("photo_id"), "caption": str(sc.get("caption", ""))[:200],
                "style": sc.get("style", "normal") if sc.get("style") in ("normal", "title", "card") else "normal",
                "duration": round(max(0.5, min(20.0, float(sc.get("duration", 2)))), 2),
                "motion": sc.get("motion", "auto"), "narration": str(sc.get("narration", ""))[:300],
                **({"cta": str(sc.get("cta", ""))[:60], "cta_locked": bool(sc.get("cta_locked"))}
                   if sc.get("style") == "card" else {}),
            })
        project["scenes"] = clean
    if body.hook is not None:
        project["hook"] = body.hook.strip()
    if body.post is not None:
        project["post"] = {"text": str(body.post.get("text", "")), "auto": bool(body.post.get("auto", False)),
                           "include_link": bool(body.post.get("include_link", True))}
    store.save_project(pid, project)
    return {"project": project, "check": jobs.check_project(p, project),
            "post_check": copywriter.check_post(p, project["post"]["text"], project["post"]["include_link"])}


class PostReq(BaseModel):
    settings: dict = {}


@app.post("/api/products/{pid}/post/build")
def build_post(pid: str, req: PostReq):
    p = _product_or_404(pid)
    project = store.get_project(pid)
    st = {**jobs.DEFAULT_SETTINGS, **(project["settings"] if project else {}), **req.settings}
    hook = project.get("hook") if project else copywriter.hook_candidates(p)[0]
    res = copywriter.build_post(p, st, hook)
    if project:
        project["settings"] = st
        project["post"] = {"text": res["text"], "include_link": res["include_link"], "auto": True}
        project["post_report"] = res
        store.save_project(pid, project)
    res["check"] = copywriter.check_post(p, res["text"], res["include_link"])
    return res


class PostCheck(BaseModel):
    text: str
    include_link: bool = True


@app.post("/api/products/{pid}/post/check")
def check_post(pid: str, body: PostCheck):
    p = _product_or_404(pid)
    return copywriter.check_post(p, body.text, body.include_link)


class FrameReq(BaseModel):
    scene_index: int = 0
    guide: bool = True


@app.post("/api/products/{pid}/preview-frame")
def preview_frame(pid: str, req: FrameReq):
    p = _product_or_404(pid)
    project = store.get_project(pid)
    if not project:
        raise HTTPException(404, "아직 초안이 없습니다.")
    scenes = project["scenes"]
    i = max(0, min(req.scene_index, len(scenes) - 1))
    photo_paths = {ph["id"]: store.photo_path(pid, ph["id"]) for ph in p["photos"]}
    if scenes[i]["photo_id"] not in photo_paths:
        raise HTTPException(400, "이 장면의 사진이 없습니다.")
    try:
        tl = render.Timeline(scenes, photo_paths, p, project["settings"], 540, 960)
    except render.CaptionError as e:
        raise HTTPException(400, str(e))
    t = tl.starts[i] + float(scenes[i]["duration"]) * 0.6
    img = tl.frame(t)
    if req.guide:
        img = render.guide_overlay(img, tl.lay)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return Response(buf.getvalue(), media_type="image/jpeg")


# ------------------------------------------------------------------ 렌더
@app.post("/api/products/{pid}/render")
def start_render(pid: str):
    p = _product_or_404(pid)
    project = store.get_project(pid)
    if not project:
        raise HTTPException(400, "먼저 초안을 만드세요.")
    chk = jobs.check_project(p, project)
    if chk["errors"]:
        raise HTTPException(400, " / ".join(chk["errors"]))
    return jobs.public_job(jobs.start_render(pid))


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    j = jobs.get_job(job_id)
    if not j:
        raise HTTPException(404, "작업을 찾을 수 없습니다(서버가 다시 시작되었을 수 있습니다).")
    return jobs.public_job(j)


# ------------------------------------------------------------------ 음악·음성
@app.get("/api/music")
def music():
    return audio.public_library()


@app.post("/api/music")
async def upload_music(file: UploadFile = File(...), title: str = Form(""), source: str = Form(""),
                       license_name: str = Form(""), confirmed: bool = Form(False)):
    return audio.save_upload(file.filename or "music", await file.read(), title, source, license_name, confirmed)


@app.get("/api/music/{mid}/file")
def music_file(mid: str):
    t = audio.find_track(mid)
    if not t:
        raise HTTPException(404, "음악을 찾을 수 없습니다.")
    return FileResponse(t["path"])


class TTSTest(BaseModel):
    provider: str = "windows"
    voice: str = ""


@app.post("/api/tts/test")
def tts_test(body: TTSTest):
    r = tts.test_provider(body.provider, body.voice)
    if not r["ok"]:
        raise HTTPException(502, r["error"])
    from .config import TMP_DIR
    return FileResponse(TMP_DIR / r["file"])


# ------------------------------------------------------------------ 파일
_SAFE = re.compile(r"^[\w.\-]+$")


@app.get("/files/{pid}/{kind}/{a}")
@app.get("/files/{pid}/{kind}/{a}/{b}")
def files(pid: str, kind: str, a: str, b: str | None = None, download: bool = False):
    p = _product_or_404(pid)
    if kind not in ("photos", "renders") or not _SAFE.match(a) or (b and not _SAFE.match(b)):
        raise HTTPException(404)
    path = store.product_dir(pid) / kind / a / b if b else store.product_dir(pid) / kind / a
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "파일이 없습니다.")
    if download:
        safe_name = re.sub(r"[\\/:*?\"<>|\s]+", "_", f"{p['brand']}_{p['name']}").strip("_")[:60] or "clip"
        suffix = {"video.mp4": "_클립영상.mp4", "cover.jpg": "_표지.jpg"}.get(path.name, "_" + path.name)
        return FileResponse(path, filename=safe_name + suffix)
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
