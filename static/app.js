"use strict";
/* 클립 상품영상 스튜디오 — 프론트엔드 (의존성 없음) */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const countChars = (t) => [...String(t).replace(/\r\n/g, "\n")].length;

const S = {
  status: null, products: [], product: null, check: null, project: null, projectCheck: null,
  music: [], step: 1, job: null, pollTimer: null, settings: null,
};

async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.json !== undefined) {
    o.body = JSON.stringify(o.json);
    o.headers = { "Content-Type": "application/json", ...(o.headers || {}) };
    delete o.json;
  }
  const r = await fetch(path, o);
  if (!r.ok) {
    let msg = `요청 실패 (HTTP ${r.status})`;
    try { const j = await r.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(msg);
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r;
}

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function msgBox(errors = [], warnings = [], okText = "") {
  let h = "";
  if (errors.length) h += `<div class="msg err"><b>고쳐야 할 항목</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
  if (warnings.length) h += `<div class="msg warn"><b>확인하세요</b><ul>${warnings.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
  if (!errors.length && !warnings.length && okText) h += `<div class="msg ok">${esc(okText)}</div>`;
  return h;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast(`${label}을(를) 복사했습니다.`);
}

/* ------------------------------------------------------------ 상태 표시 */
function renderStatus() {
  const st = S.status;
  const tts = st.tts.providers;
  const chips = [
    ["영상 렌더링(FFmpeg)", st.ffmpeg.ok ? "on" : "bad", st.ffmpeg.ok ? "사용 가능" : "FFmpeg를 찾을 수 없음 — 영상 생성 불가"],
    ["한국어 글꼴", st.fonts.ok ? "on" : "bad", st.fonts.ok ? `${st.fonts.regular} / ${st.fonts.bold}` : "글꼴 없음"],
    ["내레이션(TTS)", st.tts.any_connected ? "on" : "off", tts.map((p) => `${p.label}: ${p.connected ? "연결됨" : "미연결"} — ${p.detail}`).join("\n")],
    ["사진 자동 분석", st.vision.connected ? "on" : "off", `${st.vision.provider} (${st.vision.connected ? "연결됨" : "미연결"}) — ${st.vision.detail}`],
    ["배경음악", st.music.count ? "on" : "off", `사용 가능한 음악 ${st.music.count}곡 (내장 ${st.music.builtin}곡: 앱이 직접 합성, CC0)`],
    ["네이버 자동 게시", "off", st.naver_upload.detail],
  ];
  $("#statusChips").innerHTML = chips.map(([n, cls, d]) =>
    `<button class="chip ${cls}" title="${esc(d)}" data-detail="${esc(d)}" data-name="${esc(n)}">${esc(n)}</button>`).join("");
  $$("#statusChips .chip").forEach((c) => c.onclick = () => openModal(c.dataset.name, `<p style="white-space:pre-wrap">${esc(c.dataset.detail)}</p>`));
  $("#defaultsNote").textContent = `기본 제작값: ${st.video_defaults.width}×${st.video_defaults.height}, ${st.video_defaults.fps}fps, MP4(H.264 영상 + AAC 오디오). ${st.video_defaults_note}`;
  const an = $("#analyzeBtn");
  an.disabled = !st.vision.connected;
  an.textContent = st.vision.connected ? "사진 자동 분석 (Claude API · 유료)" : "사진 자동 분석 (미연결)";
  $("#analyzeNote").textContent = st.vision.connected ? "" : "자동 분석이 연결되지 않아 사진 역할을 직접 선택합니다.";
}

function openModal(title, html) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
}
$("#modalClose").onclick = () => ($("#modal").hidden = true);
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").hidden = true; };

/* ------------------------------------------------------------ 단계 이동 */
function goStep(n) {
  S.step = n;
  $$("#steps button").forEach((b) => b.classList.toggle("active", +b.dataset.step === n));
  $$(".step").forEach((s) => s.classList.toggle("active", +s.dataset.step === n));
  const panel = $("#settingsPanel");
  if (n === 3) $("#settingsHost3").appendChild(panel);
  if (n === 4) $("#settingsHost4").appendChild(panel);
  $$("[data-only='4']", panel).forEach((e) => (e.hidden = n !== 4));
  if (n === 2) fillForm();
  if (n === 3) renderGenCheck();
  if (n === 4) renderResult();
  window.scrollTo({ top: 0 });
}
$$("#steps button").forEach((b) => (b.onclick = () => goStep(+b.dataset.step)));
$$("[data-goto]").forEach((b) => (b.onclick = async () => {
  if (S.step === 2) await saveForm(true);
  goStep(+b.dataset.goto);
}));

/* ------------------------------------------------------------ 상품 목록 */
async function loadProducts(selectId) {
  S.products = await api("/api/products");
  const sel = $("#productSelect");
  sel.innerHTML = `<option value="">— 저장된 상품 불러오기 —</option>` +
    S.products.map((p) => `<option value="${p.id}">${esc(p.brand || "(브랜드 미입력)")} · ${esc(p.name || "(상품명 미입력)")} — 사진 ${p.photo_count}장</option>`).join("");
  if (selectId) sel.value = selectId;
}

async function selectProduct(pid) {
  stopPolling();
  if (!pid) {
    S.product = null; S.project = null; S.check = null;
    try { localStorage.removeItem("clip.pid"); } catch {}
  } else {
    const r = await api(`/api/products/${pid}`);
    S.product = r.product; S.check = r.check; S.project = r.project;
    S.settings = r.project ? { ...r.project.settings } : (S.settings || defaultSettings());
    try { localStorage.setItem("clip.pid", pid); } catch {}
  }
  $("#deleteProductBtn").hidden = !S.product;
  $("#productSelect").value = pid || "";
  renderPhotos();
  fillForm();
  syncSettingsUI();
  if (S.step === 4) renderResult();
  if (S.step === 3) renderGenCheck();
}

$("#productSelect").onchange = (e) => selectProduct(e.target.value);
$("#newProductBtn").onclick = async () => {
  const p = await api("/api/products", { method: "POST", json: {} });
  S.settings = defaultSettings();
  await loadProducts(p.id);
  await selectProduct(p.id);
  goStep(1);
  toast("새 상품을 만들었습니다. 사진을 올려 주세요.");
};
$("#deleteProductBtn").onclick = async () => {
  if (!S.product || !confirm(`‘${S.product.brand} ${S.product.name}’ 상품과 사진·영상을 모두 삭제할까요?`)) return;
  await api(`/api/products/${S.product.id}`, { method: "DELETE" });
  await loadProducts();
  await selectProduct("");
};

async function ensureProduct() {
  if (S.product) return S.product;
  const p = await api("/api/products", { method: "POST", json: {} });
  S.settings = S.settings || defaultSettings();
  await loadProducts(p.id);
  await selectProduct(p.id);
  return S.product;
}

/* ------------------------------------------------------------ 1. 사진 */
function photoUrl(ph, thumb = true) {
  return `/files/${S.product.id}/photos/${ph.id}${thumb ? "_thumb" : ""}.jpg`;
}

function renderPhotos() {
  const grid = $("#photoGrid");
  const photos = S.product?.photos || [];
  const n = photos.length;
  const cnt = $("#photoCount");
  cnt.textContent = `${n} / 10`;
  cnt.className = "pill " + (n >= 5 && n <= 10 ? "ok" : "warn");
  const roles = S.status.roles;
  grid.innerHTML = photos.map((ph, i) => {
    const src = ph.role_source === "user" ? "직접 선택" : ph.role_source === "auto"
      ? `자동 추정 ${Math.round((ph.role_confidence || 0) * 100)}% — 확인 필요` : "역할을 선택하세요";
    const cands = (ph.text_candidates || []).map((t) =>
      `<button class="cand" data-cand="${esc(t)}" title="눌러서 상품 특징 입력란에 추가 (확인 후 사용)">${esc(t)}</button>`).join("");
    return `<div class="photo" draggable="true" data-id="${ph.id}">
      <div class="thumb"><img src="${photoUrl(ph)}" alt="상품 사진 ${i + 1}" loading="lazy"><span class="num">${i + 1}</span></div>
      <div class="body">
        <select data-role="${ph.id}" aria-label="사진 ${i + 1} 역할">${Object.entries(roles).map(([k, v]) =>
          `<option value="${k}" ${k === ph.role ? "selected" : ""}>${v}</option>`).join("")}</select>
        <span class="src">${esc(src)}${ph.role_reason ? ` · ${esc(ph.role_reason)}` : ""}</span>
        ${cands ? `<div class="src">사진 속 문자 후보(미확정):</div><div class="cands">${cands}</div>` : ""}
        <div class="ctrl">
          <button class="btn ghost" data-move="-1" data-id="${ph.id}" aria-label="앞으로">◀</button>
          <button class="btn ghost" data-move="1" data-id="${ph.id}" aria-label="뒤로">▶</button>
          <button class="btn ghost danger" data-del="${ph.id}" aria-label="삭제">삭제</button>
        </div>
      </div></div>`;
  }).join("");
  $$("select[data-role]", grid).forEach((s) => (s.onchange = () => savePhotoOrder()));
  $$("[data-move]", grid).forEach((b) => (b.onclick = () => movePhoto(b.dataset.id, +b.dataset.move)));
  $$("[data-del]", grid).forEach((b) => (b.onclick = async () => {
    const r = await api(`/api/products/${S.product.id}/photos/${b.dataset.del}`, { method: "DELETE" });
    S.product = r.product; S.check = r.check; renderPhotos(); loadProducts(S.product.id);
  }));
  $$(".cand", grid).forEach((b) => (b.onclick = () => addFeatureCandidate(b.dataset.cand)));
  setupDrag(grid);
}

function currentOrderItems() {
  return $$("#photoGrid .photo").map((el) => ({ id: el.dataset.id, role: $(`select[data-role="${el.dataset.id}"]`).value }));
}

async function savePhotoOrder(items = currentOrderItems()) {
  const r = await api(`/api/products/${S.product.id}/photos`, { method: "PUT", json: { items } });
  S.product = r.product; S.check = r.check;
  renderPhotos();
}

function movePhoto(id, dir) {
  const items = currentOrderItems();
  const i = items.findIndex((x) => x.id === id);
  const j = i + dir;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  savePhotoOrder(items);
}

function setupDrag(grid) {
  let dragId = null;
  $$(".photo", grid).forEach((el) => {
    el.addEventListener("dragstart", (e) => { dragId = el.dataset.id; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); $$(".dropbefore", grid).forEach((x) => x.classList.remove("dropbefore")); });
    el.addEventListener("dragover", (e) => { e.preventDefault(); $$(".dropbefore", grid).forEach((x) => x.classList.remove("dropbefore")); el.classList.add("dropbefore"); });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragId || dragId === el.dataset.id) return;
      const items = currentOrderItems();
      const from = items.findIndex((x) => x.id === dragId);
      const [moved] = items.splice(from, 1);
      const to = items.findIndex((x) => x.id === el.dataset.id);
      items.splice(to, 0, moved);
      savePhotoOrder(items);
    });
  });
}

async function uploadPhotos(files, replace = false) {
  files = [...files].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  await ensureProduct();
  const existing = replace ? 0 : S.product.photos.length;
  if (existing + files.length > 10) {
    toast(`사진은 최대 10장입니다. 앞의 ${10 - existing}장만 올립니다.`);
    files = files.slice(0, Math.max(0, 10 - existing));
  }
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  fd.append("replace", replace ? "true" : "false");
  toast(`사진 ${files.length}장을 올리는 중…`, 10000);
  try {
    const r = await api(`/api/products/${S.product.id}/photos`, { method: "POST", body: fd });
    S.product = r.product; S.check = r.check;
    renderPhotos();
    await loadProducts(S.product.id);
    toast(r.errors.length ? r.errors.join(" / ") : `사진 ${r.added.length}장을 올렸습니다.` + (replace ? " (기존 상품 정보는 그대로 사용)" : ""));
  } catch (e) { toast(e.message, 5000); }
}

const dz = $("#dropZone");
$("#photoInput").onchange = (e) => { uploadPhotos(e.target.files); e.target.value = ""; };
$("#replaceInput").onchange = (e) => {
  if (S.product?.photos.length && !confirm("기존 사진을 모두 지우고 새 사진으로 교체할까요? 상품 정보는 그대로 유지됩니다.")) { e.target.value = ""; return; }
  uploadPhotos(e.target.files, true); e.target.value = "";
};
["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => uploadPhotos(e.dataTransfer.files));

$("#suggestOrderBtn").onclick = async () => {
  if (!S.product?.photos.length) return;
  const unset = S.product.photos.filter((p) => p.role === "unset").length;
  const r = await api(`/api/products/${S.product.id}/photos/suggest-order`);
  const roleOf = Object.fromEntries(currentOrderItems().map((x) => [x.id, x.role]));
  await savePhotoOrder(r.order.map((id) => ({ id, role: roleOf[id] })));
  toast(unset ? `역할 미지정 사진 ${unset}장은 뒤로 보냈습니다. 역할을 선택하면 더 정확해집니다.` : "제품 전체 → 세부 특징 → 사용 장면 → 포장 순으로 정렬했습니다.");
};

$("#analyzeBtn").onclick = async () => {
  if (!S.product?.photos.length) return toast("먼저 사진을 올려 주세요.");
  if (!confirm("사진을 Claude API로 보내 역할을 추정하고 사진 속 문자를 읽습니다. 유료 API 호출이 1회 발생합니다. 진행할까요?")) return;
  const b = $("#analyzeBtn"); b.disabled = true; b.textContent = "분석 중…";
  try {
    const r = await api(`/api/products/${S.product.id}/analyze`, { method: "POST" });
    S.product = r.product; renderPhotos(); toast(r.note, 4000);
  } catch (e) { toast(e.message, 5000); }
  finally { renderStatus(); }
};

function addFeatureCandidate(text) {
  goStep(2);
  const inputs = ["feature0", "feature1", "feature2"].map((n) => $(`#productForm [name="${n}"]`));
  const empty = inputs.find((i) => !i.value.trim());
  if (!empty) return toast("특징 입력란 3개가 모두 차 있습니다. 직접 수정해 주세요.");
  empty.value = text;
  empty.focus();
  toast("사진에서 읽은 후보를 넣었습니다. 사실인지 확인한 뒤 ‘정보 저장’을 눌러야 확정됩니다.", 4500);
}

/* ------------------------------------------------------------ 2. 상품 정보 */
function fillForm() {
  const f = $("#productForm");
  const p = S.product || {};
  ["brand", "name", "link", "target", "situation", "price", "promo", "promo_period", "disclosure"].forEach((k) => (f[k].value = p[k] || ""));
  f.tone.innerHTML = Object.entries(S.status.tones).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  f.tone.value = p.tone || "friendly";
  [0, 1, 2].forEach((i) => (f[`feature${i}`].value = (p.features || [])[i] || ""));
  f.must_include.value = (p.must_include || []).join("\n");
  f.exclude.value = (p.exclude || []).join("\n");
  $("#productCheck").innerHTML = S.check ? msgBox(S.check.errors, S.check.warnings, "필수 정보가 모두 확인되었습니다.") : "";
}

function formData() {
  const f = $("#productForm");
  return {
    brand: f.brand.value, name: f.name.value, link: f.link.value, target: f.target.value, situation: f.situation.value,
    price: f.price.value, promo: f.promo.value, promo_period: f.promo_period.value, tone: f.tone.value,
    disclosure: f.disclosure.value, features: [0, 1, 2].map((i) => f[`feature${i}`].value).filter((v) => v.trim()),
    must_include: f.must_include.value, exclude: f.exclude.value,
  };
}

async function saveForm(silent = false) {
  if (!S.product && !Object.values(formData()).some((v) => (Array.isArray(v) ? v.length : v.trim()))) return;
  await ensureProduct();
  const r = await api(`/api/products/${S.product.id}`, { method: "PUT", json: formData() });
  S.product = r.product; S.check = r.check;
  await loadProducts(S.product.id);
  $("#productCheck").innerHTML = msgBox(S.check.errors, S.check.warnings, "필수 정보가 모두 확인되었습니다.");
  $("#formSaved").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR");
  if (!silent) toast("상품 정보를 저장했습니다.");
}
$("#productForm").onsubmit = (e) => { e.preventDefault(); saveForm().catch((er) => toast(er.message, 5000)); };
$("#disclosureExample").onclick = () => {
  const f = $("#productForm");
  if (f.disclosure.value.trim() && !confirm("현재 문구를 예시 문구로 바꿀까요?")) return;
  f.disclosure.value = "이 콘텐츠는 네이버 브랜드커넥트를 통해 판매 수수료를 제공받습니다.";
  toast("예시 문구입니다. 최신 공식 안내와 대조해 확인하세요.", 4000);
};

/* ------------------------------------------------------------ 설정 패널 */
function defaultSettings() {
  return {
    duration: 25, quality: "final", photo_mode: "fit", transition: "fade", music: "bright",
    music_gain_db: -8, fade_in: 1, fade_out: 2, master_gain_db: 0, narration: false,
    tts_provider: "windows", tts_voice: "", tts_rate: 0, narration_gain_db: 0, duck_db: -12,
    cta_mode: "unset", cta_custom: "", url_text: "", video_disclosure: "", disclosure_position: "top",
    show_price: true, post_include_link: true, caption_pos: "bottom", caption_offset: 0, caption_scale: 1,
    safe_top: 0.06, safe_bottom: 0.18, safe_side: 0.06, cover_scene: 0, cover_text: "",
  };
}

function buildSettingsPanel() {
  const node = $("#settingsTpl").content.cloneNode(true);
  $("#settingsHost3").appendChild(node);
  const panel = $("#settingsPanel");
  $('[data-set="cta_mode"]', panel).innerHTML = Object.entries(S.status.cta_modes).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $('[data-set="tts_provider"]', panel).innerHTML = S.status.tts.providers.map((p) =>
    `<option value="${p.id}" ${p.connected ? "" : "disabled"}>${esc(p.label)}${p.connected ? "" : " (미연결)"}</option>`).join("");
  $$("[data-set]", panel).forEach((el) => el.addEventListener(el.type === "range" || el.tagName === "INPUT" && el.type !== "checkbox" ? "input" : "change", () => onSettingChange(el)));
  $("#musicForm").onsubmit = uploadMusic;
  $("#ttsTestBtn").onclick = testTTS;
}

function fmtOut(key, v) {
  if (key.endsWith("_db")) return `${v > 0 ? "+" : ""}${v}dB`;
  if (key.startsWith("safe_") || key === "caption_offset") return `${Math.round(v * 100)}%`;
  if (key === "caption_scale") return `×${(+v).toFixed(2)}`;
  if (key === "tts_rate") return v > 0 ? `+${v}` : `${v}`;
  return `${v}초`;
}

function syncSettingsUI() {
  const panel = $("#settingsPanel");
  if (!panel) return;
  const st = S.settings || defaultSettings();
  S.settings = st;
  $$("[data-set]", panel).forEach((el) => {
    const k = el.dataset.set;
    if (el.type === "checkbox") el.checked = !!st[k];
    else if (k === "cover_scene") {
      const n = S.project?.scenes?.length || 1;
      el.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${i + 1}번 장면</option>`).join("");
      el.value = String(st[k] ?? 0);
    } else if (st[k] !== undefined) el.value = String(st[k]);
  });
  $$("output[data-out]", panel).forEach((o) => (o.textContent = fmtOut(o.dataset.out, st[o.dataset.out])));
  const prov = S.status.tts.providers.find((p) => p.id === st.tts_provider) || S.status.tts.providers[0];
  const vsel = $('[data-set="tts_voice"]', panel);
  vsel.innerHTML = (prov.voices || []).map((v) => `<option>${esc(v)}</option>`).join("") || `<option value="">(없음)</option>`;
  if (st.tts_voice) vsel.value = st.tts_voice;
  const narr = $('[data-set="narration"]', panel);
  const anyConnected = S.status.tts.any_connected;
  narr.disabled = !anyConnected;
  if (!anyConnected) narr.checked = false;
  $("#ttsStatus").innerHTML = S.status.tts.providers.map((p) =>
    `<div class="${p.connected ? "msg ok" : "msg warn"}">${esc(p.label)}: <b>${p.connected ? "연결됨" : "미연결"}</b> — ${esc(p.detail)}</div>`).join("") +
    (anyConnected ? "" : `<div class="msg warn">음성 서비스가 연결되지 않아 내레이션을 만들 수 없습니다. 자막과 배경음악만으로 영상을 만듭니다.</div>`);
  renderMusicList();
}

let settingsSaveTimer = null;
function onSettingChange(el) {
  const k = el.dataset.set;
  let v = el.type === "checkbox" ? el.checked : el.value;
  if (el.type === "range" || ["duration", "cover_scene"].includes(k)) v = +v;
  S.settings[k] = v;
  const out = $(`output[data-out="${k}"]`);
  if (out) out.textContent = fmtOut(k, v);
  if (k === "tts_provider") syncSettingsUI();
  if (k === "post_include_link") $("#postIncludeLink").checked = v;
  if (S.project) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => saveProject({ settings: S.settings }), 500);
  }
}

function renderMusicList() {
  const st = S.settings;
  const items = [...S.music, { id: "none", title: "음악 없음", mood: "음악 없음", license: "", source: "" }];
  $("#musicList").innerHTML = items.map((m) => `
    <label class="music ${st.music === m.id ? "sel" : ""}">
      <input type="radio" name="music" value="${m.id}" ${st.music === m.id ? "checked" : ""}>
      <b>${esc(m.mood)}</b>
      <span class="small">${esc(m.title)}${m.duration ? ` · ${m.duration}초 반복` : ""}</span>
      ${m.id !== "none" ? `<span class="lic">출처: ${esc(m.source)}<br>라이선스: ${esc(m.license)}${m.builtin ? " — 상업적 이용·영상 배포 허용" : " (업로드 시 확인됨)"}</span>
      <audio controls preload="none" src="/api/music/${m.id}/file"></audio>` : `<span class="lic">배경음악 없이 생성합니다(자막·내레이션만).</span>`}
    </label>`).join("");
  $$("#musicList input[name=music]").forEach((r) => (r.onchange = () => {
    S.settings.music = r.value;
    renderMusicList();
    if (S.project) saveProject({ settings: S.settings });
  }));
}

async function uploadMusic(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (!fd.get("confirmed")) return toast("상업적 이용·배포 허용 여부를 확인해 주세요.");
  try {
    const m = await api("/api/music", { method: "POST", body: fd });
    S.music = await api("/api/music");
    S.settings.music = m.id;
    e.target.reset();
    renderMusicList();
    if (S.project) saveProject({ settings: S.settings });
    toast("음악을 올렸습니다.");
  } catch (er) { toast(er.message, 5000); }
}

async function testTTS() {
  const b = $("#ttsTestBtn");
  b.disabled = true; b.textContent = "생성 중…";
  try {
    const r = await fetch("/api/tts/test", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: S.settings.tts_provider, voice: S.settings.tts_voice || "" }) });
    if (!r.ok) throw new Error((await r.json()).detail || "음성 생성 실패");
    const blob = await r.blob();
    const a = $("#ttsAudio");
    a.src = URL.createObjectURL(blob); a.hidden = false; a.play().catch(() => {});
  } catch (e) { toast(e.message, 5000); }
  finally { b.disabled = false; b.textContent = "음성 들어보기"; }
}

/* ------------------------------------------------------------ 3. 생성 */
function renderGenCheck() {
  const c = S.check;
  if (!S.product) { $("#genCheck").innerHTML = msgBox(["먼저 새 상품을 만들고 사진을 올려 주세요."]); return; }
  $("#genCheck").innerHTML = c ? msgBox(c.errors, c.warnings, "생성할 준비가 되었습니다.") : "";
  $("#generateBtn").disabled = !!(c && c.errors.length);
}

$("#generateBtn").onclick = async () => {
  if (!S.product) return;
  if (S.project && !confirm("새 초안을 만들면 직접 수정한 장면·자막·게시글이 초기화됩니다. 계속할까요?")) return;
  await draftAndRender();
};

async function draftAndRender() {
  if (!S.product) return toast("먼저 상품을 선택하거나 새로 만드세요.");
  try {
    const r = await api(`/api/products/${S.product.id}/draft`, { method: "POST", json: { settings: S.settings } });
    S.project = r.project; S.projectCheck = r.check; S.settings = { ...r.project.settings };
    syncSettingsUI();
    goStep(4);
    await startRender();
  } catch (e) {
    toast(e.message, 6000);
    $("#genCheck").innerHTML = msgBox([e.message]);
  }
}

/* ------------------------------------------------------------ 4. 결과 */
function renderResult() {
  renderKv();
  renderPost();
  renderScenes();
  renderVideo();
  if (S.job) renderJob();
}

function renderKv() {
  const p = S.product;
  if (!p) { $("#productKv").innerHTML = ""; return; }
  $("#productKv").innerHTML = `
    <dt>브랜드명</dt><dd><b>${esc(p.brand)}</b></dd>
    <dt>상품명</dt><dd><b>${esc(p.name)}</b></dd>
    <dt>구매 링크</dt><dd><code class="link">${esc(p.link)}</code>
      <div class="row gap wrap" style="margin-top:6px"><button class="btn primary" id="copyLinkBtn">구매 링크 복사</button>
      <a class="btn ghost" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">링크 열어 확인</a></div>
      <span class="hint">입력한 원본 그대로입니다. 영상 속 주소는 클릭되지 않으므로 이 링크를 게시글이나 링크 위치에 붙여 넣으세요.</span></dd>
    <dt>확인된 특징</dt><dd>${(p.features || []).map(esc).join(" · ")}</dd>
    ${p.disclosure ? `<dt>표시 문구</dt><dd>${esc(p.disclosure)}</dd>` : `<dt>표시 문구</dt><dd class="pill warn">비어 있음</dd>`}`;
  $("#copyLinkBtn").onclick = () => copyText(p.link, "구매 링크");
}

function renderVideo() {
  const panel = $("#videoPanel");
  const r = S.project?.renders?.[0];
  if (!r) { panel.innerHTML = `<p class="muted">아직 생성된 영상이 없습니다. 3단계에서 ‘초안 만들고 영상 생성’을 누르세요.</p>`; return; }
  const v = `${r.video}?v=${r.job_id}`;
  const narr = r.narration?.enabled ? `내레이션 ${r.narration.clips}개 (${r.narration.provider === "windows" ? "Windows 음성" : r.narration.provider})` : "내레이션 없음";
  panel.innerHTML = `
    ${r.quality === "preview" ? `<div class="msg warn">빠른 미리보기 화질(540×960)입니다. 업로드용은 화질을 ‘최종’으로 바꿔 다시 생성하세요.</div>` : ""}
    <video controls playsinline preload="metadata" src="${v}" poster="${r.cover}?v=${r.job_id}"></video>
    <div class="meta">
      <span class="pill ok">${r.probe.width}×${r.probe.height}</span><span class="pill ok">${r.probe.fps}fps</span>
      <span class="pill ok">${r.duration}초</span><span class="pill ok">H.264/AAC</span>
      <span class="pill">${(r.size_bytes / 1048576).toFixed(1)}MB</span>
      <span class="pill">${r.music ? "음악: " + esc(r.music.title) : "음악 없음"}</span>
      <span class="pill">${esc(narr)}</span>
      ${r.silent_audio ? `<span class="pill warn">무음 오디오 트랙</span>` : ""}
    </div>
    <div class="downloads">
      <a class="btn primary" href="${r.video}?download=true">MP4 다운로드</a>
      <a class="btn" href="${r.cover}?download=true">표지 이미지 다운로드</a>
    </div>
    <div class="cover"><img src="${r.cover}?v=${r.job_id}" alt="표지 이미지"><span class="muted small">표지 이미지 1080×1920 JPG<br>생성: ${new Date(r.created * 1000).toLocaleString("ko-KR")}</span></div>
    ${S.project.renders.length > 1 ? `<details><summary class="small">이전 결과 ${S.project.renders.length - 1}개</summary>${S.project.renders.slice(1).map((o) =>
      `<div class="small"><a href="${o.video}?download=true">${new Date(o.created * 1000).toLocaleString("ko-KR")} · ${o.duration}초 · ${o.quality === "preview" ? "미리보기" : "최종"}</a></div>`).join("")}</details>` : ""}`;
}

/* 게시글 */
let postCheckTimer = null;
function renderPost() {
  const pj = S.project;
  const ta = $("#postText");
  if (!pj) { ta.value = ""; updatePostCount(); return; }
  ta.value = pj.post.text;
  $("#postIncludeLink").checked = pj.post.include_link;
  updatePostCount();
  checkPostRemote();
  if (pj.post_report?.dropped?.length && pj.post.auto) {
    $("#postMsgs").insertAdjacentHTML("beforeend", `<div class="msg warn">300자에 맞추기 위해 뺀 항목: ${esc(pj.post_report.dropped.join(", "))}</div>`);
  }
}
function updatePostCount() {
  const n = countChars($("#postText").value);
  const c = $("#postCount");
  c.textContent = `${n} / 300자`;
  c.className = "count " + (n > 300 ? "over" : "ok");
}
async function checkPostRemote() {
  if (!S.product || !S.project) return;
  try {
    const r = await api(`/api/products/${S.product.id}/post/check`, { method: "POST", json: { text: $("#postText").value, include_link: $("#postIncludeLink").checked } });
    $("#postMsgs").innerHTML = msgBox(r.errors, r.warnings, `공백·줄바꿈·해시태그·표시 문구 포함 ${r.count}자 — 300자 이내입니다.`);
  } catch {}
}
$("#postText").addEventListener("input", () => {
  updatePostCount();
  clearTimeout(postCheckTimer);
  postCheckTimer = setTimeout(() => {
    checkPostRemote();
    saveProject({ post: { text: $("#postText").value, include_link: $("#postIncludeLink").checked, auto: false } });
  }, 500);
});
$("#postIncludeLink").onchange = async (e) => {
  S.settings.post_include_link = e.target.checked;
  syncSettingsUI();
  await rebuildPost(true);
};
async function rebuildPost(fromToggle = false) {
  if (!S.project) return;
  if (!fromToggle && S.project.post && !S.project.post.auto && !confirm("직접 수정한 게시글을 새로 작성한 글로 바꿀까요?")) return;
  const r = await api(`/api/products/${S.product.id}/post/build`, { method: "POST", json: { settings: S.settings } });
  S.project.post = { text: r.text, include_link: r.include_link, auto: true };
  S.project.post_report = r;
  $("#postText").value = r.text;
  updatePostCount();
  $("#postMsgs").innerHTML = msgBox([...r.errors, ...r.check.errors], [...r.warnings, ...r.check.warnings],
    `공백·줄바꿈·해시태그·표시 문구 포함 ${r.count}자 — 300자 이내입니다.`) +
    (r.dropped.length ? `<div class="msg warn">300자에 맞추기 위해 뺀 항목: ${esc(r.dropped.join(", "))}</div>` : "");
}
$("#rebuildPostBtn").onclick = () => rebuildPost();
$("#copyPostBtn").onclick = () => {
  const t = $("#postText").value;
  if (countChars(t) > 300 && !confirm("300자를 넘습니다. 그래도 복사할까요?")) return;
  copyText(t, "게시글");
};

/* 장면 편집 */
const SEG = () => S.status.segments;
function renderScenes() {
  const pj = S.project;
  const list = $("#sceneList");
  if (!pj || !S.product) { list.innerHTML = `<p class="muted">초안이 없습니다.</p>`; $("#hookSelect").innerHTML = ""; $("#totalDur").textContent = ""; return; }
  $("#hookSelect").innerHTML = [...new Set([pj.hook, ...(pj.hook_candidates || [])])].map((h) => `<option ${h === pj.hook ? "selected" : ""}>${esc(h)}</option>`).join("");
  const photos = S.product.photos;
  const pidx = Object.fromEntries(photos.map((p, i) => [p.id, i]));
  let t = 0;
  list.innerHTML = pj.scenes.map((sc, i) => {
    const start = t; t += +sc.duration;
    const ph = photos.find((p) => p.id === sc.photo_id);
    const isCard = sc.style === "card";
    const capLines = (sc.caption || "").split("\n").length;
    return `<div class="scene ${isCard ? "card-scene" : ""}" data-i="${i}">
      <div class="pic">
        ${ph ? `<img src="${photoUrl(ph)}" alt="">` : `<div class="msg err">사진 없음</div>`}
        <select data-f="photo_id" aria-label="장면 사진">${photos.map((p, k) => `<option value="${p.id}" ${p.id === sc.photo_id ? "selected" : ""}>사진 ${k + 1}</option>`).join("")}</select>
      </div>
      <div>
        <div class="head"><b>${i + 1}</b><span class="seg">${esc(SEG()[sc.segment] || sc.segment)}</span>
          <span class="time">${start.toFixed(1)}~${t.toFixed(1)}초</span></div>
        ${isCard ? `
          <div class="small">마무리 화면: <b>${esc(S.product.brand)}</b> / <b>${esc(S.product.name)}</b> (상품 정보에서 자동 표시)</div>
          <label>구매 안내 문구 <input data-f="cta" value="${esc(sc.cta || "")}" maxlength="30"></label>` : `
          <label>자막 <span class="capinfo">최대 두 줄 · 줄바꿈은 Enter (현재 ${capLines}줄)</span>
            <textarea data-f="caption" rows="2" maxlength="80">${esc(sc.caption)}</textarea></label>`}
        <label>내레이션 문구 <span class="capinfo">${sc.narration ? "" : "(이 장면은 내레이션 없음)"}</span><input data-f="narration" value="${esc(sc.narration || "")}" maxlength="200"></label>
        <div class="fields">
          <label>길이(초)<input type="number" data-f="duration" min="0.5" max="20" step="0.1" value="${sc.duration}"></label>
          <label>움직임<select data-f="motion">${[["auto", "자동"], ["zoom_in", "확대"], ["zoom_out", "축소"], ["pan_right", "오른쪽 이동"], ["pan_left", "왼쪽 이동"], ["none", "고정"]]
            .map(([k, v]) => `<option value="${k}" ${sc.motion === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          ${isCard ? "<span></span>" : `<label>자막 형태<select data-f="style"><option value="normal" ${sc.style === "normal" ? "selected" : ""}>일반</option><option value="title" ${sc.style === "title" ? "selected" : ""}>제목(1줄 작게 + 1줄 크게)</option></select></label>`}
        </div>
        <div class="tools">
          <button class="btn ghost" data-a="preview">미리보기</button>
          <button class="btn ghost" data-a="up" ${i === 0 ? "disabled" : ""}>▲</button>
          <button class="btn ghost" data-a="down" ${i === pj.scenes.length - 1 ? "disabled" : ""}>▼</button>
          ${isCard ? "" : `<button class="btn ghost" data-a="dup">복제</button><button class="btn ghost danger" data-a="del">삭제</button>`}
        </div>
      </div></div>`;
  }).join("");
  $("#totalDur").textContent = `전체 ${t.toFixed(1)}초 · 장면 ${pj.scenes.length}개`;
  $$(".scene", list).forEach((el) => {
    const i = +el.dataset.i;
    $$("[data-f]", el).forEach((inp) => inp.addEventListener(inp.tagName === "SELECT" ? "change" : "input", () => {
      const f = inp.dataset.f;
      let v = inp.value;
      if (f === "duration") v = Math.max(0.5, Math.min(20, +v || 0.5));
      if (f === "caption") { const lines = v.split("\n"); if (lines.length > 2) { v = lines.slice(0, 2).join("\n"); inp.value = v; toast("자막은 두 줄까지 가능합니다."); } }
      pj.scenes[i][f] = v;
      if (f === "cta") pj.scenes[i].cta_locked = true;
      if (f === "photo_id" || f === "style") { renderScenes(); }
      if (f === "duration") { $("#totalDur").textContent = `전체 ${pj.scenes.reduce((a, s) => a + +s.duration, 0).toFixed(1)}초 · 장면 ${pj.scenes.length}개`; }
      queueSceneSave();
    }));
    $$("[data-a]", el).forEach((b) => (b.onclick = () => sceneAction(i, b.dataset.a)));
  });
  $("#sceneCheck").innerHTML = S.projectCheck ? msgBox(S.projectCheck.errors, S.projectCheck.warnings) : "";
}

let sceneTimer = null;
function queueSceneSave() {
  $("#projSave").textContent = "저장 대기…";
  clearTimeout(sceneTimer);
  sceneTimer = setTimeout(() => saveProject({ scenes: S.project.scenes }), 600);
}

async function saveProject(body) {
  if (!S.product || !S.project) return;
  try {
    const r = await api(`/api/products/${S.product.id}/project`, { method: "PUT", json: body });
    const renders = S.project.renders;
    S.project = { ...r.project, renders: r.project.renders || renders };
    S.projectCheck = r.check;
    $("#projSave").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR");
    $("#sceneCheck").innerHTML = msgBox(r.check.errors, r.check.warnings);
    if (body.settings) {
      // 마무리 화면 구매 안내가 설정을 따라 바뀌었을 수 있다
      if (S.step === 4) renderScenes();
    }
  } catch (e) { $("#projSave").textContent = "저장 실패: " + e.message; }
}

async function sceneAction(i, a) {
  const sc = S.project.scenes;
  if (a === "preview") return previewScene(i);
  if (a === "up" && i > 0) [sc[i - 1], sc[i]] = [sc[i], sc[i - 1]];
  if (a === "down" && i < sc.length - 1) [sc[i + 1], sc[i]] = [sc[i], sc[i + 1]];
  if (a === "dup") sc.splice(i + 1, 0, { ...sc[i], id: "s" + Date.now(), narration: "" });
  if (a === "del") { if (sc.length <= 2) return toast("장면이 너무 적습니다."); sc.splice(i, 1); }
  renderScenes();
  syncSettingsUI();
  await saveProject({ scenes: sc });
}

async function previewScene(i) {
  clearTimeout(sceneTimer);
  await saveProject({ scenes: S.project.scenes, settings: S.settings });
  openModal(`${i + 1}번 장면 정지 미리보기`, `<p class="muted small">실제 렌더링 결과가 아니라 장면 중간의 정지 화면입니다(540×960). 빨간 영역은 플랫폼 UI가 겹칠 수 있는 곳입니다.</p><p>불러오는 중…</p>`);
  try {
    const r = await api(`/api/products/${S.product.id}/preview-frame`, { method: "POST", json: { scene_index: i, guide: true } });
    const url = URL.createObjectURL(await r.blob());
    $("#modalBody").innerHTML = `<p class="muted small">실제 렌더링 결과가 아니라 장면 중간의 정지 화면입니다(540×960). 빨간 영역은 플랫폼 UI가 겹칠 수 있는 곳입니다.</p><img src="${url}" alt="장면 미리보기">`;
  } catch (e) { $("#modalBody").innerHTML = msgBox([e.message]); }
}

$("#hookSelect").onchange = async (e) => {
  const h = e.target.value;
  const sc = S.project.scenes;
  const old = S.project.hook;
  sc.forEach((s) => { if (s.segment === "hook" && s.caption === old) { s.caption = h; if (s.narration) s.narration = h; } });
  S.project.hook = h;
  await saveProject({ scenes: sc, hook: h });
  renderScenes();
  toast("첫 문장을 바꿨습니다. 게시글에도 쓰려면 ‘게시글 다시 작성’을 누르세요.");
};

$("#rerenderBtn").onclick = async () => {
  if (!S.project) return toast("먼저 초안을 만드세요(3단계).");
  clearTimeout(sceneTimer); clearTimeout(settingsSaveTimer);
  await saveProject({ scenes: S.project.scenes, settings: S.settings });
  if (S.projectCheck?.errors.length) return toast("고쳐야 할 항목이 있어 생성할 수 없습니다.", 4000);
  await startRender();
};
$("#redraftBtn").onclick = async () => {
  if (!confirm("장면·자막·게시글을 현재 설정으로 새로 만듭니다. 직접 수정한 내용은 사라집니다. 계속할까요?")) return;
  await draftAndRender();
};

/* 렌더 작업 */
async function startRender() {
  try {
    const j = await api(`/api/products/${S.product.id}/render`, { method: "POST" });
    S.job = j;
    renderJob();
    poll();
  } catch (e) {
    S.job = null;
    $("#jobPanel").innerHTML = msgBox([e.message]);
    toast(e.message, 6000);
  }
}
function stopPolling() { clearTimeout(S.pollTimer); S.pollTimer = null; }
async function poll() {
  stopPolling();
  if (!S.job) return;
  try { S.job = await api(`/api/jobs/${S.job.id}`); } catch (e) { $("#jobPanel").innerHTML = msgBox([e.message]); return; }
  renderJob();
  if (S.job.status === "done") {
    const r = await api(`/api/products/${S.product.id}`);
    S.project = r.project;
    renderVideo();
    toast("영상 생성이 완료되었습니다.");
    return;
  }
  if (S.job.status === "failed") return;
  S.pollTimer = setTimeout(poll, 1000);
}
function renderJob() {
  const j = S.job;
  if (!j) return;
  const ico = { pending: "○", running: "◐", done: "✓", failed: "✕", skipped: "–" };
  const st = { pending: "대기", running: "진행 중", done: "완료", failed: "실패", skipped: "건너뜀" };
  const overall = j.stages.filter((s) => ["done", "skipped"].includes(s.status)).length / j.stages.length;
  const pct = Math.round((j.status === "done" ? 1 : overall + (j.current === "video" ? j.progress / j.stages.length : 0)) * 100);
  let h = "";
  if (j.status !== "done") {
    h += `<div class="bar"><i style="width:${pct}%"></i></div>`;
    h += `<ul class="stages">${j.stages.map((s) => `<li class="${s.status}"><span class="ico">${ico[s.status]}</span><span>${esc(s.label)} · ${st[s.status]} <span class="m">${esc(s.message || "")}</span></span></li>`).join("")}</ul>`;
  }
  if (j.status === "failed") {
    const label = j.stages.find((s) => s.key === j.failed_stage)?.label || j.failed_stage;
    h += `<div class="msg err"><b>‘${esc(label)}’ 단계에서 실패했습니다. 결과물은 만들어지지 않았습니다.</b><br>${esc(j.error)}<br><b>해결 방법:</b> ${esc(j.retry_hint || "")}</div>
      <button class="btn primary" id="retryBtn">다시 시도</button>`;
  }
  if (j.status === "done" && j.warnings.length) h += msgBox([], [...new Set(j.warnings)]);
  if (j.status === "done") h += `<div class="msg ok">생성 완료 — 결과 파일 검증(코덱·해상도·길이·디코딩)을 통과했습니다.</div>`;
  $("#jobPanel").innerHTML = h;
  const rb = $("#retryBtn");
  if (rb) rb.onclick = () => startRender();
}

/* ------------------------------------------------------------ 시작 */
async function init() {
  try {
    [S.status, S.music] = await Promise.all([api("/api/status"), api("/api/music")]);
  } catch (e) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="msg err">서버에 연결할 수 없습니다: ${esc(e.message)}</div>`);
    return;
  }
  renderStatus();
  S.settings = defaultSettings();
  buildSettingsPanel();
  await loadProducts();
  let last = null;
  try { last = localStorage.getItem("clip.pid"); } catch {}
  if (last && S.products.some((p) => p.id === last)) await selectProduct(last);
  else { renderPhotos(); syncSettingsUI(); }
  goStep(1);
}
init();
