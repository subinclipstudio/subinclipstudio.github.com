"""확인된 상품 정보만으로 첫 문장·장면 자막·내레이션·게시글을 만든다.

원칙
- 사용자가 입력·확인한 값(브랜드명, 상품명, 특징, 사용 상황, 주요 고객, 가격, 행사)만 사용한다.
- 고정 문구는 효능·성분·인증·판매량·할인율 등 사실 주장을 담지 않는다.
- 최상급 표현이나 과도한 구매 재촉 표현은 생성하지 않고, 입력값에 있으면 경고한다.
"""
import re

from .config import POST_LIMIT

# 근거 확인이 필요한 표현(입력값에 있으면 경고만, 생성 문구에는 사용하지 않음)
RISKY_EXPRESSIONS = [
    "최고", "최상", "최초", "1위", "넘버원", "No.1", "no.1", "유일", "완벽", "100%", "최저가", "역대급",
    "완판", "품절 임박", "마감 임박", "지금 당장", "서두르세요", "놓치면 후회", "무조건", "효과 보장",
    "부작용 없", "무첨가", "천연", "유기농", "인증", "특허", "판매량", "누적 판매", "할인율", "기적",
    "치료", "완치", "의사 추천", "전문가 추천", "단 하루", "마지막 기회",
]

TONES = {
    "friendly": "친근한 말투(해요체)",
    "polite": "차분한 말투(합니다체)",
    "lively": "발랄한 말투",
}

CTA_MODES = {
    "unset": "링크 위치 미정 (중립 문구)",
    "post_link": "게시글 본문 링크",
    "product_tag": "상품 태그",
    "profile": "프로필 링크",
    "comment": "댓글 링크",
    "custom": "직접 입력",
}

_CTA_TEXT = {
    "unset": ("자세한 정보를 확인해 보세요", "자세한 정보를 확인해 보시기 바랍니다"),
    "post_link": ("구매 링크는 게시글에서 확인하세요", "구매 링크는 게시글에서 확인하실 수 있습니다"),
    "product_tag": ("상품 정보는 상품 태그에서 확인하세요", "상품 정보는 상품 태그에서 확인하실 수 있습니다"),
    "profile": ("구매 링크는 프로필에서 확인하세요", "구매 링크는 프로필에서 확인하실 수 있습니다"),
    "comment": ("구매 링크는 댓글에서 확인하세요", "구매 링크는 댓글에서 확인하실 수 있습니다"),
}

SEGMENTS = {
    "hook": "첫 문장",
    "intro": "브랜드·상품 소개",
    "feature": "특징·사용 상황",
    "summary": "핵심 장점 정리",
    "outro": "마무리 화면",
}

# 25초 기준 구성(0-3 / 3-8 / 8-18 / 18-22 / 22-25)을 비율로 환산
SEGMENT_RATIO = [("hook", 3), ("intro", 5), ("feature", 10), ("summary", 4), ("outro", 3)]
MIN_SCENE_SEC = 1.2


# ---------------------------------------------------------------- 한국어 조사
_DIGIT_BATCHIM = {"0": True, "1": True, "2": False, "3": True, "4": False, "5": False,
                  "6": True, "7": True, "8": True, "9": False}


def _last_char(word: str) -> str:
    word = re.sub(r"[\s\)\]\}\"'”’.,!?]+$", "", word)
    return word[-1] if word else ""


def _batchim(word: str) -> tuple[bool, bool]:
    """(받침 있음, 받침이 ㄹ) — 한글이 아니면 근사값."""
    ch = _last_char(word)
    if not ch:
        return False, False
    code = ord(ch)
    if 0xAC00 <= code <= 0xD7A3:
        jong = (code - 0xAC00) % 28
        return jong != 0, jong == 8
    if ch.isdigit():
        return _DIGIT_BATCHIM[ch], ch in "178"
    if ch.lower() in "lmnr":
        return True, ch.lower() in "lr"
    return False, False


def josa(word: str, pair: str) -> str:
    """josa('사과', '을/를') -> '사과를'"""
    with_b, without_b = pair.split("/")
    has, is_rieul = _batchim(word)
    if pair == "으로/로":
        return word + ("로" if (not has or is_rieul) else "으로")
    return word + (with_b if has else without_b)


# ---------------------------------------------------------------- 검사
def find_expressions(text: str, expressions: list[str]) -> list[str]:
    low = text.lower()
    return [e for e in expressions if e and e.lower() in low]


def check_product(product: dict) -> dict:
    """입력값 검증: errors 는 생성 차단, warnings 는 안내."""
    errors, warnings = [], []
    if not product.get("brand"):
        errors.append("브랜드명을 입력하세요.")
    if not product.get("name"):
        errors.append("상품명을 입력하세요.")
    link = product.get("link", "")
    if not link:
        errors.append("상품 구매 링크 또는 제휴 링크를 입력하세요.")
    elif not re.match(r"^https?://\S+$", link):
        errors.append("구매 링크는 http:// 또는 https:// 로 시작하고 공백이 없어야 합니다.")
    feats = product.get("features", [])
    if not 1 <= len(feats) <= 3:
        errors.append("확인된 상품 특징을 1~3개 입력하세요.")
    n = len(product.get("photos", []))
    if not 5 <= n <= 10:
        errors.append(f"상품 사진은 5~10장이 필요합니다. (현재 {n}장)")
    if product.get("promo") and not product.get("promo_period"):
        warnings.append("행사 정보에 적용 기간이 없어 영상·게시글에는 행사 정보를 넣지 않습니다.")
    if not product.get("disclosure"):
        warnings.append("경제적 이해관계 표시 문구가 비어 있습니다. 브랜드커넥트 활동 게시물에는 최신 공식 안내에 따른 표시 문구를 넣으세요.")
    user_text = " ".join([product.get("brand", ""), product.get("name", ""), *feats,
                          product.get("target", ""), product.get("situation", ""),
                          product.get("promo", ""), *product.get("must_include", [])])
    risky = find_expressions(user_text, RISKY_EXPRESSIONS)
    if risky:
        warnings.append("입력한 정보에 근거 확인이 필요한 표현이 있습니다: " + ", ".join(sorted(set(risky)))
                        + " — 실제 근거가 확인된 경우에만 사용하세요.")
    conflict = find_expressions(" ".join([*feats, *product.get("must_include", [])]), product.get("exclude", []))
    if conflict:
        errors.append("‘반드시 넣을 표현’ 또는 특징에 ‘제외할 표현’이 포함되어 있습니다: " + ", ".join(conflict))
    for p in product.get("photos", []):
        if p.get("role", "unset") == "unset":
            warnings.append("역할이 지정되지 않은 사진이 있습니다. 업로드 순서대로 사용합니다.")
            break
    return {"errors": errors, "warnings": warnings}


def cta_text(mode: str, tone: str, custom: str = "") -> str:
    if mode == "custom" and custom.strip():
        return custom.strip()
    pair = _CTA_TEXT.get(mode, _CTA_TEXT["unset"])
    return pair[1] if tone == "polite" else pair[0]


# ---------------------------------------------------------------- 첫 문장
def hook_candidates(product: dict) -> list[str]:
    tone = product.get("tone", "friendly")
    brand, name = product["brand"], product["name"]
    situation, target = product.get("situation", ""), product.get("target", "")
    excl = product.get("exclude", [])
    c = []
    if tone == "polite":
        if situation:
            c.append(f"{situation}에 쓸 제품을 찾고 계신가요?")
        if target:
            c.append(f"{josa(target, '이라면/라면')} 한번 살펴보세요")
        c.append(f"{brand} {josa(name, '을/를')} 소개합니다")
        c.append("오늘 소개할 제품을 함께 보시죠")
    elif tone == "lively":
        if situation:
            c.append(f"{situation} 준비 중이라면 주목!")
        if target:
            c.append(f"{josa(target, '이라면/라면')} 이거 보세요!")
        c.append(f"{brand} {name}, 같이 볼까요?")
        c.append("오늘의 아이템 공개!")
    else:
        if situation:
            c.append(f"{situation}에 쓸 아이템 찾고 있다면?")
        if target:
            c.append(f"{josa(target, '이라면/라면')} 한번 보세요")
        c.append(f"{brand} {name}, 어떤 제품인지 볼게요")
        c.append("오늘 소개할 아이템, 같이 볼까요?")
    return [h for h in c if not find_expressions(h, excl)] or [f"{brand} {name}"]


# ---------------------------------------------------------------- 장면 구성
def _ordered_photos(product: dict) -> list[dict]:
    return list(product.get("photos", []))


def suggest_order(photos: list[dict]) -> list[str]:
    """역할 기준 추천 순서: 제품 전체 → 세부 특징 → 사용 장면 → 포장 → 기타/미지정 (같은 역할은 기존 순서 유지)."""
    rank = {"hero": 0, "detail": 1, "usage": 2, "package": 3, "other": 4, "unset": 5}
    return [p["id"] for p in sorted(photos, key=lambda p: rank.get(p.get("role", "unset"), 5))]


def _segment_lengths(total: float) -> dict:
    s = sum(r for _, r in SEGMENT_RATIO)
    return {k: total * r / s for k, r in SEGMENT_RATIO}


def _allocate_photos(n: int, seg: dict) -> dict:
    cap = {k: max(1, int(seg[k] // MIN_SCENE_SEC)) for k in ("hook", "intro", "feature", "summary")}
    alloc = {"hook": 1, "intro": 1, "summary": 1, "feature": n - 3}
    overflow = max(0, alloc["feature"] - cap["feature"])
    alloc["feature"] -= overflow
    for k in ("intro", "summary", "hook"):
        room = cap[k] - alloc[k]
        take = min(room, overflow)
        alloc[k] += take
        overflow -= take
    if overflow > 0:
        raise ValueError("선택한 영상 길이에 비해 사진이 너무 많습니다. 더 긴 영상 길이를 선택하거나 사진 수를 줄이세요.")
    return alloc


def _split(total: float, n: int) -> list[float]:
    base = round(total / n, 2)
    parts = [base] * n
    parts[-1] = round(total - base * (n - 1), 2)
    return parts


def feature_items(product: dict) -> list[dict]:
    tone = product.get("tone", "friendly")
    items = [{"caption": f, "narration": f} for f in product.get("features", [])]
    situation = product.get("situation")
    if situation:
        if tone == "polite":
            items.append({"caption": f"{situation}에\n사용해 보세요", "narration": f"{situation}에 사용해 보시기 바랍니다."})
        else:
            items.append({"caption": f"{situation}에\n사용해 보세요", "narration": f"{situation}에 사용해 보세요."})
    return items


def _promo_ok(product: dict) -> bool:
    return bool(product.get("promo") and product.get("promo_period"))


def build_scenes(product: dict, duration: float, hook: str, settings: dict) -> list[dict]:
    photos = _ordered_photos(product)
    n = len(photos)
    if n < 5:
        raise ValueError("사진이 5장 이상 필요합니다.")
    tone = product.get("tone", "friendly")
    brand, name = product["brand"], product["name"]
    seg = _segment_lengths(duration)
    alloc = _allocate_photos(n, seg)
    queue = list(photos)
    hero = next((p for p in photos if p.get("role") == "hero"), photos[0])
    scenes = []

    def add(segment, photo, caption, dur, narration="", style="normal"):
        scenes.append({"id": f"s{len(scenes) + 1}", "segment": segment, "photo_id": photo["id"],
                       "caption": caption, "style": style, "duration": dur, "motion": "auto",
                       "narration": narration})

    # 1) 첫 문장
    for i, d in enumerate(_split(seg["hook"], alloc["hook"])):
        add("hook", queue.pop(0), hook, d, hook if i == 0 else "")

    # 2) 브랜드·상품 소개 (브랜드명·상품명 필수 노출)
    if tone == "polite":
        intro_narr = f"{brand} {josa(name, '을/를')} 소개합니다."
    else:
        intro_narr = f"{brand} {josa(name, '이에요/예요')}."
    intro_caps = [f"{brand}\n{name}"]
    if product.get("target"):
        intro_caps.append(f"이런 분께 추천해요\n{product['target']}" if tone != "polite"
                          else f"이런 분께 추천합니다\n{product['target']}")
    for i, d in enumerate(_split(seg["intro"], alloc["intro"])):
        cap = intro_caps[min(i, len(intro_caps) - 1)] if i < len(intro_caps) else intro_caps[0]
        add("intro", queue.pop(0), cap, d, intro_narr if i == 0 else "", "title" if cap == intro_caps[0] else "normal")

    # 3) 특징·사용 상황 — 문구 수가 사진보다 많으면 사진을 다시 사용, 적으면 같은 자막 유지
    items = feature_items(product)
    feat_photos = [queue.pop(0) for _ in range(alloc["feature"])]
    n_scenes = max(len(feat_photos), len(items))
    for i, d in enumerate(_split(seg["feature"], n_scenes)):
        photo = feat_photos[i % len(feat_photos)]
        item_idx = min(i * len(items) // n_scenes, len(items) - 1)
        first_of_item = i == 0 or (i - 1) * len(items) // n_scenes != item_idx
        it = items[item_idx]
        add("feature", photo, it["caption"], d, it["narration"] if first_of_item else "")

    # 4) 핵심 장점 정리
    feats = product.get("features", [])
    must = product.get("must_include", [])
    if must:
        summary_cap = must[0]
    elif len(feats) >= 2 and len(feats[0]) <= 14 and len(feats[1]) <= 14:
        summary_cap = f"{feats[0]}\n{feats[1]}"
    else:
        summary_cap = feats[0]
    summary_narr = summary_cap.replace(chr(10), ", ") + "."
    summary_caps = [summary_cap]
    extra = []
    if product.get("price") and settings.get("show_price", True):
        extra.append(f"가격 {product['price']}")
    if _promo_ok(product):
        extra.append(f"{product['promo']}\n{product['promo_period']}")
    summary_caps += extra
    for i, d in enumerate(_split(seg["summary"], alloc["summary"])):
        cap = summary_caps[i] if i < len(summary_caps) else summary_caps[0]
        add("summary", queue.pop(0), cap, d, summary_narr if i == 0 else "")

    # 5) 마무리 화면 (브랜드명·상품명·구매 안내)
    cta = cta_text(settings.get("cta_mode", "unset"), tone, settings.get("cta_custom", ""))
    scenes.append({"id": f"s{len(scenes) + 1}", "segment": "outro", "photo_id": hero["id"], "caption": "",
                   "style": "card", "duration": round(seg["outro"], 2), "motion": "none",
                   "narration": outro_narration(brand, name, settings.get("cta_mode", "unset"), tone, cta),
                   "cta": cta})
    _fix_total(scenes, duration)
    return scenes


def outro_narration(brand: str, name: str, mode: str, tone: str, cta: str) -> str:
    """마무리 화면은 짧으므로 내레이션은 브랜드·상품명과 짧은 안내만 읽는다."""
    short = {"unset": "", "post_link": "링크는 게시글에 있어요", "product_tag": "상품 태그에서 확인하세요",
             "profile": "링크는 프로필에 있어요", "comment": "링크는 댓글에 있어요"}
    if mode == "custom":
        tail = cta
    else:
        tail = short.get(mode, "")
        if tail and tone == "polite":
            tail = tail.replace("있어요", "있습니다").replace("확인하세요", "확인하실 수 있습니다")
    # 브랜드명·상품명은 화면에 크게 표시되고 소개 장면에서 이미 읽으므로, 안내가 있으면 안내만 읽는다
    return f"{tail}." if tail else f"{brand}."


def _fix_total(scenes: list[dict], duration: float) -> None:
    diff = round(duration - sum(s["duration"] for s in scenes), 2)
    scenes[-1]["duration"] = round(scenes[-1]["duration"] + diff, 2)


def scene_texts(scenes: list[dict]) -> list[str]:
    out = []
    for s in scenes:
        out += [s.get("caption", ""), s.get("narration", ""), s.get("cta", "")]
    return [t for t in out if t]


def check_scenes(product: dict, scenes: list[dict], settings: dict) -> dict:
    errors, warnings = [], []
    if not scenes:
        errors.append("장면이 없습니다.")
        return {"errors": errors, "warnings": warnings}
    photo_ids = {p["id"] for p in product.get("photos", [])}
    total = sum(float(s.get("duration", 0)) for s in scenes)
    if not 5 <= total <= 90:
        errors.append(f"전체 길이가 {total:.1f}초입니다. 5~90초 사이로 맞춰 주세요.")
    for i, s in enumerate(scenes, 1):
        if s.get("photo_id") not in photo_ids:
            errors.append(f"{i}번 장면의 사진이 삭제되었거나 없습니다. 사진을 다시 선택하세요.")
        if float(s.get("duration", 0)) < 0.5:
            errors.append(f"{i}번 장면 길이는 0.5초 이상이어야 합니다.")
        if s.get("caption", "").count("\n") >= 2:
            errors.append(f"{i}번 장면 자막이 두 줄을 넘습니다. 줄바꿈을 한 번만 사용하세요.")
    if scenes[-1].get("segment") != "outro":
        warnings.append("마지막 장면이 마무리 화면이 아닙니다. 브랜드명·상품명이 마지막에 표시되지 않을 수 있습니다.")
    brand, name = product.get("brand", ""), product.get("name", "")
    early = " ".join(s.get("caption", "") for s in scenes[:3]).replace("\n", " ")
    if not (brand in early and name.replace("\n", " ") in early):
        warnings.append("도입부(앞 3개 장면) 자막에 브랜드명과 상품명이 모두 보이지 않습니다.")
    texts = " ".join(scene_texts(scenes)) + " " + settings.get("cta_custom", "")
    excluded = find_expressions(texts, product.get("exclude", []))
    if excluded:
        errors.append("자막·내레이션에 ‘제외할 표현’이 있습니다: " + ", ".join(excluded))
    user_inputs = " ".join([*product.get("features", []), product.get("situation", ""), product.get("target", ""),
                            *product.get("must_include", []), brand, name])
    risky = [r for r in find_expressions(texts, RISKY_EXPRESSIONS) if r not in find_expressions(user_inputs, [r])]
    if risky:
        warnings.append("직접 수정한 문구에 근거 확인이 필요한 표현이 있습니다: " + ", ".join(sorted(set(risky))))
    if settings.get("cta_mode", "unset") == "unset":
        warnings.append("구매 링크 위치가 확인되지 않아 마무리 문구를 중립 문구로 표시합니다.")
    return {"errors": errors, "warnings": warnings}


# ---------------------------------------------------------------- 게시글
def count_chars(text: str) -> int:
    """공백·줄바꿈 포함 글자 수(유니코드 코드포인트 기준, 줄바꿈 1자)."""
    return len(text.replace("\r\n", "\n"))


def _hashtag(word: str) -> str:
    w = re.sub(r"[^0-9A-Za-z가-힣_]", "", word)
    return f"#{w}" if 1 <= len(w) <= 15 else ""


def build_post(product: dict, settings: dict, hook: str) -> dict:
    tone = product.get("tone", "friendly")
    include_link = bool(settings.get("post_include_link", True))
    disclosure = product.get("disclosure", "").strip()
    disclosure_pos = settings.get("disclosure_position", "top")
    feats = product.get("features", [])
    excl = product.get("exclude", [])

    # (key, text, 필수 여부, 줄임 우선순위: 작을수록 먼저 삭제)
    blocks = []
    if disclosure and disclosure_pos == "top":
        blocks.append(("disclosure", disclosure, True, 99))
    blocks.append(("hook", hook, False, 90))
    blocks.append(("title", f"{product['brand']} {product['name']}", True, 99))
    for i, f in enumerate(feats):
        blocks.append((f"feature{i}", f"· {f}", i == 0, 60 - i * 5))
    if product.get("situation"):
        blocks.append(("situation", f"추천 상황: {product['situation']}", False, 30))
    if product.get("target"):
        blocks.append(("target", f"이런 분께: {product['target']}", False, 20))
    if product.get("price") and settings.get("show_price", True):
        blocks.append(("price", f"가격: {product['price']}", False, 40))
    if _promo_ok(product):
        blocks.append(("promo", f"행사: {product['promo']} ({product['promo_period']})", False, 45))
    all_text = " ".join(b[1] for b in blocks)
    missing_must = [m for m in product.get("must_include", []) if m not in all_text]
    if missing_must:
        blocks.append(("must", " ".join(missing_must), True, 99))
    if include_link:
        blocks.append(("link", f"구매 링크: {product['link']}", True, 99))
    else:
        blocks.append(("cta", cta_text(settings.get("cta_mode", "unset"), tone, settings.get("cta_custom", "")) + ".",
                       True, 99))
    tags = []
    for cand in (product["brand"], product["name"], product.get("situation", "")):
        t = _hashtag(cand)
        if t and t not in tags:
            tags.append(t)
    tags = tags[:3]
    if disclosure and disclosure_pos == "bottom":
        blocks.append(("disclosure", disclosure, True, 99))

    # 제외할 표현이 들어간 선택 항목은 빼고, 필수 항목이면 오류
    errors, warnings, dropped = [], [], []
    kept = []
    for b in blocks:
        hit = find_expressions(b[1], excl)
        if hit and not b[2]:
            dropped.append(b[0])
            continue
        if hit and b[2] and b[0] != "link":
            errors.append(f"필수 항목에 ‘제외할 표현’({', '.join(hit)})이 있습니다.")
        kept.append(b)
    tags = [t for t in tags if not find_expressions(t, excl)]

    def compose(bs, ts):
        lines = []
        for key, text, _, _ in bs:
            if key in ("title", "link", "cta", "disclosure") and lines and lines[-1] != "":
                lines.append("")
            lines.append(text)
            if key == "disclosure" and disclosure_pos == "top":
                lines.append("")
        body = "\n".join(lines).strip()
        body = re.sub(r"\n{3,}", "\n\n", body)
        if ts:
            body += "\n\n" + " ".join(ts)
        return body

    text = compose(kept, tags)
    # 300자 초과 시: 해시태그 → 부가 설명(낮은 우선순위부터) 순으로 줄인다. 필수 항목은 삭제·축약하지 않는다.
    while count_chars(text) > POST_LIMIT and tags:
        dropped.append(tags.pop())
        text = compose(kept, tags)
    optional = sorted([b for b in kept if not b[2]], key=lambda b: b[3])
    while count_chars(text) > POST_LIMIT and optional:
        b = optional.pop(0)
        kept.remove(b)
        dropped.append(b[0])
        text = compose(kept, tags)

    status = "ok"
    n = count_chars(text)
    if n > POST_LIMIT:
        status = "over_required"
        if include_link:
            errors.append(f"필수 정보만으로 {n}자로 300자를 넘습니다. ‘게시글에 링크 포함’을 끄고 구매 링크는 별도 복사해 붙여 넣으세요.")
        else:
            errors.append(f"필수 정보만으로 {n}자로 300자를 넘습니다. 특징 문구를 짧게 수정하세요(표시 문구는 줄이지 않습니다).")
    if len(tags) < 2:
        warnings.append("해시태그는 공간이 부족하거나 만들 수 있는 후보가 적어 2개 미만입니다.")
    if not disclosure:
        warnings.append("경제적 이해관계 표시 문구가 없습니다.")
    return {"text": text, "count": n, "limit": POST_LIMIT, "status": status, "dropped": dropped,
            "errors": errors, "warnings": warnings, "include_link": include_link}


def check_post(product: dict, text: str, include_link: bool) -> dict:
    errors, warnings = [], []
    n = count_chars(text)
    if n > POST_LIMIT:
        errors.append(f"게시글이 {n}자로 300자를 넘습니다.")
    if product.get("disclosure") and product["disclosure"] not in text:
        errors.append("경제적 이해관계 표시 문구가 원문 그대로 포함되어 있지 않습니다.")
    if include_link and product.get("link") and product["link"] not in text:
        errors.append("게시글에 구매 링크가 원본 그대로 포함되어 있지 않습니다(링크가 변경되었거나 빠졌습니다).")
    if product.get("brand") not in text or product.get("name") not in text:
        warnings.append("게시글에 브랜드명과 상품명이 정확히 들어 있는지 확인하세요.")
    ex = find_expressions(text, product.get("exclude", []))
    if ex:
        errors.append("게시글에 ‘제외할 표현’이 있습니다: " + ", ".join(ex))
    user_inputs = " ".join([*product.get("features", []), *product.get("must_include", []),
                            product.get("situation", ""), product.get("target", ""), product.get("promo", ""),
                            product.get("disclosure", ""), product.get("name", ""), product.get("brand", "")])
    risky = [r for r in find_expressions(text, RISKY_EXPRESSIONS) if not find_expressions(user_inputs, [r])]
    if risky:
        warnings.append("근거 확인이 필요한 표현이 있습니다: " + ", ".join(sorted(set(risky))))
    return {"count": n, "limit": POST_LIMIT, "errors": errors, "warnings": warnings}
