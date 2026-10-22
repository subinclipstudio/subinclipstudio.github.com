"""상품·사진·프로젝트(장면/설정/게시글) 저장소. 상품마다 data/products/<id>/ 폴더 하나."""
import json
import threading
import time
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from .config import PRODUCTS_DIR, PHOTO_MAX

_lock = threading.RLock()

PHOTO_ROLES = {
    "unset": "역할 미지정",
    "hero": "제품 전체",
    "detail": "세부 특징",
    "usage": "사용 장면",
    "package": "포장",
    "other": "기타",
}

PRODUCT_FIELDS = {
    "brand": "", "name": "", "link": "", "features": [],
    "target": "", "situation": "", "price": "", "promo": "", "promo_period": "",
    "tone": "friendly", "disclosure": "", "must_include": [], "exclude": [],
}


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def product_dir(pid: str) -> Path:
    if not pid.isalnum():
        raise ValueError("잘못된 상품 ID")
    return PRODUCTS_DIR / pid


def _read(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def clean_list(value) -> list[str]:
    if isinstance(value, str):
        value = value.replace(",", "\n").splitlines()
    return [v.strip() for v in (value or []) if isinstance(v, str) and v.strip()]


def normalize_product_input(data: dict) -> dict:
    out = {}
    for key, default in PRODUCT_FIELDS.items():
        if key not in data:
            continue
        val = data[key]
        if isinstance(default, list):
            out[key] = clean_list(val)
        elif key == "link":
            # 구매·제휴 링크는 앞뒤 공백만 제거하고 그 외 문자(쿼리 문자열 포함)는 그대로 보존한다.
            out[key] = (val or "").strip()
        else:
            out[key] = (val or "").strip() if isinstance(val, str) else default
    return out


def list_products() -> list[dict]:
    items = []
    for d in PRODUCTS_DIR.iterdir():
        p = _read(d / "product.json", None)
        if p:
            items.append({"id": p["id"], "brand": p.get("brand", ""), "name": p.get("name", ""),
                          "photo_count": len(p.get("photos", [])), "updated": p.get("updated", 0)})
    return sorted(items, key=lambda x: -x["updated"])


def get_product(pid: str) -> dict | None:
    return _read(product_dir(pid) / "product.json", None)


def save_product(pid: str | None, data: dict) -> dict:
    with _lock:
        if pid:
            product = get_product(pid)
            if product is None:
                raise KeyError(pid)
        else:
            pid = new_id()
            product = {"id": pid, **json.loads(json.dumps(PRODUCT_FIELDS)), "photos": [], "created": time.time()}
        product.update(normalize_product_input(data))
        product["updated"] = time.time()
        _write(product_dir(pid) / "product.json", product)
        return product


def delete_product(pid: str) -> None:
    import shutil
    with _lock:
        shutil.rmtree(product_dir(pid), ignore_errors=True)


def add_photo(pid: str, filename: str, raw: bytes) -> dict:
    """원본 사진을 그대로 디코딩해 방향(EXIF)만 바로잡고 저장한다. 형태·색상은 변경하지 않는다."""
    import io
    with _lock:
        product = get_product(pid)
        if product is None:
            raise KeyError(pid)
        if len(product["photos"]) >= PHOTO_MAX:
            raise ValueError(f"사진은 최대 {PHOTO_MAX}장까지 올릴 수 있습니다.")
        try:
            img = Image.open(io.BytesIO(raw))
            img = ImageOps.exif_transpose(img)
            img.load()
        except Exception:
            raise ValueError(f"'{filename}' 파일을 이미지로 읽을 수 없습니다.")
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[3])
            img = bg
        else:
            img = img.convert("RGB")
        # 렌더링 속도를 위해 긴 변 3000px 이하로만 축소(비율 유지)
        if max(img.size) > 3000:
            img.thumbnail((3000, 3000), Image.LANCZOS)
        photo_id = new_id()
        photos_dir = product_dir(pid) / "photos"
        photos_dir.mkdir(parents=True, exist_ok=True)
        img.save(photos_dir / f"{photo_id}.jpg", quality=95, subsampling=0)
        thumb = img.copy()
        thumb.thumbnail((360, 360), Image.LANCZOS)
        thumb.save(photos_dir / f"{photo_id}_thumb.jpg", quality=85)
        photo = {"id": photo_id, "file": f"{photo_id}.jpg", "original_name": filename,
                 "width": img.width, "height": img.height,
                 "role": "unset", "role_source": "none", "role_confidence": None,
                 "text_candidates": []}
        product["photos"].append(photo)
        product["updated"] = time.time()
        _write(product_dir(pid) / "product.json", product)
        return photo


def update_photos(pid: str, items: list[dict]) -> dict:
    """사진 순서·역할 갱신. items 순서가 새 순서가 된다."""
    with _lock:
        product = get_product(pid)
        if product is None:
            raise KeyError(pid)
        by_id = {p["id"]: p for p in product["photos"]}
        new_list = []
        for it in items:
            p = by_id.pop(it["id"], None)
            if not p:
                continue
            role = it.get("role")
            if role in PHOTO_ROLES and role != p["role"]:
                p["role"] = role
                p["role_source"] = "user"
            elif role in PHOTO_ROLES and it.get("confirm"):
                p["role_source"] = "user"
            new_list.append(p)
        new_list.extend(by_id.values())
        product["photos"] = new_list
        product["updated"] = time.time()
        _write(product_dir(pid) / "product.json", product)
        return product


def set_photo_analysis(pid: str, results: dict) -> dict:
    with _lock:
        product = get_product(pid)
        for p in product["photos"]:
            r = results.get(p["id"])
            if not r:
                continue
            if p["role_source"] != "user":  # 사용자가 고른 역할은 덮어쓰지 않는다
                p["role"] = r["role"]
                p["role_source"] = "auto"
                p["role_confidence"] = r.get("confidence")
            p["role_reason"] = r.get("reason", "")
            p["text_candidates"] = r.get("visible_text", [])
        product["updated"] = time.time()
        _write(product_dir(pid) / "product.json", product)
        return product


def delete_photo(pid: str, photo_id: str) -> dict:
    with _lock:
        product = get_product(pid)
        product["photos"] = [p for p in product["photos"] if p["id"] != photo_id]
        for suffix in (".jpg", "_thumb.jpg"):
            (product_dir(pid) / "photos" / f"{photo_id}{suffix}").unlink(missing_ok=True)
        product["updated"] = time.time()
        _write(product_dir(pid) / "product.json", product)
        return product


def clear_photos(pid: str) -> dict:
    with _lock:
        product = get_product(pid)
        for p in list(product["photos"]):
            delete_photo(pid, p["id"])
        return get_product(pid)


def photo_path(pid: str, photo_id: str) -> Path:
    return product_dir(pid) / "photos" / f"{photo_id}.jpg"


def get_project(pid: str) -> dict | None:
    return _read(product_dir(pid) / "project.json", None)


def save_project(pid: str, project: dict) -> dict:
    with _lock:
        project["updated"] = time.time()
        _write(product_dir(pid) / "project.json", project)
        return project
