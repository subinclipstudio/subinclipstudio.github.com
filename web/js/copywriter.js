// 확인된 상품 정보만으로 첫 문장·장면 자막·게시글을 만든다 (app/copywriter.py 의 브라우저판).
// 고정 문구에는 효능·성분·인증·판매량·할인율 같은 사실 주장을 넣지 않는다.

export const POST_LIMIT = 300;

export const RISKY_EXPRESSIONS = [
  "최고", "최상", "최초", "1위", "넘버원", "No.1", "no.1", "유일", "완벽", "100%", "최저가", "역대급",
  "완판", "품절 임박", "마감 임박", "지금 당장", "서두르세요", "놓치면 후회", "무조건", "효과 보장",
  "부작용 없", "무첨가", "천연", "유기농", "인증", "특허", "판매량", "누적 판매", "할인율", "기적",
  "치료", "완치", "의사 추천", "전문가 추천", "단 하루", "마지막 기회",
];

export const TONES = { friendly: "친근한 말투(해요체)", polite: "차분한 말투(합니다체)", lively: "발랄한 말투" };

export const CTA_MODES = {
  unset: "링크 위치 미정 (중립 문구)", post_link: "게시글 본문 링크", product_tag: "상품 태그",
  profile: "프로필 링크", comment: "댓글 링크", custom: "직접 입력",
};

const CTA_TEXT = {
  unset: ["자세한 정보를 확인해 보세요", "자세한 정보를 확인해 보시기 바랍니다"],
  post_link: ["구매 링크는 게시글에서 확인하세요", "구매 링크는 게시글에서 확인하실 수 있습니다"],
  product_tag: ["상품 정보는 상품 태그에서 확인하세요", "상품 정보는 상품 태그에서 확인하실 수 있습니다"],
  profile: ["구매 링크는 프로필에서 확인하세요", "구매 링크는 프로필에서 확인하실 수 있습니다"],
  comment: ["구매 링크는 댓글에서 확인하세요", "구매 링크는 댓글에서 확인하실 수 있습니다"],
};

export const SEGMENTS = { hook: "첫 문장", intro: "브랜드·상품 소개", feature: "특징·사용 상황", summary: "핵심 장점 정리", outro: "마무리 화면" };
export const ROLES = { unset: "역할 미지정", hero: "제품 전체", detail: "세부 특징", usage: "사용 장면", package: "포장", other: "기타" };

// 25초 기준 구성(0-3 / 3-8 / 8-18 / 18-22 / 22-25)을 비율로 환산
const SEGMENT_RATIO = [["hook", 3], ["intro", 5], ["feature", 10], ["summary", 4], ["outro", 3]];
const MIN_SCENE_SEC = 1.2;

/* ---------------------------------------------------------------- 한국어 조사 */
const DIGIT_BATCHIM = { 0: true, 1: true, 2: false, 3: true, 4: false, 5: false, 6: true, 7: true, 8: true, 9: false };

function batchim(word) {
  const w = word.replace(/[\s)\]}"'”’.,!?]+$/, "");
  const ch = w.slice(-1);
  if (!ch) return [false, false];
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return [jong !== 0, jong === 8];
  }
  if (/\d/.test(ch)) return [DIGIT_BATCHIM[ch], "178".includes(ch)];
  if ("lmnr".includes(ch.toLowerCase())) return [true, "lr".includes(ch.toLowerCase())];
  return [false, false];
}

export function josa(word, pair) {
  const [withB, withoutB] = pair.split("/");
  const [has, rieul] = batchim(word);
  if (pair === "으로/로") return word + (!has || rieul ? "로" : "으로");
  return word + (has ? withB : withoutB);
}

/* ---------------------------------------------------------------- 검사 */
export function findExpressions(text, expressions) {
  const low = String(text).toLowerCase();
  return expressions.filter((e) => e && low.includes(e.toLowerCase()));
}

export function countChars(text) {
  return [...String(text).replace(/\r\n/g, "\n")].length;
}

export function checkProduct(p) {
  const errors = [], warnings = [];
  if (!p.brand) errors.push("브랜드명을 입력하세요.");
  if (!p.name) errors.push("상품명을 입력하세요.");
  if (!p.link) errors.push("상품 구매 링크 또는 제휴 링크를 입력하세요.");
  else if (!/^https?:\/\/\S+$/.test(p.link)) errors.push("구매 링크는 http:// 또는 https:// 로 시작하고 공백이 없어야 합니다.");
  const feats = p.features || [];
  if (feats.length < 1 || feats.length > 3) errors.push("확인된 상품 특징을 1~3개 입력하세요.");
  const n = (p.photos || []).length;
  if (n < 5 || n > 10) errors.push(`상품 사진은 5~10장이 필요합니다. (현재 ${n}장)`);
  if (p.promo && !p.promo_period) warnings.push("행사 정보에 적용 기간이 없어 영상·게시글에는 행사 정보를 넣지 않습니다.");
  if (!p.disclosure) warnings.push("경제적 이해관계 표시 문구가 비어 있습니다. 브랜드커넥트 활동 게시물에는 최신 공식 안내에 따른 표시 문구를 넣으세요.");
  const userText = [p.brand, p.name, ...feats, p.target, p.situation, p.promo, ...(p.must_include || [])].join(" ");
  const risky = findExpressions(userText, RISKY_EXPRESSIONS);
  if (risky.length) warnings.push("입력한 정보에 근거 확인이 필요한 표현이 있습니다: " + [...new Set(risky)].sort().join(", ") + " — 실제 근거가 확인된 경우에만 사용하세요.");
  const conflict = findExpressions([...feats, ...(p.must_include || [])].join(" "), p.exclude || []);
  if (conflict.length) errors.push("‘반드시 넣을 표현’ 또는 특징에 ‘제외할 표현’이 포함되어 있습니다: " + conflict.join(", "));
  if ((p.photos || []).some((ph) => (ph.role || "unset") === "unset")) warnings.push("역할이 지정되지 않은 사진이 있습니다. 업로드 순서대로 사용합니다.");
  return { errors, warnings };
}

export function ctaText(mode, tone, custom = "") {
  if (mode === "custom" && custom.trim()) return custom.trim();
  const pair = CTA_TEXT[mode] || CTA_TEXT.unset;
  return tone === "polite" ? pair[1] : pair[0];
}

export function outroNarration(brand, name, mode, tone, cta) {
  const short = { unset: "", post_link: "링크는 게시글에 있어요", product_tag: "상품 태그에서 확인하세요",
    profile: "링크는 프로필에 있어요", comment: "링크는 댓글에 있어요" };
  let tail = mode === "custom" ? cta : short[mode] || "";
  if (tail && tone === "polite" && mode !== "custom") tail = tail.replace("있어요", "있습니다").replace("확인하세요", "확인하실 수 있습니다");
  return tail ? `${tail}.` : `${brand}.`;
}

/* ---------------------------------------------------------------- 첫 문장 */
export function hookCandidates(p) {
  const tone = p.tone || "friendly";
  const { brand, name } = p;
  const situation = p.situation || "", target = p.target || "";
  const c = [];
  if (tone === "polite") {
    if (situation) c.push(`${situation}에 쓸 제품을 찾고 계신가요?`);
    if (target) c.push(`${josa(target, "이라면/라면")} 한번 살펴보세요`);
    c.push(`${brand} ${josa(name, "을/를")} 소개합니다`);
    c.push("오늘 소개할 제품을 함께 보시죠");
  } else if (tone === "lively") {
    if (situation) c.push(`${situation} 준비 중이라면 주목!`);
    if (target) c.push(`${josa(target, "이라면/라면")} 이거 보세요!`);
    c.push(`${brand} ${name}, 같이 볼까요?`);
    c.push("오늘의 아이템 공개!");
  } else {
    if (situation) c.push(`${situation}에 쓸 아이템 찾고 있다면?`);
    if (target) c.push(`${josa(target, "이라면/라면")} 한번 보세요`);
    c.push(`${brand} ${name}, 어떤 제품인지 볼게요`);
    c.push("오늘 소개할 아이템, 같이 볼까요?");
  }
  const ok = c.filter((h) => !findExpressions(h, p.exclude || []).length);
  return ok.length ? ok : [`${brand} ${name}`];
}

/* ---------------------------------------------------------------- 장면 구성 */
export function suggestOrder(photos) {
  const rank = { hero: 0, detail: 1, usage: 2, package: 3, other: 4, unset: 5 };
  return photos.map((p, i) => [p, i]).sort((a, b) => (rank[a[0].role] ?? 5) - (rank[b[0].role] ?? 5) || a[1] - b[1]).map((x) => x[0].id);
}

function segmentLengths(total) {
  const s = SEGMENT_RATIO.reduce((a, [, r]) => a + r, 0);
  return Object.fromEntries(SEGMENT_RATIO.map(([k, r]) => [k, (total * r) / s]));
}

function allocatePhotos(n, seg) {
  const cap = {};
  for (const k of ["hook", "intro", "feature", "summary"]) cap[k] = Math.max(1, Math.floor(seg[k] / MIN_SCENE_SEC));
  const alloc = { hook: 1, intro: 1, summary: 1, feature: n - 3 };
  let overflow = Math.max(0, alloc.feature - cap.feature);
  alloc.feature -= overflow;
  for (const k of ["intro", "summary", "hook"]) {
    const take = Math.min(cap[k] - alloc[k], overflow);
    alloc[k] += take;
    overflow -= take;
  }
  if (overflow > 0) throw new Error("선택한 영상 길이에 비해 사진이 너무 많습니다. 더 긴 영상 길이를 선택하거나 사진 수를 줄이세요.");
  return alloc;
}

function split(total, n) {
  const base = Math.round((total / n) * 100) / 100;
  const parts = Array(n).fill(base);
  parts[n - 1] = Math.round((total - base * (n - 1)) * 100) / 100;
  return parts;
}

function featureItems(p) {
  const items = (p.features || []).map((f) => ({ caption: f, narration: f }));
  if (p.situation) {
    items.push({ caption: `${p.situation}에\n사용해 보세요`,
      narration: p.tone === "polite" ? `${p.situation}에 사용해 보시기 바랍니다.` : `${p.situation}에 사용해 보세요.` });
  }
  return items;
}

const promoOk = (p) => !!(p.promo && p.promo_period);

export function buildScenes(p, duration, hook, settings) {
  const photos = [...(p.photos || [])];
  const n = photos.length;
  if (n < 5) throw new Error("사진이 5장 이상 필요합니다.");
  const tone = p.tone || "friendly";
  const { brand, name } = p;
  const seg = segmentLengths(duration);
  const alloc = allocatePhotos(n, seg);
  const queue = [...photos];
  const hero = photos.find((ph) => ph.role === "hero") || photos[0];
  const scenes = [];
  const add = (segment, photo, caption, dur, narration = "", style = "normal") =>
    scenes.push({ id: `s${scenes.length + 1}`, segment, photo_id: photo.id, caption, style, duration: dur, motion: "auto", narration });

  split(seg.hook, alloc.hook).forEach((d, i) => add("hook", queue.shift(), hook, d, i === 0 ? hook : ""));

  const introNarr = tone === "polite" ? `${brand} ${josa(name, "을/를")} 소개합니다.` : `${brand} ${josa(name, "이에요/예요")}.`;
  const introCaps = [`${brand}\n${name}`];
  if (p.target) introCaps.push(tone !== "polite" ? `이런 분께 추천해요\n${p.target}` : `이런 분께 추천합니다\n${p.target}`);
  split(seg.intro, alloc.intro).forEach((d, i) => {
    const cap = i < introCaps.length ? introCaps[i] : introCaps[0];
    add("intro", queue.shift(), cap, d, i === 0 ? introNarr : "", cap === introCaps[0] ? "title" : "normal");
  });

  const items = featureItems(p);
  const featPhotos = Array.from({ length: alloc.feature }, () => queue.shift());
  const nScenes = Math.max(featPhotos.length, items.length);
  split(seg.feature, nScenes).forEach((d, i) => {
    const photo = featPhotos[i % featPhotos.length];
    const idx = Math.min(Math.floor((i * items.length) / nScenes), items.length - 1);
    const first = i === 0 || Math.floor(((i - 1) * items.length) / nScenes) !== idx;
    add("feature", photo, items[idx].caption, d, first ? items[idx].narration : "");
  });

  const feats = p.features || [];
  const must = p.must_include || [];
  let summaryCap;
  if (must.length) summaryCap = must[0];
  else if (feats.length >= 2 && feats[0].length <= 14 && feats[1].length <= 14) summaryCap = `${feats[0]}\n${feats[1]}`;
  else summaryCap = feats[0];
  const summaryNarr = summaryCap.replace(/\n/g, ", ") + ".";
  const summaryCaps = [summaryCap];
  if (p.price && settings.show_price !== false) summaryCaps.push(`가격 ${p.price}`);
  if (promoOk(p)) summaryCaps.push(`${p.promo}\n${p.promo_period}`);
  split(seg.summary, alloc.summary).forEach((d, i) => {
    add("summary", queue.shift(), i < summaryCaps.length ? summaryCaps[i] : summaryCaps[0], d, i === 0 ? summaryNarr : "");
  });

  const cta = ctaText(settings.cta_mode || "unset", tone, settings.cta_custom || "");
  scenes.push({ id: `s${scenes.length + 1}`, segment: "outro", photo_id: hero.id, caption: "", style: "card",
    duration: Math.round(seg.outro * 100) / 100, motion: "none",
    narration: outroNarration(brand, name, settings.cta_mode || "unset", tone, cta), cta });
  const diff = Math.round((duration - scenes.reduce((a, s) => a + s.duration, 0)) * 100) / 100;
  scenes[scenes.length - 1].duration = Math.round((scenes[scenes.length - 1].duration + diff) * 100) / 100;
  return scenes;
}

export function sceneTexts(scenes) {
  return scenes.flatMap((s) => [s.caption, s.narration, s.cta]).filter(Boolean);
}

export function checkScenes(p, scenes, settings) {
  const errors = [], warnings = [];
  if (!scenes.length) return { errors: ["장면이 없습니다."], warnings };
  const ids = new Set((p.photos || []).map((ph) => ph.id));
  const total = scenes.reduce((a, s) => a + +s.duration, 0);
  if (total < 5 || total > 90) errors.push(`전체 길이가 ${total.toFixed(1)}초입니다. 5~90초 사이로 맞춰 주세요.`);
  scenes.forEach((s, i) => {
    if (!ids.has(s.photo_id)) errors.push(`${i + 1}번 장면의 사진이 삭제되었거나 없습니다. 사진을 다시 선택하세요.`);
    if (+s.duration < 0.5) errors.push(`${i + 1}번 장면 길이는 0.5초 이상이어야 합니다.`);
    if ((s.caption || "").split("\n").length > 2) errors.push(`${i + 1}번 장면 자막이 두 줄을 넘습니다. 줄바꿈을 한 번만 사용하세요.`);
  });
  if (scenes[scenes.length - 1].segment !== "outro") warnings.push("마지막 장면이 마무리 화면이 아닙니다. 브랜드명·상품명이 마지막에 표시되지 않을 수 있습니다.");
  const early = scenes.slice(0, 3).map((s) => s.caption || "").join(" ").replace(/\n/g, " ");
  if (!(early.includes(p.brand) && early.includes(p.name))) warnings.push("도입부(앞 3개 장면) 자막에 브랜드명과 상품명이 모두 보이지 않습니다.");
  const texts = sceneTexts(scenes).join(" ") + " " + (settings.cta_custom || "");
  const ex = findExpressions(texts, p.exclude || []);
  if (ex.length) errors.push("자막·내레이션에 ‘제외할 표현’이 있습니다: " + ex.join(", "));
  const userInputs = [...(p.features || []), p.situation, p.target, ...(p.must_include || []), p.brand, p.name].join(" ");
  const risky = findExpressions(texts, RISKY_EXPRESSIONS).filter((r) => !findExpressions(userInputs, [r]).length);
  if (risky.length) warnings.push("직접 수정한 문구에 근거 확인이 필요한 표현이 있습니다: " + [...new Set(risky)].sort().join(", "));
  if ((settings.cta_mode || "unset") === "unset") warnings.push("구매 링크 위치가 확인되지 않아 마무리 문구를 중립 문구로 표시합니다.");
  return { errors, warnings };
}

/* ---------------------------------------------------------------- 게시글 */
function hashtag(word) {
  const w = String(word || "").replace(/[^0-9A-Za-z가-힣_]/g, "");
  return w.length >= 1 && w.length <= 15 ? `#${w}` : "";
}

export function buildPost(p, settings, hook) {
  const tone = p.tone || "friendly";
  const includeLink = settings.post_include_link !== false;
  const disclosure = (p.disclosure || "").trim();
  const pos = settings.disclosure_position || "top";
  const feats = p.features || [];
  const excl = p.exclude || [];
  // [key, text, 필수, 줄임 우선순위(작을수록 먼저 삭제)]
  const blocks = [];
  if (disclosure && pos === "top") blocks.push(["disclosure", disclosure, true, 99]);
  blocks.push(["hook", hook, false, 90]);
  blocks.push(["title", `${p.brand} ${p.name}`, true, 99]);
  feats.forEach((f, i) => blocks.push([`feature${i}`, `· ${f}`, i === 0, 60 - i * 5]));
  if (p.situation) blocks.push(["situation", `추천 상황: ${p.situation}`, false, 30]);
  if (p.target) blocks.push(["target", `이런 분께: ${p.target}`, false, 20]);
  if (p.price && settings.show_price !== false) blocks.push(["price", `가격: ${p.price}`, false, 40]);
  if (promoOk(p)) blocks.push(["promo", `행사: ${p.promo} (${p.promo_period})`, false, 45]);
  const allText = blocks.map((b) => b[1]).join(" ");
  const missing = (p.must_include || []).filter((m) => !allText.includes(m));
  if (missing.length) blocks.push(["must", missing.join(" "), true, 99]);
  if (includeLink) blocks.push(["link", `구매 링크: ${p.link}`, true, 99]);
  else blocks.push(["cta", ctaText(settings.cta_mode || "unset", tone, settings.cta_custom || "") + ".", true, 99]);
  let tags = [];
  for (const c of [p.brand, p.name, p.situation]) { const t = hashtag(c); if (t && !tags.includes(t)) tags.push(t); }
  tags = tags.slice(0, 3);
  if (disclosure && pos === "bottom") blocks.push(["disclosure", disclosure, true, 99]);

  const errors = [], warnings = [], dropped = [], kept = [];
  for (const b of blocks) {
    const hit = findExpressions(b[1], excl);
    if (hit.length && !b[2]) { dropped.push(b[0]); continue; }
    if (hit.length && b[2] && b[0] !== "link") errors.push(`필수 항목에 ‘제외할 표현’(${hit.join(", ")})이 있습니다.`);
    kept.push(b);
  }
  tags = tags.filter((t) => !findExpressions(t, excl).length);

  const compose = (bs, ts) => {
    const lines = [];
    for (const [key, text] of bs) {
      if (["title", "link", "cta", "disclosure"].includes(key) && lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(text);
      if (key === "disclosure" && pos === "top") lines.push("");
    }
    let body = lines.join("\n").trim().replace(/\n{3,}/g, "\n\n");
    if (ts.length) body += "\n\n" + ts.join(" ");
    return body;
  };
  let text = compose(kept, tags);
  while (countChars(text) > POST_LIMIT && tags.length) { dropped.push(tags.pop()); text = compose(kept, tags); }
  const optional = kept.filter((b) => !b[2]).sort((a, b) => a[3] - b[3]);
  while (countChars(text) > POST_LIMIT && optional.length) {
    const b = optional.shift();
    kept.splice(kept.indexOf(b), 1);
    dropped.push(b[0]);
    text = compose(kept, tags);
  }
  const n = countChars(text);
  let status = "ok";
  if (n > POST_LIMIT) {
    status = "over_required";
    errors.push(includeLink
      ? `필수 정보만으로 ${n}자로 300자를 넘습니다. ‘게시글에 링크 포함’을 끄고 구매 링크는 별도 복사해 붙여 넣으세요.`
      : `필수 정보만으로 ${n}자로 300자를 넘습니다. 특징 문구를 짧게 수정하세요(표시 문구는 줄이지 않습니다).`);
  }
  if (tags.length < 2) warnings.push("해시태그는 공간이 부족하거나 만들 수 있는 후보가 적어 2개 미만입니다.");
  if (!disclosure) warnings.push("경제적 이해관계 표시 문구가 없습니다.");
  return { text, count: n, limit: POST_LIMIT, status, dropped, errors, warnings, include_link: includeLink };
}

export function checkPost(p, text, includeLink) {
  const errors = [], warnings = [];
  const n = countChars(text);
  if (n > POST_LIMIT) errors.push(`게시글이 ${n}자로 300자를 넘습니다.`);
  if (p.disclosure && !text.includes(p.disclosure)) errors.push("경제적 이해관계 표시 문구가 원문 그대로 포함되어 있지 않습니다.");
  if (includeLink && p.link && !text.includes(p.link)) errors.push("게시글에 구매 링크가 원본 그대로 포함되어 있지 않습니다(링크가 변경되었거나 빠졌습니다).");
  if (!text.includes(p.brand) || !text.includes(p.name)) warnings.push("게시글에 브랜드명과 상품명이 정확히 들어 있는지 확인하세요.");
  const ex = findExpressions(text, p.exclude || []);
  if (ex.length) errors.push("게시글에 ‘제외할 표현’이 있습니다: " + ex.join(", "));
  const userInputs = [...(p.features || []), ...(p.must_include || []), p.situation, p.target, p.promo, p.disclosure, p.name, p.brand].join(" ");
  const risky = findExpressions(text, RISKY_EXPRESSIONS).filter((r) => !findExpressions(userInputs, [r]).length);
  if (risky.length) warnings.push("근거 확인이 필요한 표현이 있습니다: " + [...new Set(risky)].sort().join(", "));
  return { count: n, limit: POST_LIMIT, errors, warnings };
}
