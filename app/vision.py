"""선택 기능: Claude API(유료)로 사진 역할 추정 + 사진 속 문자 후보 추출.

결과는 '후보'일 뿐이며 사용자가 확인하기 전에는 확정 정보로 쓰지 않는다.
API 키는 서버 환경 변수(ANTHROPIC_API_KEY)로만 읽는다.
"""
import base64
import io
import json

from PIL import Image

from .config import ANTHROPIC_API_KEY, VISION_MODEL

ROLES = ["hero", "detail", "usage", "package", "other"]

_SCHEMA = {
    "type": "object",
    "properties": {
        "photos": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "role": {"type": "string", "enum": ROLES},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                    "visible_text": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["index", "role", "confidence", "reason", "visible_text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["photos"],
    "additionalProperties": False,
}

_PROMPT = """상품 홍보 숏폼 영상 제작을 위해 아래 상품 사진들을 분류해 주세요.
각 사진(index 0부터)에 대해:
- role: hero(제품 전체 모습), detail(세부 특징·클로즈업), usage(사용 장면·사람/공간 속 제품), package(포장·박스·구성품), other(기타)
- confidence: 0~1 사이 확신도. 애매하면 낮게.
- reason: 판단 근거 한 문장(한국어)
- visible_text: 사진에 실제로 인쇄·표시된 문자를 보이는 그대로 옮긴 것(최대 8개). 읽기 어려우면 넣지 말 것. 추측하거나 보이지 않는 정보(효능·성분·인증 등)를 만들어내지 말 것.
"""


def status() -> dict:
    if ANTHROPIC_API_KEY:
        return {"connected": True, "provider": "Claude API", "model": VISION_MODEL, "paid": True,
                "detail": "‘사진 자동 분석’을 누를 때마다 사진 수만큼 이미지를 보내 1회 호출(유료)합니다."}
    return {"connected": False, "provider": "Claude API", "model": VISION_MODEL, "paid": True,
            "detail": "미연결 — .env 에 ANTHROPIC_API_KEY 를 넣으면 사진 역할 추정·문자 후보 추출을 쓸 수 있습니다. "
                      "미연결 상태에서는 사진 역할을 직접 선택합니다."}


def _encode(path) -> str:
    img = Image.open(path).convert("RGB")
    img.thumbnail((1024, 1024), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return base64.standard_b64encode(buf.getvalue()).decode()


def analyze(photo_paths: list) -> list[dict]:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("사진 분석 API가 연결되지 않았습니다.")
    import anthropic

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    content = []
    for i, p in enumerate(photo_paths):
        content.append({"type": "text", "text": f"사진 index {i}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": _encode(p)}})
    content.append({"type": "text", "text": _PROMPT})
    try:
        resp = client.beta.messages.create(
            model=VISION_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.AuthenticationError:
        raise RuntimeError("API 키가 올바르지 않습니다(인증 실패).")
    except anthropic.RateLimitError:
        raise RuntimeError("API 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요.")
    except anthropic.APIStatusError as e:
        raise RuntimeError(f"사진 분석 API 오류: HTTP {e.status_code}")
    except anthropic.APIConnectionError:
        raise RuntimeError("사진 분석 API에 연결할 수 없습니다(네트워크 확인).")
    if resp.stop_reason == "refusal":
        raise RuntimeError("사진 분석 요청이 거절되었습니다. 역할을 직접 선택하세요.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    data = json.loads(text)
    return data["photos"]
