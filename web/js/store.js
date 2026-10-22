// 브라우저 저장소(IndexedDB): 상품·사진·제작 초안·결과 영상·업로드 음악. 서버로 보내지 않는다.

const DB_NAME = "clip-studio";
const DB_VERSION = 1;
const PRODUCT_FIELDS = {
  brand: "", name: "", link: "", features: [], target: "", situation: "", price: "", promo: "", promo_period: "",
  tone: "friendly", disclosure: "", must_include: [], exclude: [],
};

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("products", { keyPath: "id" });
        d.createObjectStore("photos", { keyPath: "id" }).createIndex("product_id", "product_id");
        d.createObjectStore("projects", { keyPath: "product_id" });
        d.createObjectStore("renders", { keyPath: "id" }).createIndex("product_id", "product_id");
        d.createObjectStore("music", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("브라우저 저장소(IndexedDB)를 열 수 없습니다. 시크릿 모드이거나 저장소가 차단되었을 수 있습니다."));
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => (out = v));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error("저장 실패"));
    t.onabort = () => reject(t.error || new Error("저장 공간이 부족하거나 저장이 중단되었습니다."));
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const get = (store, key) => tx(store, "readonly", (s) => req(s.get(key)));
const put = (store, val) => tx(store, "readwrite", (s) => req(s.put(val)));
const del = (store, key) => tx(store, "readwrite", (s) => req(s.delete(key)));
const all = (store) => tx(store, "readonly", (s) => req(s.getAll()));
const byProduct = (store, pid) => tx(store, "readonly", (s) => req(s.index("product_id").getAll(pid)));

export const newId = () => crypto.getRandomValues(new Uint32Array(2)).reduce((a, n) => a + n.toString(16).padStart(8, "0"), "").slice(0, 12);

export function cleanList(v) {
  if (typeof v === "string") v = v.replace(/,/g, "\n").split("\n");
  return (v || []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
}

function normalize(data) {
  const out = {};
  for (const [k, def] of Object.entries(PRODUCT_FIELDS)) {
    if (!(k in data)) continue;
    const v = data[k];
    if (Array.isArray(def)) out[k] = cleanList(v);
    else out[k] = typeof v === "string" ? v.trim() : def; // 링크는 앞뒤 공백만 제거, 쿼리 문자열 등은 그대로
  }
  return out;
}

export async function listProducts() {
  const items = await all("products");
  return items.map((p) => ({ id: p.id, brand: p.brand, name: p.name, photo_count: p.photos.length, updated: p.updated }))
    .sort((a, b) => b.updated - a.updated);
}
export const getProduct = (id) => get("products", id);

export async function saveProduct(id, data) {
  let p = id ? await getProduct(id) : null;
  if (!p) p = { id: id || newId(), ...structuredClone(PRODUCT_FIELDS), photos: [], created: Date.now() };
  Object.assign(p, normalize(data), { updated: Date.now() });
  await put("products", p);
  return p;
}

export async function deleteProduct(id) {
  for (const ph of await byProduct("photos", id)) await del("photos", ph.id);
  for (const r of await byProduct("renders", id)) await del("renders", r.id);
  await del("projects", id);
  await del("products", id);
}

async function toJpeg(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; // 투명 배경은 흰색으로
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, w, h);
  return { blob: await c.convertToBlob({ type: "image/jpeg", quality }), w, h };
}

/** 원본 사진을 디코딩해 방향(EXIF)만 바로잡고 저장한다. 형태·색상은 바꾸지 않는다. */
export async function addPhoto(pid, file) {
  const p = await getProduct(pid);
  if (p.photos.length >= 10) throw new Error("사진은 최대 10장까지 올릴 수 있습니다.");
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error(`‘${file.name}’ 파일을 이미지로 읽을 수 없습니다.`); }
  const full = await toJpeg(bmp, 3000, 0.95);
  const thumb = await toJpeg(bmp, 360, 0.85);
  bmp.close();
  const id = newId();
  await put("photos", { id, product_id: pid, blob: full.blob, thumb: thumb.blob });
  const photo = { id, original_name: file.name, width: full.w, height: full.h, role: "unset", role_source: "none" };
  const cur = await getProduct(pid);
  cur.photos.push(photo);
  cur.updated = Date.now();
  await put("products", cur);
  return photo;
}

export async function updatePhotos(pid, items) {
  const p = await getProduct(pid);
  const map = Object.fromEntries(p.photos.map((ph) => [ph.id, ph]));
  const next = [];
  for (const it of items) {
    const ph = map[it.id];
    if (!ph) continue;
    delete map[it.id];
    if (it.role && it.role !== ph.role) { ph.role = it.role; ph.role_source = "user"; }
    next.push(ph);
  }
  p.photos = [...next, ...Object.values(map)];
  p.updated = Date.now();
  await put("products", p);
  return p;
}

export async function deletePhoto(pid, photoId) {
  const p = await getProduct(pid);
  p.photos = p.photos.filter((ph) => ph.id !== photoId);
  p.updated = Date.now();
  await del("photos", photoId);
  await put("products", p);
  urlCache.delete(photoId + ":t"); urlCache.delete(photoId + ":f");
  return p;
}

export async function clearPhotos(pid) {
  const p = await getProduct(pid);
  for (const ph of p.photos) await deletePhoto(pid, ph.id);
  return getProduct(pid);
}

export const getPhotoRecord = (id) => get("photos", id);

const urlCache = new Map();
export async function photoURL(id, thumb = true) {
  const key = id + (thumb ? ":t" : ":f");
  if (!urlCache.has(key)) {
    const r = await getPhotoRecord(id);
    if (!r) return "";
    urlCache.set(key, URL.createObjectURL(thumb ? r.thumb : r.blob));
  }
  return urlCache.get(key);
}

export const getProject = (pid) => get("projects", pid);
export const saveProject = (project) => put("projects", { ...project, updated: Date.now() });

export async function addRender(r) {
  await put("renders", r);
  const list = (await byProduct("renders", r.product_id)).sort((a, b) => b.created - a.created);
  for (const old of list.slice(3)) await del("renders", old.id); // 최근 3개만 보관(브라우저 저장 공간 절약)
}
export async function listRenders(pid) {
  return (await byProduct("renders", pid)).sort((a, b) => b.created - a.created);
}

export const listUploadedMusic = () => all("music");
export const saveUploadedMusic = (m) => put("music", m);
export const getUploadedMusic = (id) => get("music", id);

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
