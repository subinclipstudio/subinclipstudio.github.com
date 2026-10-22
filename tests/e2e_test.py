"""완료 기준 검증: 사진 5장/10장으로 실제 MP4를 만들고 항목별로 확인한다.

실행: .venv\\Scripts\\python tests\\e2e_test.py  [--quick]
--quick 은 540x960 미리보기 화질로 빠르게 검증한다.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app import copywriter, store  # noqa: E402
from app.config import FFMPEG  # noqa: E402
from app.main import app  # noqa: E402

SAMPLES = ROOT / "tests" / "samples"
OUT = ROOT / "tests" / "output"
LINK = "https://brandconnect.naver.com/p/abc123?utm_source=clip&utm_medium=affiliate&trackingId=XyZ%2F9&ref=a+b"
QUICK = "--quick" in sys.argv

client = TestClient(app)
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  [통과] " if ok else "  [실패] ") + name + (f" — {detail}" if detail else ""))


def wait_job(job_id):
    while True:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(1)


def frame_at(mp4: Path, t: float, out: Path):
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", str(t), "-i", str(mp4), "-frames:v", "1", str(out)], check=True)


def run_case(n_photos: int, duration: int, music: str, narration: bool):
    print(f"\n=== 사진 {n_photos}장 · {duration}초 · 음악 {music} · 내레이션 {'켜짐' if narration else '꺼짐'} ===")
    product = {
        "brand": "테스트브랜드", "name": "스텐 텀블러 500ml", "link": LINK,
        "features": ["밀폐 잠금 뚜껑", "500ml 용량", "손잡이 일체형 디자인"],
        "situation": "출근길", "target": "직장인", "price": "19,900원", "tone": "friendly",
        "disclosure": "이 콘텐츠는 네이버 브랜드커넥트를 통해 판매 수수료를 제공받습니다.",
        "must_include": [], "exclude": ["최저가"],
    }
    p = client.post("/api/products", json=product).json()
    pid = p["id"]
    files = sorted(SAMPLES.glob("*.jpg"))[:n_photos]
    r = client.post(f"/api/products/{pid}/photos",
                    files=[("files", (fp.name, fp.read_bytes(), "image/jpeg")) for fp in files]).json()
    check("사진 업로드", len(r["product"]["photos"]) == n_photos, f"{len(r['product']['photos'])}장")
    # 역할 지정 + 드래그 순서 변경 시뮬레이션(마지막 사진을 맨 앞으로)
    photos = r["product"]["photos"]
    roles = ["hero", "detail", "usage", "package", "hero", "detail", "usage", "other", "hero", "package"]
    items = [{"id": ph["id"], "role": roles[i]} for i, ph in enumerate(photos)]
    items = [items[-1]] + items[:-1]
    r = client.put(f"/api/products/{pid}/photos", json={"items": items}).json()
    check("사진 순서 변경 반영", r["product"]["photos"][0]["id"] == photos[-1]["id"])

    settings = {"duration": duration, "music": music, "narration": narration, "cta_mode": "post_link",
                "video_disclosure": "광고 · 수수료 제공", "quality": "preview" if QUICK else "final"}
    d = client.post(f"/api/products/{pid}/draft", json={"settings": settings})
    check("초안 생성", d.status_code == 200, d.text[:200] if d.status_code != 200 else "")
    proj = d.json()["project"]
    total = sum(s["duration"] for s in proj["scenes"])
    check("장면 길이 합계", abs(total - duration) < 0.01, f"{total:.2f}초, 장면 {len(proj['scenes'])}개")
    used = {s["photo_id"] for s in proj["scenes"]}
    check("모든 사진이 장면에 사용됨", used == {ph["id"] for ph in r["product"]["photos"]}, f"{len(used)}장")

    post = proj["post"]["text"]
    n = copywriter.count_chars(post)
    check("게시글 300자 이내", n <= 300, f"{n}자")
    check("게시글 속 링크 원본 보존", LINK in post)
    check("표시 문구 원문 포함", product["disclosure"] in post)
    texts = " ".join(copywriter.scene_texts(proj["scenes"])) + " " + post
    risky = copywriter.find_expressions(texts, copywriter.RISKY_EXPRESSIONS)
    check("확인되지 않은 정보·과장 표현 없음", not risky, ", ".join(risky))
    check("제외 표현 미포함", "최저가" not in texts)

    job = client.post(f"/api/products/{pid}/render").json()
    t0 = time.time()
    j = wait_job(job["id"])
    check("렌더링 성공", j["status"] == "done", j.get("error") or f"{time.time() - t0:.0f}초")
    if j["status"] != "done":
        print(json.dumps(j["stages"], ensure_ascii=False, indent=1))
        return pid
    res = j["result"]
    dl = client.get(res["video"] + "?download=true")
    case_dir = OUT / f"{n_photos}photos_{duration}s"
    case_dir.mkdir(parents=True, exist_ok=True)
    mp4 = case_dir / "video.mp4"
    mp4.write_bytes(dl.content)
    check("MP4 다운로드", dl.status_code == 200 and len(dl.content) > 100_000 and
          "attachment" in dl.headers.get("content-disposition", ""), f"{len(dl.content) / 1e6:.1f}MB")
    pr = res["probe"]
    exp = (540, 960) if QUICK else (1080, 1920)
    check("H.264/AAC·해상도·30fps", pr["video_codec"] == "h264" and pr["audio_codec"] == "aac"
          and (pr["width"], pr["height"]) == exp and abs(pr["fps"] - 30) < 0.01,
          f"{pr['video_codec']}/{pr['audio_codec']} {pr['width']}x{pr['height']} {pr['fps']}fps {pr['duration']:.2f}s")
    cov = client.get(res["cover"] + "?download=true")
    (case_dir / "cover.jpg").write_bytes(cov.content)
    check("표지 이미지 다운로드", cov.status_code == 200 and len(cov.content) > 10_000)
    check("음악 설정 반영", (res["music"] or {}).get("id") == (music if music != "none" else None),
          str((res["music"] or {}).get("title")))
    check("내레이션 설정 반영", res["narration"]["enabled"] == narration and
          (res["narration"]["clips"] > 0) == narration, f"{res['narration']}")
    # 프레임 추출 — 사람이 눈으로 확인할 수 있게 저장
    for t in (1.0, 4.0, duration * 0.5, duration - 1.0):
        frame_at(mp4, t, case_dir / f"frame_{t:05.1f}s.jpg")
    # 오디오 레벨 확인
    vol = subprocess.run([FFMPEG, "-hide_banner", "-i", str(mp4), "-af", "volumedetect", "-vn", "-f", "null", "-"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    mean = [ln for ln in vol.splitlines() if "mean_volume" in ln]
    check("오디오 신호 존재" if music != "none" or narration else "무음 오디오 트랙",
          bool(mean), mean[0].split("]")[-1].strip() if mean else "")

    # 장면 수정 후 다시 생성
    proj = client.get(f"/api/products/{pid}/project").json()["project"]
    proj["scenes"][1]["caption"] = "수정한 자막\n두 번째 줄"
    proj["scenes"][1]["duration"] = round(proj["scenes"][1]["duration"] + 1.0, 2)
    proj["scenes"][2]["photo_id"], proj["scenes"][3]["photo_id"] = proj["scenes"][3]["photo_id"], proj["scenes"][2]["photo_id"]
    u = client.put(f"/api/products/{pid}/project", json={"scenes": proj["scenes"],
                                                         "settings": {"music": "calm", "quality": "preview"}})
    check("장면 수정 저장", u.status_code == 200 and not u.json()["check"]["errors"], str(u.json()["check"]["errors"]))
    j2 = wait_job(client.post(f"/api/products/{pid}/render").json()["id"])
    ok = j2["status"] == "done" and abs(j2["result"]["duration"] - (duration + 1.0)) < 0.05 \
        and j2["result"]["music"]["id"] == "calm"
    check("수정 사항 반영 재생성", ok, j2.get("error") or f"{j2['result']['duration']}초, 음악 {j2['result']['music']['id']}")
    if ok:
        m2 = case_dir / "video_edited.mp4"
        m2.write_bytes(client.get(j2["result"]["video"]).content)
        frame_at(m2, proj["scenes"][0]["duration"] + 1.0, case_dir / "frame_edited_scene2.jpg")
    # 저장된 링크 원본 보존
    saved = store.get_product(pid)
    check("저장된 구매 링크 원본 보존", saved["link"] == LINK)
    check("브랜드명·상품명 정확", saved["brand"] == product["brand"] and saved["name"] == product["name"])
    return pid


def main():
    if not SAMPLES.exists() or len(list(SAMPLES.glob("*.jpg"))) < 10:
        subprocess.run([sys.executable, str(ROOT / "tests" / "make_samples.py")], check=True)
    OUT.mkdir(exist_ok=True)
    pids = [run_case(5, 25, "bright", False), run_case(10, 15, "warm", True)]
    # 게시글 경계 시험: 필수 정보가 300자를 넘는 경우 링크 분리 안내
    long_p = client.post("/api/products", json={
        "brand": "테스트브랜드", "name": "긴 이름 상품", "link": "https://example.com/?" + "x" * 250,
        "features": ["특징"], "disclosure": "표시 문구"}).json()
    res = copywriter.build_post(store.get_product(long_p["id"]), {"post_include_link": True}, "첫 문장")
    check("필수 정보 초과 시 링크 별도 복사 안내", res["status"] == "over_required" and "링크" in " ".join(res["errors"]))
    res2 = copywriter.build_post(store.get_product(long_p["id"]), {"post_include_link": False}, "첫 문장")
    check("링크 제외 시 300자 이내", res2["count"] <= 300, f"{res2['count']}자")
    for pid in pids + [long_p["id"]]:
        if "--keep" not in sys.argv:
            store.delete_product(pid)
    failed = [r for r in results if not r[1]]
    print(f"\n결과: {len(results) - len(failed)}/{len(results)} 통과")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
