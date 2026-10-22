// 클립 상품영상 스튜디오 — 웹 버전. 모든 처리를 이 브라우저 안에서 한다(서버 없음).
import * as cw from "./copywriter.js";
import * as store from "./store.js";
import { Timeline, validateCaptions, renderCover, drawGuide, loadFonts, DEFAULT_RENDER_SETTINGS } from "./render.js";
import { capabilities, mixAudio, encodeMp4, verifyMp4 } from "./encoder.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const VIDEO = { width: 1080, height: 1920, fps: 30 };
const S = { caps: null, products: [], product: null, check: null, project: null, projectCheck: null, music: [], step: 1, job: null, settings: null, photoUrls: {} };

const DEFAULT_SETTINGS = {
  duration: 25, quality: "final", music: "bright", music_gain_db: -8, master_gain_db: 0, fade_in: 1, fade_out: 2,
  cta_mode: "unset", cta_custom: "", post_include_link: true, disclosure_position: "top", show_price: true,
  cover_scene: 0, cover_text: "", ...DEFAULT_RENDER_SETTINGS,
};

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
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
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  toast(`${label}을(를) 복사했습니다.`);
}
function openModal(title, html) { $("#modalTitle").textContent = title; $("#modalBody").innerHTML = html; $("#modal").hidden = false; }
$("#modalClose").onclick = () => ($("#modal").hidden = true);
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").hidden = true; };

/* ------------------------------------------------------------ 상태 표시 */
function renderStatus() {
  const c = S.caps;
  const encOk = c.webcodecs && c.video && c.audio;
  const chips = [
    ["영상 만들기(브라우저)", encOk ? "on" : "bad", encOk ? `이 브라우저에서 MP4(H.264 ${c.video} + AAC)를 만들 수 있습니다.`
      : "이 브라우저에서는 MP4를 만들 수 없습니다. PC의 최신 Chrome 또는 Edge를 사용하세요." + (!c.webcodecs ? " (WebCodecs 미지원)" : !c.video ? " (H.264 인코딩 불가)" : " (AAC 인코딩 불가)")],
    ["한국어 글꼴", "on", "Noto Sans KR (Google Fonts, SIL OFL)"],
    ["내레이션(TTS)", "off", "웹 버전 미지원 — 브라우저 음성은 파일로 녹음할 수 없고, 유료 음성 API 키를 브라우저에 넣으면 노출됩니다. 내레이션이 필요하면 PC용 로컬 버전을 사용하세요."],
    ["사진 자동 분석", "off", "웹 버전 미지원 — API 키가 브라우저에 노출되므로 연결하지 않았습니다. 사진 역할은 직접 선택합니다."],
    ["배경음악", S.music.length ? "on" : "off", `사용 가능한 음악 ${S.music.length}곡 (내장 3곡: 앱이 직접 합성, CC0)`],
    ["저장 위치", "on", "상품 정보·사진·영상은 이 브라우저(IndexedDB)에만 저장되고 서버로 보내지 않습니다. 다른 기기·브라우저에서는 보이지 않으며, 브라우저 데이터를 지우면 함께 지워집니다."],
    ["네이버 자동 게시", "off", "1차 버전 범위 밖입니다(별도 연동 과제)."],
  ];
  $("#statusChips").innerHTML = chips.map(([n, cls, d]) => `<button class="chip ${cls}" title="${esc(d)}" data-detail="${esc(d)}" data-name="${esc(n)}">${esc(n)}</button>`).join("");
  $$("#statusChips .chip").forEach((b) => (b.onclick = () => openModal(b.dataset.name, `<p style="white-space:pre-wrap">${esc(b.dataset.detail)}</p>`)));
  $("#defaultsNote").textContent = "기본 제작값: 1080×1920, 30fps, MP4(H.264 영상 + AAC 오디오). 앱의 기본 제작값이며 네이버 클립 공식 업로드 요건이 아닙니다. 실제 적용 시 최신 공식 안내를 확인해 조정하세요.";
  $("#analyzeNote").textContent = "웹 버전에서는 사진 역할을 직접 선택합니다.";
  $("#capsBox").innerHTML = encOk ? "" : msgBox(["이 브라우저에서는 MP4를 만들 수 없습니다. PC의 최신 Chrome 또는 Edge에서 열어 주세요. (사진·정보 입력과 게시글 작성은 가능합니다)"]);
}

/* ------------------------------------------------------------ 단계 */
function goStep(n) {
  S.step = n;
  $$("#steps button").forEach((b) => b.classList.toggle("active", +b.dataset.step === n));
  $$(".step").forEach((s) => s.classList.toggle("active", +s.dataset.step === n));
  const panel = $("#settingsPanel");
  $(n === 4 ? "#settingsHost4" : "#settingsHost3").appendChild(panel);
  $$("[data-only='4']", panel).forEach((e) => (e.hidden = n !== 4));
  if (n === 2) fillForm();
  if (n === 3) renderGenCheck();
  if (n === 4) renderResult();
  window.scrollTo({ top: 0 });
}
$$("#steps button").forEach((b) => (b.onclick = () => goStep(+b.dataset.step)));
$$("[data-goto]").forEach((b) => (b.onclick = async () => { if (S.step === 2) await saveForm(true); goStep(+b.dataset.goto); }));

/* ------------------------------------------------------------ 상품 */
async function loadProducts(selectId) {
  S.products = await store.listProducts();
  $("#productSelect").innerHTML = `<option value="">— 저장된 상품 불러오기 —</option>` +
    S.products.map((p) => `<option value="${p.id}">${esc(p.brand || "(브랜드 미입력)")} · ${esc(p.name || "(상품명 미입력)")} — 사진 ${p.photo_count}장</option>`).join("");
  if (selectId) $("#productSelect").value = selectId;
}

async function refreshPhotoUrls() {
  S.photoUrls = {};
  for (const ph of S.product?.photos || []) S.photoUrls[ph.id] = await store.photoURL(ph.id, true);
}

async function selectProduct(pid) {
  if (!pid) { S.product = S.project = S.check = null; try { localStorage.removeItem("clip.pid"); } catch {} }
  else {
    S.product = await store.getProduct(pid);
    S.check = cw.checkProduct(S.product);
    S.project = (await store.getProject(pid)) || null;
    S.settings = S.project ? { ...DEFAULT_SETTINGS, ...S.project.settings } : (S.settings || { ...DEFAULT_SETTINGS });
    S.projectCheck = S.project ? checkProject() : null;
    try { localStorage.setItem("clip.pid", pid); } catch {}
  }
  $("#deleteProductBtn").hidden = !S.product;
  $("#productSelect").value = pid || "";
  await refreshPhotoUrls();
  renderPhotos(); fillForm(); syncSettingsUI();
  if (S.step === 4) renderResult();
  if (S.step === 3) renderGenCheck();
}
$("#productSelect").onchange = (e) => selectProduct(e.target.value);
$("#newProductBtn").onclick = async () => {
  const p = await store.saveProduct(null, {});
  S.settings = { ...DEFAULT_SETTINGS };
  await loadProducts(p.id); await selectProduct(p.id); goStep(1);
  toast("새 상품을 만들었습니다. 사진을 올려 주세요.");
};
$("#deleteProductBtn").onclick = async () => {
  if (!S.product || !confirm(`‘${S.product.brand} ${S.product.name}’ 상품과 사진·영상을 모두 삭제할까요?`)) return;
  await store.deleteProduct(S.product.id);
  await loadProducts(); await selectProduct("");
};
async function ensureProduct() {
  if (S.product) return S.product;
  const p = await store.saveProduct(null, {});
  S.settings = S.settings || { ...DEFAULT_SETTINGS };
  await loadProducts(p.id); await selectProduct(p.id);
  return S.product;
}
async function reloadProduct() {
  S.product = await store.getProduct(S.product.id);
  S.check = cw.checkProduct(S.product);
  await refreshPhotoUrls();
}

/* ------------------------------------------------------------ 1. 사진 */
function renderPhotos() {
  const grid = $("#photoGrid");
  const photos = S.product?.photos || [];
  const cnt = $("#photoCount");
  cnt.textContent = `${photos.length} / 10`;
  cnt.className = "pill " + (photos.length >= 5 && photos.length <= 10 ? "ok" : "warn");
  grid.innerHTML = photos.map((ph, i) => `<div class="photo" draggable="true" data-id="${ph.id}">
      <div class="thumb"><img src="${S.photoUrls[ph.id] || ""}" alt="상품 사진 ${i + 1}"><span class="num">${i + 1}</span></div>
      <div class="body">
        <select data-role="${ph.id}" aria-label="사진 ${i + 1} 역할">${Object.entries(cw.ROLES).map(([k, v]) => `<option value="${k}" ${k === ph.role ? "selected" : ""}>${v}</option>`).join("")}</select>
        <span class="src">${ph.role_source === "user" ? "직접 선택" : "역할을 선택하세요"}</span>
        <div class="ctrl">
          <button class="btn ghost" data-move="-1" data-id="${ph.id}" aria-label="앞으로">◀</button>
          <button class="btn ghost" data-move="1" data-id="${ph.id}" aria-label="뒤로">▶</button>
          <button class="btn ghost danger" data-del="${ph.id}">삭제</button>
        </div>
      </div></div>`).join("");
  $$("select[data-role]", grid).forEach((s) => (s.onchange = () => savePhotoOrder()));
  $$("[data-move]", grid).forEach((b) => (b.onclick = () => movePhoto(b.dataset.id, +b.dataset.move)));
  $$("[data-del]", grid).forEach((b) => (b.onclick = async () => {
    await store.deletePhoto(S.product.id, b.dataset.del);
    await reloadProduct(); renderPhotos(); loadProducts(S.product.id);
  }));
  setupDrag(grid);
}
const currentOrderItems = () => $$("#photoGrid .photo").map((el) => ({ id: el.dataset.id, role: $(`select[data-role="${el.dataset.id}"]`).value }));
async function savePhotoOrder(items = currentOrderItems()) {
  await store.updatePhotos(S.product.id, items);
  await reloadProduct(); renderPhotos();
}
function movePhoto(id, dir) {
  const items = currentOrderItems();
  const i = items.findIndex((x) => x.id === id), j = i + dir;
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
      const [moved] = items.splice(items.findIndex((x) => x.id === dragId), 1);
      items.splice(items.findIndex((x) => x.id === el.dataset.id), 0, moved);
      savePhotoOrder(items);
    });
  });
}
async function uploadPhotos(files, replace = false) {
  files = [...files].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  await ensureProduct();
  if (replace) await store.clearPhotos(S.product.id);
  await reloadProduct();
  const room = 10 - S.product.photos.length;
  if (files.length > room) { toast(`사진은 최대 10장입니다. 앞의 ${room}장만 올립니다.`); files = files.slice(0, Math.max(0, room)); }
  toast(`사진 ${files.length}장을 처리하는 중…`, 20000);
  const errors = [];
  let added = 0;
  for (const f of files) { try { await store.addPhoto(S.product.id, f); added++; } catch (e) { errors.push(e.message); } }
  await reloadProduct(); renderPhotos(); await loadProducts(S.product.id);
  toast(errors.length ? errors.join(" / ") : `사진 ${added}장을 올렸습니다.` + (replace ? " (기존 상품 정보는 그대로 사용)" : ""));
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
  const roleOf = Object.fromEntries(currentOrderItems().map((x) => [x.id, x.role]));
  const tmp = S.product.photos.map((p) => ({ ...p, role: roleOf[p.id] }));
  await savePhotoOrder(cw.suggestOrder(tmp).map((id) => ({ id, role: roleOf[id] })));
  toast(unset ? `역할 미지정 사진 ${unset}장은 뒤로 보냈습니다. 역할을 선택하면 더 정확해집니다.` : "제품 전체 → 세부 특징 → 사용 장면 → 포장 순으로 정렬했습니다.");
};

/* ------------------------------------------------------------ 2. 정보 */
function fillForm() {
  const f = $("#productForm");
  const p = S.product || {};
  ["brand", "name", "link", "target", "situation", "price", "promo", "promo_period", "disclosure"].forEach((k) => (f[k].value = p[k] || ""));
  f.tone.innerHTML = Object.entries(cw.TONES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
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
    price: f.price.value, promo: f.promo.value, promo_period: f.promo_period.value, tone: f.tone.value, disclosure: f.disclosure.value,
    features: [0, 1, 2].map((i) => f[`feature${i}`].value).filter((v) => v.trim()), must_include: f.must_include.value, exclude: f.exclude.value,
  };
}
async function saveForm(silent = false) {
  const d = formData();
  if (!S.product && !Object.values(d).some((v) => (Array.isArray(v) ? v.length : v.trim()))) return;
  await ensureProduct();
  S.product = await store.saveProduct(S.product.id, d);
  S.check = cw.checkProduct(S.product);
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
function buildSettingsPanel() {
  $("#settingsHost3").appendChild($("#settingsTpl").content.cloneNode(true));
  const panel = $("#settingsPanel");
  $('[data-set="cta_mode"]', panel).innerHTML = Object.entries(cw.CTA_MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $$("[data-set]", panel).forEach((el) => el.addEventListener(el.type === "range" || (el.tagName === "INPUT" && el.type !== "checkbox") ? "input" : "change", () => onSettingChange(el)));
  $("#musicForm").onsubmit = uploadMusic;
}
function fmtOut(key, v) {
  if (key.endsWith("_db")) return `${v > 0 ? "+" : ""}${v}dB`;
  if (key.startsWith("safe_") || key === "caption_offset") return `${Math.round(v * 100)}%`;
  if (key === "caption_scale") return `×${(+v).toFixed(2)}`;
  return `${v}초`;
}
function syncSettingsUI() {
  const panel = $("#settingsPanel");
  if (!panel) return;
  const st = (S.settings = S.settings || { ...DEFAULT_SETTINGS });
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
  renderMusicList();
}
let settingsTimer = null;
function onSettingChange(el) {
  const k = el.dataset.set;
  let v = el.type === "checkbox" ? el.checked : el.value;
  if (el.type === "range" || ["duration", "cover_scene"].includes(k)) v = +v;
  S.settings[k] = v;
  const out = $(`output[data-out="${k}"]`);
  if (out) out.textContent = fmtOut(k, v);
  if (k === "post_include_link") $("#postIncludeLink").checked = v;
  if (S.project) { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => saveProject({ settings: S.settings }), 400); }
}
function renderMusicList() {
  const st = S.settings;
  const items = [...S.music, { id: "none", title: "음악 없음", mood: "음악 없음" }];
  $("#musicList").innerHTML = items.map((m) => `
    <label class="music ${st.music === m.id ? "sel" : ""}">
      <input type="radio" name="music" value="${m.id}" ${st.music === m.id ? "checked" : ""}>
      <b>${esc(m.mood)}</b>
      <span class="small">${esc(m.title)}${m.duration ? ` · ${m.duration}초 반복` : ""}</span>
      ${m.id !== "none" ? `<span class="lic">출처: ${esc(m.source)}<br>라이선스: ${esc(m.license)}${m.builtin ? " — 상업적 이용·영상 배포 허용" : " (업로드 시 확인됨)"}</span>
      <audio controls preload="none" src="${m.url}"></audio>` : `<span class="lic">배경음악 없이 생성합니다(자막만, 무음 오디오 트랙 포함).</span>`}
    </label>`).join("");
  $$("#musicList input[name=music]").forEach((r) => (r.onchange = () => { S.settings.music = r.value; renderMusicList(); if (S.project) saveProject({ settings: S.settings }); }));
}
async function loadMusic() {
  const lib = await (await fetch("web/assets/music/library.json")).json();
  const ups = await store.listUploadedMusic();
  S.music = [...lib.map((m) => ({ ...m, url: `web/assets/music/${m.file}` })), ...ups.map((m) => ({ ...m, blob: undefined, url: URL.createObjectURL(m.blob), _blob: m.blob }))];
}
async function uploadMusic(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const file = fd.get("file");
  if (!fd.get("confirmed")) return toast("상업적 이용·배포 허용 여부를 확인해 주세요.");
  if (!String(fd.get("source")).trim() || !String(fd.get("license_name")).trim()) return toast("음악 출처와 라이선스를 입력해 주세요.");
  try {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const m = { id: "up_" + store.newId(), title: String(fd.get("title")).trim() || file.name, mood: "업로드한 음악", duration: Math.round(buf.duration * 100) / 100,
      source: String(fd.get("source")).trim(), license: String(fd.get("license_name")).trim(), builtin: false, blob: file, created: Date.now() };
    await store.saveUploadedMusic(m);
    await loadMusic();
    S.settings.music = m.id;
    e.target.reset(); renderMusicList();
    if (S.project) saveProject({ settings: S.settings });
    toast("음악을 올렸습니다.");
  } catch { toast("음악 파일을 읽을 수 없습니다. mp3·m4a·wav 파일을 사용하세요.", 5000); }
}

/* ------------------------------------------------------------ 초안·검사 */
function makeProject(hook) {
  const p = S.product;
  const st = { ...DEFAULT_SETTINGS, ...S.settings };
  const hooks = cw.hookCandidates(p);
  hook = (hook || "").trim() || hooks[0];
  const scenes = cw.buildScenes(p, +st.duration, hook, st);
  const post = cw.buildPost(p, st, hook);
  return { product_id: p.id, settings: st, hook, hook_candidates: hooks, scenes,
    post: { text: post.text, include_link: post.include_link, auto: true }, post_report: post, created: Date.now() };
}
function checkProject() {
  const p = S.product, pj = S.project;
  const a = cw.checkProduct(p), b = cw.checkScenes(p, pj.scenes, pj.settings);
  let capErrors = [];
  try { capErrors = validateCaptions(pj.scenes, p, pj.settings); } catch (e) { capErrors = [e.message]; }
  const errors = [...a.errors, ...b.errors, ...capErrors];
  if (pj.settings.cta_mode === "custom" && !(pj.settings.cta_custom || "").trim()) errors.push("구매 안내 문구를 ‘직접 입력’으로 선택했다면 문구를 입력하세요.");
  if (pj.settings.music !== "none" && !S.music.find((m) => m.id === pj.settings.music)) errors.push("선택한 배경음악을 찾을 수 없습니다. 다른 음악을 고르거나 ‘음악 없음’을 선택하세요.");
  return { errors, warnings: [...new Set([...a.warnings, ...b.warnings])] };
}
async function saveProject(body) {
  if (!S.product || !S.project) return;
  const pj = S.project;
  if (body.settings) {
    pj.settings = { ...DEFAULT_SETTINGS, ...pj.settings, ...body.settings };
    const cta = cw.ctaText(pj.settings.cta_mode, S.product.tone || "friendly", pj.settings.cta_custom || "");
    for (const sc of pj.scenes) if (sc.style === "card" && !sc.cta_locked) {
      sc.cta = cta;
      sc.narration = cw.outroNarration(S.product.brand, S.product.name, pj.settings.cta_mode, S.product.tone, cta);
    }
  }
  if (body.scenes) pj.scenes = body.scenes.map((sc) => ({ ...sc, duration: Math.round(Math.max(0.5, Math.min(20, +sc.duration || 0.5)) * 100) / 100 }));
  if (body.hook !== undefined) pj.hook = body.hook;
  if (body.post) pj.post = body.post;
  await store.saveProject(pj);
  S.projectCheck = checkProject();
  $("#projSave").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR");
  $("#sceneCheck").innerHTML = msgBox(S.projectCheck.errors, S.projectCheck.warnings);
  if (body.settings && S.step === 4) renderScenes();
}

/* ------------------------------------------------------------ 3. 생성 */
function renderGenCheck() {
  if (!S.product) { $("#genCheck").innerHTML = msgBox(["먼저 새 상품을 만들고 사진을 올려 주세요."]); return; }
  S.check = cw.checkProduct(S.product);
  $("#genCheck").innerHTML = msgBox(S.check.errors, S.check.warnings, "생성할 준비가 되었습니다.");
  $("#generateBtn").disabled = !!S.check.errors.length;
}
$("#generateBtn").onclick = async () => {
  if (!S.product) return;
  if (S.project && !confirm("새 초안을 만들면 직접 수정한 장면·자막·게시글이 초기화됩니다. 계속할까요?")) return;
  await draftAndRender();
};
async function draftAndRender() {
  if (!S.product) return toast("먼저 상품을 선택하거나 새로 만드세요.");
  S.check = cw.checkProduct(S.product);
  if (S.check.errors.length) { toast(S.check.errors[0], 5000); return; }
  try {
    S.project = makeProject();
    await store.saveProject(S.project);
    S.projectCheck = checkProject();
    S.settings = { ...S.project.settings };
    syncSettingsUI(); goStep(4);
    await startRender();
  } catch (e) { toast(e.message, 6000); $("#genCheck").innerHTML = msgBox([e.message]); }
}

/* ------------------------------------------------------------ 4. 결과 */
function renderResult() { renderKv(); renderPost(); renderScenes(); renderVideo(); if (S.job) renderJob(); }

function renderKv() {
  const p = S.product;
  if (!p) { $("#productKv").innerHTML = ""; return; }
  $("#productKv").innerHTML = `
    <dt>브랜드명</dt><dd><b>${esc(p.brand)}</b></dd>
    <dt>상품명</dt><dd><b>${esc(p.name)}</b></dd>
    <dt>구매 링크</dt><dd><code class="link">${esc(p.link)}</code>
      <div class="row gap wrap" style="margin-top:6px"><button class="btn primary" id="copyLinkBtn">구매 링크 복사</button>
      ${/^https?:\/\//.test(p.link) ? `<a class="btn ghost" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">링크 열어 확인</a>` : ""}</div>
      <span class="hint">입력한 원본 그대로입니다. 영상 속 주소는 클릭되지 않으므로 이 링크를 게시글이나 링크 위치에 붙여 넣으세요.</span></dd>
    <dt>확인된 특징</dt><dd>${(p.features || []).map(esc).join(" · ")}</dd>
    <dt>표시 문구</dt><dd>${p.disclosure ? esc(p.disclosure) : `<span class="pill warn">비어 있음</span>`}</dd>`;
  $("#copyLinkBtn").onclick = () => copyText(p.link, "구매 링크");
}

const renderUrls = [];
async function renderVideo() {
  const panel = $("#videoPanel");
  const list = S.product ? await store.listRenders(S.product.id) : [];
  renderUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const r = list[0];
  if (!r) { panel.innerHTML = `<p class="muted">아직 생성된 영상이 없습니다. 3단계에서 ‘초안 만들고 영상 생성’을 누르세요.</p>`; return; }
  const v = URL.createObjectURL(r.video), c = URL.createObjectURL(r.cover);
  renderUrls.push(v, c);
  const base = `${S.product.brand}_${S.product.name}`.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "clip";
  panel.innerHTML = `
    ${r.quality === "preview" ? `<div class="msg warn">빠른 미리보기 화질(540×960)입니다. 업로드용은 화질을 ‘최종’으로 바꿔 다시 생성하세요.</div>` : ""}
    <video controls playsinline preload="metadata" src="${v}" poster="${c}"></video>
    <div class="meta">
      <span class="pill ok">${r.width}×${r.height}</span><span class="pill ok">30fps</span><span class="pill ok">${r.duration.toFixed(2)}초</span>
      <span class="pill ok">H.264/AAC</span><span class="pill">${(r.video.size / 1048576).toFixed(1)}MB</span>
      <span class="pill">${r.music ? "음악: " + esc(r.music) : "음악 없음"}</span><span class="pill">내레이션 없음(웹 버전)</span>
    </div>
    <div class="downloads">
      <a class="btn primary" href="${v}" download="${esc(base)}_클립영상.mp4">MP4 다운로드</a>
      <a class="btn" href="${c}" download="${esc(base)}_표지.jpg">표지 이미지 다운로드</a>
    </div>
    <div class="cover"><img src="${c}" alt="표지 이미지"><span class="muted small">표지 이미지 1080×1920 JPG<br>생성: ${new Date(r.created).toLocaleString("ko-KR")}</span></div>
    ${list.length > 1 ? `<p class="muted small">이전 결과 ${list.length - 1}개를 이 브라우저에 보관 중입니다(최근 3개).</p>` : ""}`;
}

let postTimer = null;
function renderPost() {
  const pj = S.project;
  const ta = $("#postText");
  if (!pj) { ta.value = ""; updatePostCount(); $("#postMsgs").innerHTML = ""; return; }
  ta.value = pj.post.text;
  $("#postIncludeLink").checked = pj.post.include_link;
  updatePostCount(); checkPostNow();
  if (pj.post_report?.dropped?.length && pj.post.auto) $("#postMsgs").insertAdjacentHTML("beforeend", `<div class="msg warn">300자에 맞추기 위해 뺀 항목: ${esc(pj.post_report.dropped.join(", "))}</div>`);
}
function updatePostCount() {
  const n = cw.countChars($("#postText").value);
  $("#postCount").textContent = `${n} / 300자`;
  $("#postCount").className = "count " + (n > 300 ? "over" : "ok");
}
function checkPostNow() {
  if (!S.product || !S.project) return;
  const r = cw.checkPost(S.product, $("#postText").value, $("#postIncludeLink").checked);
  $("#postMsgs").innerHTML = msgBox(r.errors, r.warnings, `공백·줄바꿈·해시태그·표시 문구 포함 ${r.count}자 — 300자 이내입니다.`);
}
$("#postText").addEventListener("input", () => {
  updatePostCount();
  clearTimeout(postTimer);
  postTimer = setTimeout(() => { checkPostNow(); saveProject({ post: { text: $("#postText").value, include_link: $("#postIncludeLink").checked, auto: false } }); }, 400);
});
$("#postIncludeLink").onchange = async (e) => { S.settings.post_include_link = e.target.checked; syncSettingsUI(); await rebuildPost(true); };
async function rebuildPost(fromToggle = false) {
  if (!S.project) return;
  if (!fromToggle && !S.project.post.auto && !confirm("직접 수정한 게시글을 새로 작성한 글로 바꿀까요?")) return;
  const st = { ...S.project.settings, ...S.settings };
  const r = cw.buildPost(S.product, st, S.project.hook);
  S.project.post_report = r;
  await saveProject({ settings: S.settings, post: { text: r.text, include_link: r.include_link, auto: true } });
  $("#postText").value = r.text;
  updatePostCount();
  const c = cw.checkPost(S.product, r.text, r.include_link);
  $("#postMsgs").innerHTML = msgBox([...r.errors, ...c.errors], [...r.warnings, ...c.warnings], `공백·줄바꿈·해시태그·표시 문구 포함 ${r.count}자 — 300자 이내입니다.`) +
    (r.dropped.length ? `<div class="msg warn">300자에 맞추기 위해 뺀 항목: ${esc(r.dropped.join(", "))}</div>` : "");
}
$("#rebuildPostBtn").onclick = () => rebuildPost();
$("#copyPostBtn").onclick = () => {
  const t = $("#postText").value;
  if (cw.countChars(t) > 300 && !confirm("300자를 넘습니다. 그래도 복사할까요?")) return;
  copyText(t, "게시글");
};

function renderScenes() {
  const pj = S.project, list = $("#sceneList");
  if (!pj || !S.product) { list.innerHTML = `<p class="muted">초안이 없습니다.</p>`; $("#hookSelect").innerHTML = ""; $("#totalDur").textContent = ""; return; }
  $("#hookSelect").innerHTML = [...new Set([pj.hook, ...(pj.hook_candidates || [])])].map((h) => `<option ${h === pj.hook ? "selected" : ""}>${esc(h)}</option>`).join("");
  const photos = S.product.photos;
  let t = 0;
  list.innerHTML = pj.scenes.map((sc, i) => {
    const start = t; t += +sc.duration;
    const isCard = sc.style === "card";
    return `<div class="scene ${isCard ? "card-scene" : ""}" data-i="${i}">
      <div class="pic">
        ${S.photoUrls[sc.photo_id] ? `<img src="${S.photoUrls[sc.photo_id]}" alt="">` : `<div class="msg err">사진 없음</div>`}
        <select data-f="photo_id" aria-label="장면 사진">${photos.map((p, k) => `<option value="${p.id}" ${p.id === sc.photo_id ? "selected" : ""}>사진 ${k + 1}</option>`).join("")}</select>
      </div>
      <div>
        <div class="head"><b>${i + 1}</b><span class="seg">${esc(cw.SEGMENTS[sc.segment] || sc.segment)}</span><span class="time">${start.toFixed(1)}~${t.toFixed(1)}초</span></div>
        ${isCard ? `<div class="small">마무리 화면: <b>${esc(S.product.brand)}</b> / <b>${esc(S.product.name)}</b> (상품 정보에서 자동 표시)</div>
          <label>구매 안내 문구 <input data-f="cta" value="${esc(sc.cta || "")}" maxlength="30"></label>`
        : `<label>자막 <span class="capinfo">최대 두 줄 · 줄바꿈은 Enter (현재 ${(sc.caption || "").split("\n").length}줄)</span>
          <textarea data-f="caption" rows="2" maxlength="80">${esc(sc.caption)}</textarea></label>`}
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
      if (f === "caption") { const ls = v.split("\n"); if (ls.length > 2) { v = ls.slice(0, 2).join("\n"); inp.value = v; toast("자막은 두 줄까지 가능합니다."); } }
      pj.scenes[i][f] = v;
      if (f === "cta") pj.scenes[i].cta_locked = true;
      if (f === "photo_id" || f === "style") renderScenes();
      if (f === "duration") $("#totalDur").textContent = `전체 ${pj.scenes.reduce((a, s) => a + +s.duration, 0).toFixed(1)}초 · 장면 ${pj.scenes.length}개`;
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
  sceneTimer = setTimeout(() => saveProject({ scenes: S.project.scenes }), 500);
}
async function sceneAction(i, a) {
  const sc = S.project.scenes;
  if (a === "preview") return previewScene(i);
  if (a === "up" && i > 0) [sc[i - 1], sc[i]] = [sc[i], sc[i - 1]];
  if (a === "down" && i < sc.length - 1) [sc[i + 1], sc[i]] = [sc[i], sc[i + 1]];
  if (a === "dup") sc.splice(i + 1, 0, { ...sc[i], id: "s" + Date.now(), narration: "" });
  if (a === "del") { if (sc.length <= 2) return toast("장면이 너무 적습니다."); sc.splice(i, 1); }
  renderScenes(); syncSettingsUI();
  await saveProject({ scenes: sc });
}

async function photoBlobs(ids) {
  const out = {};
  for (const id of new Set(ids)) { const r = await store.getPhotoRecord(id); if (r) out[id] = r.blob; }
  return out;
}

async function previewScene(i) {
  clearTimeout(sceneTimer);
  await saveProject({ scenes: S.project.scenes, settings: S.settings });
  const note = `<p class="muted small">실제 렌더링 결과가 아니라 장면 중간의 정지 화면입니다(540×960). 빨간 영역은 플랫폼 UI가 겹칠 수 있는 곳입니다.</p>`;
  openModal(`${i + 1}번 장면 정지 미리보기`, note + "<p>불러오는 중…</p>");
  try {
    const sc = S.project.scenes;
    const tl = await Timeline.create([sc[i]], await photoBlobs([sc[i].photo_id]), S.product, S.project.settings, 540, 960);
    const c = document.createElement("canvas");
    c.width = 540; c.height = 960;
    const g = c.getContext("2d");
    tl.draw(g, +sc[i].duration * 0.6);
    drawGuide(g, tl.lay);
    c.style.cssText = "width:100%;border-radius:8px;margin-top:10px";
    $("#modalBody").innerHTML = note;
    $("#modalBody").appendChild(c);
  } catch (e) { $("#modalBody").innerHTML = msgBox([e.message]); }
}

$("#hookSelect").onchange = async (e) => {
  const h = e.target.value, old = S.project.hook;
  S.project.scenes.forEach((s) => { if (s.segment === "hook" && s.caption === old) { s.caption = h; if (s.narration) s.narration = h; } });
  await saveProject({ scenes: S.project.scenes, hook: h });
  renderScenes();
  toast("첫 문장을 바꿨습니다. 게시글에도 쓰려면 ‘게시글 다시 작성’을 누르세요.");
};
$("#rerenderBtn").onclick = async () => {
  if (!S.project) return toast("먼저 초안을 만드세요(3단계).");
  clearTimeout(sceneTimer); clearTimeout(settingsTimer);
  await saveProject({ scenes: S.project.scenes, settings: S.settings });
  if (S.projectCheck?.errors.length) return toast("고쳐야 할 항목이 있어 생성할 수 없습니다.", 4000);
  await startRender();
};
$("#redraftBtn").onclick = async () => {
  if (!confirm("장면·자막·게시글을 현재 설정으로 새로 만듭니다. 직접 수정한 내용은 사라집니다. 계속할까요?")) return;
  await draftAndRender();
};

/* ------------------------------------------------------------ 렌더 작업(브라우저) */
const STAGES = [["validate", "입력 검증"], ["photos", "사진 준비"], ["captions", "자막·마무리 화면 준비"], ["audio", "배경음악·오디오 믹싱"],
  ["video", "영상 렌더링(H.264/AAC)"], ["cover", "표지 이미지 생성"], ["verify", "결과 파일 검증"], ["save", "브라우저에 저장"]];
const HINTS = {
  validate: "표시된 입력 오류를 고친 뒤 ‘다시 생성’을 누르세요.", photos: "문제가 된 사진을 삭제하고 다시 올린 뒤 재시도하세요.",
  captions: "길거나 줄이 많은 자막을 줄인 뒤 재시도하세요.", audio: "다른 배경음악을 고르거나 ‘음악 없음’으로 바꿔 재시도하세요.",
  video: "다른 탭을 닫고 다시 생성하세요. 반복되면 ‘빠른 미리보기’ 화질로 시도하거나 PC의 최신 Chrome/Edge를 사용하세요.",
  cover: "표지 장면을 다른 장면으로 바꾼 뒤 재시도하세요.", verify: "결과 파일이 올바르지 않습니다. 다시 생성하세요.",
  save: "브라우저 저장 공간이 부족할 수 있습니다. 이전 상품을 삭제한 뒤 재시도하세요.",
};

async function startRender() {
  if (S.job?.status === "running") return toast("이미 생성 중입니다.");
  const job = (S.job = { status: "running", progress: 0, warnings: [], stages: STAGES.map(([key, label]) => ({ key, label, status: "pending", message: "" })) });
  const stage = (key, status, message = "") => { const s = job.stages.find((x) => x.key === key); s.status = status; if (message) s.message = message; job.current = key; renderJob(); };
  let key = "validate";
  const wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
  try {
    const p = S.product, pj = S.project, st = pj.settings;
    stage(key, "running");
    S.projectCheck = checkProject();
    job.warnings.push(...S.projectCheck.warnings);
    if (S.projectCheck.errors.length) throw new Error(S.projectCheck.errors.join(" / "));
    const caps = S.caps;
    if (!(caps.webcodecs && caps.video && caps.audio)) throw new Error("이 브라우저에서는 MP4를 만들 수 없습니다. PC의 최신 Chrome 또는 Edge에서 열어 주세요.");
    stage(key, "done");

    key = "photos"; stage(key, "running");
    const blobs = await photoBlobs(pj.scenes.map((s) => s.photo_id));
    if (pj.scenes.some((s) => !blobs[s.photo_id])) throw new Error("장면에 쓰인 사진 파일을 찾을 수 없습니다.");
    stage(key, "done", `${Object.keys(blobs).length}장 사용`);

    key = "captions"; stage(key, "running");
    const preview = st.quality === "preview";
    const W = preview ? 540 : VIDEO.width, H = preview ? 960 : VIDEO.height;
    const tl = await Timeline.create(pj.scenes, blobs, p, st, W, H);
    stage(key, "done", `자막 ${tl.cues.length}개`);

    key = "audio"; stage(key, "running");
    const track = st.music !== "none" ? S.music.find((m) => m.id === st.music) : null;
    const musicBlob = track ? (track._blob || (await (await fetch(track.url)).blob())) : null;
    const { buffer, info } = await mixAudio(tl.total, musicBlob, st);
    job.warnings.push(...info.warnings);
    stage(key, "done", track ? `음악: ${track.title}` : "음악 없음(무음 오디오 트랙)");

    key = "video"; stage(key, "running");
    const t0 = performance.now();
    const enc = await encodeMp4(tl, buffer, { W, H, fps: VIDEO.fps, onProgress: (f) => { job.progress = f; stage("video", "running", `${Math.round(f * 100)}%`); } });
    stage(key, "done", `${((performance.now() - t0) / 1000).toFixed(0)}초 소요 · ${enc.codec}`);

    key = "cover"; stage(key, "running");
    const coverTl = preview ? await Timeline.create(pj.scenes, blobs, p, st, 1080, 1920) : tl;
    const cover = await renderCover(coverTl, p, +st.cover_scene || 0, st.cover_text || pj.hook);
    if (!cover || cover.size < 10000) throw new Error("표지 이미지가 생성되지 않았습니다.");
    stage(key, "done");

    key = "verify"; stage(key, "running");
    const v = await verifyMp4(enc.blob, W, H, tl.total);
    if (!v.ok) throw new Error(v.problems.join("; "));
    stage(key, "done", `${v.width}x${v.height} · ${v.duration.toFixed(2)}초 · 영상 ${enc.vChunks}프레임·오디오 ${enc.aChunks}블록`);

    key = "save"; stage(key, "running");
    await store.addRender({ id: store.newId(), product_id: p.id, created: Date.now(), video: enc.blob, cover, width: W, height: H,
      duration: v.duration, quality: preview ? "preview" : "final", music: track ? track.title : null, codec: enc.codec, scenes: pj.scenes.length });
    stage(key, "done");
    job.status = "done";
    renderJob();
    await renderVideo();
    toast("영상 생성이 완료되었습니다.");
  } catch (e) {
    console.error(e);
    stage(key, "failed", String(e.message || e).slice(0, 400));
    job.status = "failed"; job.failed = key; job.error = String(e.message || e); job.hint = HINTS[key];
    renderJob();
  } finally { wakeLock?.release?.().catch(() => {}); }
}

function renderJob() {
  const j = S.job;
  if (!j || S.step !== 4) return;
  const ico = { pending: "○", running: "◐", done: "✓", failed: "✕", skipped: "–" };
  const st = { pending: "대기", running: "진행 중", done: "완료", failed: "실패", skipped: "건너뜀" };
  const doneN = j.stages.filter((s) => s.status === "done").length;
  const pct = Math.round(((doneN + (j.current === "video" && j.status === "running" ? j.progress : 0)) / j.stages.length) * 100);
  let h = "";
  if (j.status !== "done") {
    h += `<div class="bar"><i style="width:${pct}%"></i></div><ul class="stages">${j.stages.map((s) =>
      `<li class="${s.status}"><span class="ico">${ico[s.status]}</span><span>${esc(s.label)} · ${st[s.status]} <span class="m">${esc(s.message)}</span></span></li>`).join("")}</ul>`;
    if (j.status === "running") h += `<p class="muted small">생성 중에는 이 탭을 닫거나 다른 탭으로 오래 옮기지 마세요(브라우저가 작업을 늦출 수 있습니다).</p>`;
  }
  if (j.status === "failed") {
    const label = j.stages.find((s) => s.key === j.failed)?.label;
    h += `<div class="msg err"><b>‘${esc(label)}’ 단계에서 실패했습니다. 결과물은 만들어지지 않았습니다.</b><br>${esc(j.error)}<br><b>해결 방법:</b> ${esc(j.hint || "")}</div><button class="btn primary" id="retryBtn">다시 시도</button>`;
  }
  if (j.status === "done") {
    if (j.warnings.length) h += msgBox([], [...new Set(j.warnings)]);
    h += `<div class="msg ok">생성 완료 — 결과 파일 검증(해상도·길이·재생)을 통과했습니다.</div>`;
  }
  $("#jobPanel").innerHTML = h;
  const rb = $("#retryBtn");
  if (rb) rb.onclick = () => startRender();
}

/* ------------------------------------------------------------ 시작 */
async function init() {
  try {
    await loadFonts().catch(() => {});
    S.caps = await capabilities(VIDEO.width, VIDEO.height, VIDEO.fps);
    await loadMusic();
  } catch (e) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="msg err">앱을 시작할 수 없습니다: ${esc(e.message)}</div>`);
    return;
  }
  renderStatus();
  S.settings = { ...DEFAULT_SETTINGS };
  buildSettingsPanel();
  await loadProducts();
  let last = null;
  try { last = localStorage.getItem("clip.pid"); } catch {}
  if (last && S.products.some((p) => p.id === last)) await selectProduct(last);
  else { renderPhotos(); syncSettingsUI(); }
  goStep(1);
  window.__clip = { S, uploadPhotos, startRender, store }; // 점검용
}
init();
