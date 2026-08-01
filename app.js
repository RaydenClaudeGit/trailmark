/* ==========================================================================
   Trailmark — offline hiking companion
   Single-purpose app: load a GPX route, cache its map tiles for offline use,
   then track your position along it with no signal.
   ========================================================================== */

'use strict';

/* ---------------------------------------------------------------- storage */

const DB_NAME = 'trailmark';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
      if (!db.objectStoreNames.contains('routes')) db.createObjectStore('routes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(store, value, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const r = key === undefined ? os.put(value) : os.put(value, key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

async function idbCount(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbClear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

/* ------------------------------------------------------------- geo helpers */

const R_EARTH = 6371000;
const rad = d => d * Math.PI / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const la1 = rad(a.lat), la2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

function project(lat, lon, z) {
  const s = 256 * Math.pow(2, z);
  const x = (lon + 180) / 360 * s;
  const latRad = rad(Math.max(-85.05112878, Math.min(85.05112878, lat)));
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * s;
  return { x, y };
}

function unproject(x, y, z) {
  const s = 256 * Math.pow(2, z);
  const lon = x / s * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / s;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

/* OS-style grid reference for Great Britain. Approximate — good enough to
   read out to mountain rescue, not good enough for surveying. */
function toOSGridRef(lat, lon) {
  const a = 6377563.396, b = 6356256.909, F0 = 0.9996012717;
  const lat0 = rad(49), lon0 = rad(-2), N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);

  // WGS84 -> OSGB36 (Helmert, metres-level accuracy)
  const h = 0;
  const sinP = Math.sin(rad(lat)), cosP = Math.cos(rad(lat));
  const sinL = Math.sin(rad(lon)), cosL = Math.cos(rad(lon));
  const aW = 6378137, f1 = 1 / 298.257223563, e2W = 2 * f1 - f1 * f1;
  const nu = aW / Math.sqrt(1 - e2W * sinP * sinP);
  let x1 = (nu + h) * cosP * cosL;
  let y1 = (nu + h) * cosP * sinL;
  let z1 = ((1 - e2W) * nu + h) * sinP;
  const tx = -446.448, ty = 125.157, tz = -542.060;
  const rx = rad(-0.1502 / 3600), ry = rad(-0.2470 / 3600), rz = rad(-0.8421 / 3600);
  const s1 = 20.4894 / 1e6 + 1;
  const x2 = tx + x1 * s1 - y1 * rz + z1 * ry;
  const y2 = ty + x1 * rz + y1 * s1 - z1 * rx;
  const z2 = tz - x1 * ry + y1 * rx + z1 * s1;

  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let phi = Math.atan2(z2, p * (1 - e2)), phiP = 2 * Math.PI;
  let nu2 = a;
  let guard = 0;
  while (Math.abs(phi - phiP) > 1e-12 && guard++ < 50) {
    nu2 = a / Math.sqrt(1 - e2 * Math.sin(phi) * Math.sin(phi));
    phiP = phi;
    phi = Math.atan2(z2 + e2 * nu2 * Math.sin(phi), p);
  }
  const lam = Math.atan2(y2, x2);

  const sp = Math.sin(phi), cp = Math.cos(phi), tp = Math.tan(phi);
  const nuT = a * F0 / Math.sqrt(1 - e2 * sp * sp);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sp * sp, 1.5);
  const eta2 = nuT / rho - 1;

  const dPhi = phi - lat0, sPhi = phi + lat0;
  const Ma = (1 + n + 1.25 * n * n + 1.25 * n * n * n) * dPhi;
  const Mb = (3 * n + 3 * n * n + 2.625 * n * n * n) * Math.sin(dPhi) * Math.cos(sPhi);
  const Mc = (1.875 * n * n + 1.875 * n * n * n) * Math.sin(2 * dPhi) * Math.cos(2 * sPhi);
  const Md = (35 / 24) * n * n * n * Math.sin(3 * dPhi) * Math.cos(3 * sPhi);
  const M = b * F0 * (Ma - Mb + Mc - Md);

  const I = M + N0;
  const II = (nuT / 2) * sp * cp;
  const III = (nuT / 24) * sp * Math.pow(cp, 3) * (5 - tp * tp + 9 * eta2);
  const IIIA = (nuT / 720) * sp * Math.pow(cp, 5) * (61 - 58 * tp * tp + Math.pow(tp, 4));
  const IV = nuT * cp;
  const V = (nuT / 6) * Math.pow(cp, 3) * (nuT / rho - tp * tp);
  const VI = (nuT / 120) * Math.pow(cp, 5) * (5 - 18 * tp * tp + Math.pow(tp, 4) + 14 * eta2 - 58 * tp * tp * eta2);

  const dL = lam - lon0;
  const N = I + II * dL * dL + III * Math.pow(dL, 4) + IIIA * Math.pow(dL, 6);
  const E = E0 + IV * dL + V * Math.pow(dL, 3) + VI * Math.pow(dL, 5);

  if (E < 0 || E > 700000 || N < 0 || N > 1300000) return null;

  const e100 = Math.floor(E / 100000), n100 = Math.floor(N / 100000);
  let l1 = (19 - n100) - (19 - n100) % 5 + Math.floor((e100 + 10) / 5);
  let l2 = (19 - n100) * 5 % 25 + e100 % 5;
  if (l1 > 7) l1++;
  if (l2 > 7) l2++;
  const letters = String.fromCharCode(l1 + 65) + String.fromCharCode(l2 + 65);
  const eStr = String(Math.floor((E % 100000) / 100)).padStart(3, '0');
  const nStr = String(Math.floor((N % 100000) / 100)).padStart(3, '0');
  return letters + ' ' + eStr + ' ' + nStr;
}

/* ------------------------------------------------------------ route model */

/* Build cumulative distance + smoothed elevation for a list of {lat,lon,ele} */
function buildRoute(name, pts) {
  const points = pts.filter(p => isFinite(p.lat) && isFinite(p.lon));
  if (points.length < 2) throw new Error('Route needs at least two points.');

  let cum = 0;
  points[0].d = 0;
  for (let i = 1; i < points.length; i++) {
    cum += haversine(points[i - 1], points[i]);
    points[i].d = cum;
  }

  // Smooth elevation before summing ascent, otherwise GPS noise inflates it badly.
  const hasEle = points.some(p => isFinite(p.ele));
  let ascent = 0, descent = 0;
  if (hasEle) {
    const win = 5;
    const sm = points.map((p, i) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(points.length - 1, i + win); j++) {
        if (isFinite(points[j].ele)) { s += points[j].ele; c++; }
      }
      return c ? s / c : 0;
    });
    points.forEach((p, i) => { p.eleSmooth = sm[i]; });
    for (let i = 1; i < points.length; i++) {
      const diff = sm[i] - sm[i - 1];
      if (diff > 0) ascent += diff; else descent -= diff;
    }
  } else {
    points.forEach(p => { p.eleSmooth = 0; });
  }

  const lats = points.map(p => p.lat), lons = points.map(p => p.lon);
  return {
    id: 'r' + Date.now() + Math.floor(Math.random() * 1000),
    name,
    points,
    length: cum,
    ascent: Math.round(ascent),
    descent: Math.round(descent),
    hasEle,
    bounds: {
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
      minLon: Math.min(...lons), maxLon: Math.max(...lons)
    },
    created: Date.now(),
    tilesCached: 0
  };
}

function parseGPX(text, fallbackName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error("That file isn't valid GPX.");

  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('rtept'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('wpt'));
  if (!nodes.length) throw new Error('No track points found in that GPX file.');

  const pts = nodes.map(n => {
    const eleNode = n.getElementsByTagName('ele')[0];
    return {
      lat: parseFloat(n.getAttribute('lat')),
      lon: parseFloat(n.getAttribute('lon')),
      ele: eleNode ? parseFloat(eleNode.textContent) : NaN
    };
  });

  const nameNode = doc.getElementsByTagName('name')[0];
  const name = (nameNode && nameNode.textContent.trim()) || fallbackName || 'Imported route';
  return buildRoute(name, pts);
}

/* Nearest point on the route to a position. Returns {d, offset, index}
   where d = distance along route (m), offset = how far off-route (m). */
function snapToRoute(route, lat, lon) {
  const pts = route.points;
  // Local flat projection is fine at these scales and much faster than haversine per point.
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(rad(lat));
  const px = lon * mPerDegLon, py = lat * mPerDegLat;

  let best = { offset: Infinity, d: 0, index: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = a.lon * mPerDegLon, ay = a.lat * mPerDegLat;
    const bx = b.lon * mPerDegLon, by = b.lat * mPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const off = Math.hypot(px - qx, py - qy);
    if (off < best.offset) {
      best = { offset: off, d: a.d + t * (b.d - a.d), index: i };
    }
  }
  return best;
}

function eleAtDistance(route, d) {
  const pts = route.points;
  if (d <= 0) return pts[0].eleSmooth;
  if (d >= route.length) return pts[pts.length - 1].eleSmooth;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d <= d) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const t = (d - a.d) / ((b.d - a.d) || 1);
  return a.eleSmooth + (b.eleSmooth - a.eleSmooth) * t;
}

/* Interpolated {lat,lon} at distance d along the route — same bracketing
   approach as eleAtDistance, for placing markers rather than reading elevation. */
function pointAtDistance(route, d) {
  const pts = route.points;
  if (d <= 0) return { lat: pts[0].lat, lon: pts[0].lon };
  if (d >= route.length) return { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon };
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d <= d) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const t = (d - a.d) / ((b.d - a.d) || 1);
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/* One marker every stepM metres along the route (unit is 'km' or 'mi'). */
function computeMilestones(route, unit) {
  const stepM = unit === 'mi' ? 1609.344 : 1000;
  const out = [];
  let n = 1;
  for (let d = stepM; d < route.length; d += stepM, n++) {
    out.push({ d, n, ...pointAtDistance(route, d) });
  }
  return out;
}

function ascentUpTo(route, d) {
  let asc = 0;
  const pts = route.points;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].d > d) break;
    const diff = pts[i].eleSmooth - pts[i - 1].eleSmooth;
    if (diff > 0) asc += diff;
  }
  return asc;
}

/* ------------------------------------------------------------- tile layer */

const TILE_SOURCES = {
  osm: {
    name: 'OpenStreetMap',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  },
  topo: {
    name: 'OpenTopoMap',
    url: (z, x, y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
    maxZoom: 17
  }
};

let tileSourceKey = 'topo';
const memTiles = new Map();      // "src/z/x/y" -> {img} | 'missing' | 'loading'
const inflight = new Set();

function tileKey(src, z, x, y) { return `${src}/${z}/${x}/${y}`; }

function getTile(z, x, y, onReady) {
  const key = tileKey(tileSourceKey, z, x, y);
  const cached = memTiles.get(key);
  if (cached && cached.img) return cached.img;
  if (cached === 'loading' || cached === 'missing') return null;

  memTiles.set(key, 'loading');
  loadTile(tileSourceKey, z, x, y, key).then(img => {
    memTiles.set(key, img ? { img } : 'missing');
    if (memTiles.size > 900) {
      // Trim oldest entries so long sessions don't grow unbounded.
      const it = memTiles.keys();
      for (let i = 0; i < 300; i++) {
        const k = it.next().value;
        if (k === undefined) break;
        memTiles.delete(k);
      }
    }
    if (img && onReady) onReady();
  });
  return null;
}

async function blobToImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    return img;
  } catch (e) {
    URL.revokeObjectURL(url);
    return null;
  }
}

async function loadTile(src, z, x, y, key) {
  try {
    const stored = await idbGet('tiles', key);
    if (stored) return await blobToImage(stored);
  } catch (e) { /* IndexedDB unavailable — fall through to network */ }

  if (!navigator.onLine) return null;
  try {
    const res = await fetch(TILE_SOURCES[src].url(z, x, y));
    if (!res.ok) return null;
    const blob = await res.blob();
    try { await idbPut('tiles', blob, key); } catch (e) { /* quota — still render it */ }
    return await blobToImage(blob);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------- offline download */

function tilesForBounds(bounds, z, bufferPx) {
  const nw = project(bounds.maxLat, bounds.minLon, z);
  const se = project(bounds.minLat, bounds.maxLon, z);
  const x0 = Math.floor((nw.x - bufferPx) / 256), x1 = Math.floor((se.x + bufferPx) / 256);
  const y0 = Math.floor((nw.y - bufferPx) / 256), y1 = Math.floor((se.y + bufferPx) / 256);
  const out = [];
  const max = Math.pow(2, z);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= max || y >= max) continue;
      out.push([z, x, y]);
    }
  }
  return out;
}

/* Only keep tiles the route actually passes near — a bounding box over a
   long linear walk wastes most of its tiles on sea or empty downland. */
function tilesNearRoute(route, z, corridorMetres) {
  const set = new Set();
  const pts = route.points;
  const metresPerPixel = lat => 156543.03392 * Math.cos(rad(lat)) / Math.pow(2, z);
  for (const p of pts) {
    const mpp = metresPerPixel(p.lat);
    const padTiles = Math.ceil((corridorMetres / mpp) / 256);
    const w = project(p.lat, p.lon, z);
    const tx = Math.floor(w.x / 256), ty = Math.floor(w.y / 256);
    for (let dx = -padTiles; dx <= padTiles; dx++) {
      for (let dy = -padTiles; dy <= padTiles; dy++) {
        const x = tx + dx, y = ty + dy;
        const max = Math.pow(2, z);
        if (x < 0 || y < 0 || x >= max || y >= max) continue;
        set.add(`${z},${x},${y}`);
      }
    }
  }
  return Array.from(set).map(s => s.split(',').map(Number));
}

const MAX_DOWNLOAD_TILES = 3000;

async function downloadRouteTiles(route, zooms, corridorMetres, onProgress, shouldStop) {
  let jobs = [];
  for (const z of zooms) {
    if (z > TILE_SOURCES[tileSourceKey].maxZoom) continue;
    jobs = jobs.concat(tilesNearRoute(route, z, corridorMetres));
  }
  if (jobs.length > MAX_DOWNLOAD_TILES) {
    return { capped: true, total: jobs.length };
  }

  let done = 0, saved = 0, failed = 0, bytes = 0;
  const CONCURRENCY = 4;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      if (shouldStop && shouldStop()) return;
      const job = jobs[idx++];
      const [z, x, y] = job;
      const key = tileKey(tileSourceKey, z, x, y);
      try {
        const existing = await idbGet('tiles', key);
        if (existing) { done++; saved++; bytes += existing.size || 0; onProgress(done, jobs.length, bytes); continue; }
        const res = await fetch(TILE_SOURCES[tileSourceKey].url(z, x, y));
        if (res.ok) {
          const blob = await res.blob();
          await idbPut('tiles', blob, key);
          saved++; bytes += blob.size;
        } else { failed++; }
      } catch (e) { failed++; }
      done++;
      onProgress(done, jobs.length, bytes);
      // Deliberate throttle: these are free community tile servers.
      await new Promise(r => setTimeout(r, 45));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { capped: false, total: jobs.length, saved, failed, bytes };
}

/* ------------------------------------------------------------- map canvas */

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');

const view = { lat: 51.0, lon: -0.5, zoom: 14 };
let followMode = true;
let needsRender = true;

function requestRender() { needsRender = true; }

function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  requestRender();
}

function screenOf(lat, lon) {
  const tz = Math.max(1, Math.min(19, Math.round(view.zoom)));
  const scale = Math.pow(2, view.zoom - tz);
  const c = project(view.lat, view.lon, tz);
  const p = project(lat, lon, tz);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return {
    x: (p.x - c.x) * scale + canvas.width / (2 * dpr),
    y: (p.y - c.y) * scale + canvas.height / (2 * dpr)
  };
}

function latLonOfScreen(sx, sy) {
  const tz = Math.max(1, Math.min(19, Math.round(view.zoom)));
  const scale = Math.pow(2, view.zoom - tz);
  const c = project(view.lat, view.lon, tz);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wx = (sx - canvas.width / (2 * dpr)) / scale + c.x;
  const wy = (sy - canvas.height / (2 * dpr)) / scale + c.y;
  return unproject(wx, wy, tz);
}

function render() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#DCD9CE';
  ctx.fillRect(0, 0, W, H);

  const tz = Math.max(1, Math.min(TILE_SOURCES[tileSourceKey].maxZoom, Math.round(view.zoom)));
  const scale = Math.pow(2, view.zoom - tz);
  const tileSize = 256 * scale;
  const c = project(view.lat, view.lon, tz);

  const x0 = Math.floor((c.x - (W / 2) / scale) / 256);
  const x1 = Math.floor((c.x + (W / 2) / scale) / 256);
  const y0 = Math.floor((c.y - (H / 2) / scale) / 256);
  const y1 = Math.floor((c.y + (H / 2) / scale) / 256);

  let missing = 0;
  ctx.imageSmoothingEnabled = true;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const maxT = Math.pow(2, tz);
      if (x < 0 || y < 0 || x >= maxT || y >= maxT) continue;
      const sx = (x * 256 - c.x) * scale + W / 2;
      const sy = (y * 256 - c.y) * scale + H / 2;
      const img = getTile(tz, x, y, requestRender);
      if (img) {
        ctx.drawImage(img, sx, sy, tileSize + 1, tileSize + 1);
      } else {
        missing++;
        ctx.fillStyle = '#D3D0C4';
        ctx.fillRect(sx, sy, tileSize + 1, tileSize + 1);
        ctx.strokeStyle = 'rgba(0,0,0,0.05)';
        ctx.strokeRect(sx, sy, tileSize, tileSize);
      }
    }
  }

  const route = state.route;
  if (route) {
    // Casing then core, so the line stays readable over busy topo tiles.
    const drawLine = (from, to, width, colour) => {
      ctx.beginPath();
      ctx.lineWidth = width;
      ctx.strokeStyle = colour;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      let started = false;
      for (const p of route.points) {
        if (p.d < from || p.d > to) { started = false; continue; }
        const s = screenOf(p.lat, p.lon);
        if (!started) { ctx.moveTo(s.x, s.y); started = true; }
        else ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    };

    drawLine(0, route.length, 8, 'rgba(255,255,255,0.85)');
    drawLine(0, route.length, 4.5, '#7A4FCF');
    if (state.progress > 0) drawLine(0, state.progress, 4.5, '#E8590C');

    // Start / finish
    const markEnd = (p, label, fill) => {
      const s = screenOf(p.lat, p.lon);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, s.x, s.y + 0.5);
    };
    markEnd(route.points[0], 'S', '#2E7D32');
    markEnd(route.points[route.points.length - 1], 'F', '#C62828');
  }

  // Milestones — declutter by skipping any marker that would land within
  // ~28px (screen space) of the last one actually drawn.
  if (route && state.layers.milestones && state.milestones.length) {
    let lastX = null, lastY = null;
    for (const m of state.milestones) {
      const s = screenOf(m.lat, m.lon);
      if (s.x < -20 || s.x > W + 20 || s.y < -20 || s.y > H + 20) continue;
      if (lastX !== null && Math.hypot(s.x - lastX, s.y - lastY) < 28) continue;
      lastX = s.x; lastY = s.y;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#1AA6A0';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 8.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.n), s.x, s.y + 0.5);
    }
  }

  // Live position
  if (state.pos) {
    const s = screenOf(state.pos.lat, state.pos.lon);
    if (state.pos.accuracy) {
      const mpp = 156543.03392 * Math.cos(rad(state.pos.lat)) / Math.pow(2, view.zoom);
      const rPx = state.pos.accuracy / mpp;
      if (rPx > 6) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.min(rPx, 400), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(45,120,220,0.14)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(45,120,220,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = state.offRoute ? '#C62828' : '#1F6FEB';
    ctx.fill();
  }

  // Scale bar
  const mpp = 156543.03392 * Math.cos(rad(view.lat)) / Math.pow(2, view.zoom);
  let target = 80 * mpp;
  const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  let chosen = nice[nice.length - 1];
  for (const n of nice) { if (n >= target) { chosen = n; break; } }
  const barPx = chosen / mpp;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(10, H - 26, barPx + 14, 18);
  ctx.strokeStyle = '#1C2321';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(17, H - 13); ctx.lineTo(17 + barPx, H - 13);
  ctx.moveTo(17, H - 17); ctx.lineTo(17, H - 9);
  ctx.moveTo(17 + barPx, H - 17); ctx.lineTo(17 + barPx, H - 9);
  ctx.stroke();
  ctx.fillStyle = '#1C2321';
  ctx.font = '600 10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(chosen >= 1000 ? (chosen / 1000) + ' km' : chosen + ' m', 20, H - 16);

  const badge = document.getElementById('tileBadge');
  if (missing > 0 && !navigator.onLine) {
    badge.textContent = 'No signal · ' + missing + ' tiles not downloaded';
    badge.hidden = false;
  } else if (missing > 0) {
    badge.textContent = 'Loading map…';
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function frame() {
  if (needsRender) { needsRender = false; render(); }
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------- map gestures */

let pointers = new Map();
let lastPinch = null;

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
});

canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) setFollow(false);
    panByPixels(-dx, -dy);
  } else if (pointers.size === 2) {
    const [a, b] = Array.from(pointers.values());
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (lastPinch) {
      const ratio = dist / lastPinch;
      setZoom(view.zoom + Math.log2(ratio));
      setFollow(false);
    }
    lastPinch = dist;
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) lastPinch = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', endPointer);

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  setZoom(view.zoom - e.deltaY * 0.0025);
  setFollow(false);
}, { passive: false });

function panByPixels(dx, dy) {
  const tz = Math.max(1, Math.min(19, Math.round(view.zoom)));
  const scale = Math.pow(2, view.zoom - tz);
  const c = project(view.lat, view.lon, tz);
  const p = unproject(c.x + dx / scale, c.y + dy / scale, tz);
  view.lat = p.lat; view.lon = p.lon;
  requestRender();
}

function setZoom(z) {
  view.zoom = Math.max(3, Math.min(TILE_SOURCES[tileSourceKey].maxZoom, z));
  document.getElementById('zoomLabel').textContent = 'z' + view.zoom.toFixed(1);
  requestRender();
}

function setFollow(on) {
  followMode = on;
  const btn = document.getElementById('followBtn');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '◎ Following' : '◎ Follow me';
}

function fitBounds(bounds) {
  const pad = 60;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.width / dpr - pad * 2, H = canvas.height / dpr - pad * 2;
  let best = 3;
  for (let z = 19; z >= 3; z--) {
    const nw = project(bounds.maxLat, bounds.minLon, z);
    const se = project(bounds.minLat, bounds.maxLon, z);
    if (Math.abs(se.x - nw.x) <= W && Math.abs(se.y - nw.y) <= H) { best = z; break; }
  }
  view.lat = (bounds.minLat + bounds.maxLat) / 2;
  view.lon = (bounds.minLon + bounds.maxLon) / 2;
  setZoom(best);
}

/* ------------------------------------------------------------ app state */

const state = {
  route: null,
  pos: null,
  progress: 0,
  offRoute: false,
  watchId: null,
  startedAt: null,
  movingMs: 0,
  lastFixAt: null,
  lastFixPos: null,
  trackedDistance: 0,
  layers: { milestones: true },
  milestoneUnit: 'km',
  milestones: []
};

function refreshMilestones() {
  state.milestones = state.route ? computeMilestones(state.route, state.milestoneUnit) : [];
}

function saveLayerPrefs() {
  idbPut('meta', { milestones: state.layers.milestones, unit: state.milestoneUnit }, 'layerPrefs');
}

/* --------------------------------------------------------- stats display */

function fmtDist(m) {
  if (!isFinite(m)) return '–';
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}

function fmtDuration(ms) {
  if (!ms || !isFinite(ms)) return '–';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function updateStats() {
  const r = state.route;
  const el = id => document.getElementById(id);

  if (!r) {
    el('statDone').textContent = '–';
    el('statLeft').textContent = '–';
    el('statClimb').textContent = '–';
    el('statEta').textContent = '–';
    el('progressFill').style.width = '0%';
    el('progressPct').textContent = '0%';
    return;
  }

  const pct = Math.max(0, Math.min(100, (state.progress / r.length) * 100));
  el('progressFill').style.width = pct.toFixed(1) + '%';
  el('progressPct').textContent = pct.toFixed(0) + '%';
  el('statDone').textContent = fmtDist(state.progress);
  el('statLeft').textContent = fmtDist(r.length - state.progress);
  el('statClimb').textContent = r.hasEle
    ? Math.round(ascentUpTo(r, state.progress)) + ' / ' + r.ascent + ' m'
    : 'no data';

  // Pace from actual movement if we have enough of it, otherwise Naismith.
  const remaining = r.length - state.progress;
  let secsLeft;
  const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
  if (state.progress > 400 && elapsed > 5 * 60000) {
    const speed = state.progress / (elapsed / 1000); // m/s
    secsLeft = remaining / Math.max(speed, 0.35);
  } else {
    // Naismith: 5 km/h flat, plus 1 minute per 10 m of ascent remaining.
    const climbLeft = r.hasEle ? Math.max(0, r.ascent - ascentUpTo(r, state.progress)) : 0;
    secsLeft = (remaining / 1.389) + (climbLeft / 10) * 60;
  }
  if (remaining < 20) {
    el('statEta').textContent = 'Arrived';
  } else {
    const eta = new Date(Date.now() + secsLeft * 1000);
    el('statEta').textContent = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  el('statElapsed').textContent = state.startedAt ? fmtDuration(elapsed) : '–';
  drawProfile();
}

/* -------------------------------------------------------- elevation strip */

function drawProfile() {
  const svg = document.getElementById('profile');
  const r = state.route;
  if (!r || !r.hasEle) {
    svg.innerHTML = '<text x="50%" y="55%" text-anchor="middle" fill="#8B9490" font-size="11" font-family="ui-monospace, monospace">no elevation data in this route</text>';
    return;
  }

  const W = 600, H = 90, PAD_B = 12, PAD_T = 8;
  const eles = r.points.map(p => p.eleSmooth);
  const minE = Math.min(...eles), maxE = Math.max(...eles);
  const span = Math.max(maxE - minE, 20);
  const xOf = d => (d / r.length) * W;
  const yOf = e => H - PAD_B - ((e - minE) / span) * (H - PAD_B - PAD_T);

  // Downsample for a clean path
  const step = Math.max(1, Math.floor(r.points.length / 400));
  let d = '';
  for (let i = 0; i < r.points.length; i += step) {
    const p = r.points[i];
    d += (d ? ' L ' : 'M ') + xOf(p.d).toFixed(1) + ',' + yOf(p.eleSmooth).toFixed(1);
  }
  const last = r.points[r.points.length - 1];
  d += ' L ' + xOf(last.d).toFixed(1) + ',' + yOf(last.eleSmooth).toFixed(1);

  const fill = d + ` L ${W},${H} L 0,${H} Z`;
  const px = xOf(state.progress);
  const py = yOf(eleAtDistance(r, state.progress));

  svg.innerHTML = `
    <defs>
      <clipPath id="doneClip"><rect x="0" y="0" width="${px}" height="${H}"/></clipPath>
      <linearGradient id="gTodo" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3A4A44"/><stop offset="100%" stop-color="#2A3630"/>
      </linearGradient>
      <linearGradient id="gDone" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#E8590C"/><stop offset="100%" stop-color="#8A3606"/>
      </linearGradient>
    </defs>
    <path d="${fill}" fill="url(#gTodo)"/>
    <path d="${fill}" fill="url(#gDone)" clip-path="url(#doneClip)"/>
    <path d="${d}" fill="none" stroke="#B9C4BE" stroke-width="1.2"/>
    <line x1="${px}" y1="0" x2="${px}" y2="${H}" stroke="#F2F0E6" stroke-width="1" stroke-dasharray="3 3"/>
    <circle cx="${px}" cy="${py}" r="4.5" fill="#F2F0E6" stroke="#1C2321" stroke-width="1.5"/>
    <text x="4" y="12" fill="#8B9490" font-size="9" font-family="ui-monospace, monospace">${Math.round(maxE)}m</text>
    <text x="4" y="${H - 3}" fill="#8B9490" font-size="9" font-family="ui-monospace, monospace">${Math.round(minE)}m</text>
  `;
}

/* --------------------------------------------------------- GPS tracking */

function startTracking() {
  if (!('geolocation' in navigator)) {
    toast('This browser has no GPS support.');
    return;
  }
  if (!window.isSecureContext) {
    toast('GPS needs HTTPS. Open the hosted address, not the local file.');
    return;
  }
  if (state.watchId !== null) return;

  setStatus('acquiring', 'Acquiring GPS…');
  state.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true,
    maximumAge: 3000,
    timeout: 20000
  });
  document.getElementById('trackBtn').textContent = '■ Stop tracking';
  document.getElementById('trackBtn').classList.add('recording');
}

function stopTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  setStatus('idle', 'Tracking stopped');
  document.getElementById('trackBtn').textContent = '● Start tracking';
  document.getElementById('trackBtn').classList.remove('recording');
}

function onFix(p) {
  const { latitude: lat, longitude: lon, accuracy } = p.coords;

  // Ignore obviously bad fixes rather than teleporting the marker.
  if (accuracy > 200 && state.pos) return;

  if (!state.startedAt) state.startedAt = Date.now();

  if (state.lastFixPos) {
    const step = haversine(state.lastFixPos, { lat, lon });
    if (step > 3 && step < 200) state.trackedDistance += step;
  }
  state.lastFixPos = { lat, lon };
  state.lastFixAt = Date.now();
  state.pos = { lat, lon, accuracy };

  if (state.route) {
    const snap = snapToRoute(state.route, lat, lon);
    state.offRoute = snap.offset > 75;
    // Don't let a wild fix drag progress backwards along the line.
    if (!state.offRoute || snap.d > state.progress) state.progress = snap.d;
    setStatus(state.offRoute ? 'warn' : 'ok',
      state.offRoute
        ? `Off route — ${Math.round(snap.offset)} m from the line`
        : `On route · ±${Math.round(accuracy)} m`);
  } else {
    setStatus('ok', `Fix acquired · ±${Math.round(accuracy)} m`);
  }

  const gr = toOSGridRef(lat, lon);
  document.getElementById('gridRef').textContent = gr || (lat.toFixed(5) + ', ' + lon.toFixed(5));
  document.getElementById('coords').textContent = lat.toFixed(5) + ', ' + lon.toFixed(5);

  if (followMode) { view.lat = lat; view.lon = lon; }
  requestRender();
  updateStats();
}

function onFixError(err) {
  const msgs = {
    1: 'Location permission denied. Allow it in your browser settings and try again.',
    2: 'No GPS fix yet — this can take a minute outdoors with a clear sky.',
    3: 'GPS timed out. Still trying.'
  };
  setStatus('warn', msgs[err.code] || err.message);
}

function setStatus(kind, text) {
  const el = document.getElementById('gpsStatus');
  el.textContent = text;
  el.className = 'gps-status ' + kind;
}

/* ------------------------------------------------------------------ UI */

function toast(msg, ms) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms || 4200);
}

function openSheet(id) { document.getElementById(id).classList.add('open'); }
function closeSheet(id) { document.getElementById(id).classList.remove('open'); }

async function refreshRouteList() {
  const routes = await idbGetAll('routes');
  routes.sort((a, b) => b.created - a.created);
  const list = document.getElementById('routeList');
  if (!routes.length) {
    list.innerHTML = '<p class="empty">No routes yet. Import a GPX file to get started — you can export one from OS Maps, Komoot, AllTrails or Strava.</p>';
    return;
  }
  list.innerHTML = '';
  routes.forEach(r => {
    const div = document.createElement('div');
    div.className = 'route-item' + (state.route && state.route.id === r.id ? ' active' : '');
    div.innerHTML = `
      <div class="route-main">
        <div class="route-name"></div>
        <div class="route-meta">${(r.length / 1000).toFixed(1)} km · ${r.ascent} m ascent · ${r.tilesCached ? r.tilesCached + ' tiles offline' : 'not downloaded'}</div>
      </div>
      <button class="mini" data-load="${r.id}">Load</button>
      <button class="mini danger" data-del="${r.id}">✕</button>
    `;
    div.querySelector('.route-name').textContent = r.name;
    list.appendChild(div);
  });

  list.querySelectorAll('[data-load]').forEach(b => {
    b.addEventListener('click', async () => {
      const r = await idbGet('routes', b.dataset.load);
      loadRoute(r);
      closeSheet('routesSheet');
    });
  });
  list.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async () => {
      await idbDelete('routes', b.dataset.del);
      if (state.route && state.route.id === b.dataset.del) { state.route = null; requestRender(); updateStats(); }
      refreshRouteList();
    });
  });
}

function loadRoute(r) {
  if (!r) return;
  // Rebuild derived fields — they don't survive the IndexedDB round trip cleanly.
  state.route = buildRoute(r.name, r.points);
  state.route.id = r.id;
  state.route.tilesCached = r.tilesCached || 0;
  state.route.created = r.created;
  state.progress = 0;
  refreshMilestones();
  document.getElementById('routeTitle').textContent = r.name;
  document.getElementById('routeSub').textContent =
    `${(state.route.length / 1000).toFixed(1)} km · ${state.route.ascent} m ascent`;
  fitBounds(state.route.bounds);
  setFollow(false);
  updateStats();
  requestRender();
  idbPut('meta', r.id, 'lastRoute');
}

async function saveRoute(route) {
  const plain = {
    id: route.id,
    name: route.name,
    points: route.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele })),
    length: route.length,
    ascent: route.ascent,
    descent: route.descent,
    hasEle: route.hasEle,
    bounds: route.bounds,
    created: route.created,
    tilesCached: route.tilesCached || 0
  };
  await idbPut('routes', plain);
}

/* ------------------------------------------------------- offline manager */

let downloadAbort = false;

async function updateStorageReadout() {
  const count = await idbCount('tiles').catch(() => 0);
  let sizeText = '';
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      sizeText = ' · ' + (est.usage / 1048576).toFixed(0) + ' MB used';
    } catch (e) { /* not supported */ }
  }
  document.getElementById('storageInfo').textContent = count + ' map tiles stored' + sizeText;
}

async function runDownload() {
  if (!state.route) { toast('Load a route first.'); return; }

  const detail = document.getElementById('detailLevel').value;
  const zoomSets = {
    light: [12, 13, 14, 15],
    standard: [12, 13, 14, 15, 16],
    fine: [12, 13, 14, 15, 16, 17]
  };
  const corridor = detail === 'fine' ? 700 : detail === 'light' ? 1200 : 900;

  const bar = document.getElementById('dlFill');
  const label = document.getElementById('dlLabel');
  const btn = document.getElementById('downloadBtn');
  downloadAbort = false;
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  document.getElementById('dlProgress').hidden = false;

  const result = await downloadRouteTiles(
    state.route, zoomSets[detail], corridor,
    (done, total, bytes) => {
      bar.style.width = ((done / total) * 100).toFixed(1) + '%';
      label.textContent = `${done} / ${total} tiles · ${(bytes / 1048576).toFixed(1)} MB`;
    },
    () => downloadAbort
  );

  btn.disabled = false;
  btn.textContent = 'Download for offline';

  if (result.capped) {
    toast(`That's ${result.total} tiles — over the ${MAX_DOWNLOAD_TILES} limit. Pick a lower detail level or split the route.`, 7000);
    document.getElementById('dlProgress').hidden = true;
    return;
  }

  state.route.tilesCached = result.saved;
  await saveRoute(state.route);
  await updateStorageReadout();
  label.textContent = `Done — ${result.saved} tiles saved${result.failed ? `, ${result.failed} failed` : ''}`;
  toast('Offline map ready. Try it in aeroplane mode before you set off.', 6000);
  refreshRouteList();
}

/* --------------------------------------------------------------- wiring */

document.getElementById('gpxInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const route = parseGPX(text, file.name.replace(/\.gpx$/i, ''));
    await saveRoute(route);
    loadRoute(route);
    closeSheet('routesSheet');
    toast(`Loaded "${route.name}" — ${(route.length / 1000).toFixed(1)} km. Download the map next.`, 6000);
    refreshRouteList();
  } catch (err) {
    toast(err.message || 'Could not read that file.');
  }
  e.target.value = '';
});

document.getElementById('trackBtn').addEventListener('click', () => {
  if (state.watchId === null) startTracking(); else stopTracking();
});
document.getElementById('followBtn').addEventListener('click', () => {
  setFollow(!followMode);
  if (followMode && state.pos) { view.lat = state.pos.lat; view.lon = state.pos.lon; requestRender(); }
});
document.getElementById('routesBtn').addEventListener('click', () => { refreshRouteList(); openSheet('routesSheet'); });
document.getElementById('offlineBtn').addEventListener('click', () => { updateStorageReadout(); openSheet('offlineSheet'); });
document.getElementById('layersBtn').addEventListener('click', () => { openSheet('layersSheet'); });
document.getElementById('downloadBtn').addEventListener('click', runDownload);
document.getElementById('zoomIn').addEventListener('click', () => { setZoom(view.zoom + 1); });
document.getElementById('zoomOut').addEventListener('click', () => { setZoom(view.zoom - 1); });
document.getElementById('fitBtn').addEventListener('click', () => {
  if (state.route) { fitBounds(state.route.bounds); setFollow(false); }
});

document.getElementById('layerBtn').addEventListener('click', () => {
  tileSourceKey = tileSourceKey === 'topo' ? 'osm' : 'topo';
  document.getElementById('layerBtn').textContent = TILE_SOURCES[tileSourceKey].name === 'OpenTopoMap' ? '▦ Topo' : '▦ Street';
  document.getElementById('attribution').textContent = TILE_SOURCES[tileSourceKey].attribution;
  setZoom(Math.min(view.zoom, TILE_SOURCES[tileSourceKey].maxZoom));
  requestRender();
});

document.getElementById('clearTilesBtn').addEventListener('click', async () => {
  if (!confirm('Delete every downloaded map tile? Your routes are kept.')) return;
  await idbClear('tiles');
  memTiles.clear();
  const routes = await idbGetAll('routes');
  for (const r of routes) { r.tilesCached = 0; await idbPut('routes', r); }
  await updateStorageReadout();
  requestRender();
  toast('Offline tiles cleared.');
});

document.getElementById('layerMilestones').addEventListener('change', e => {
  state.layers.milestones = e.target.checked;
  saveLayerPrefs();
  requestRender();
});

document.getElementById('milestoneUnitBtn').addEventListener('click', () => {
  state.milestoneUnit = state.milestoneUnit === 'km' ? 'mi' : 'km';
  document.getElementById('milestoneUnitBtn').textContent = state.milestoneUnit === 'km' ? '1 km' : '1 mi';
  refreshMilestones();
  saveLayerPrefs();
  requestRender();
});

document.querySelectorAll('[data-close]').forEach(b => {
  b.addEventListener('click', () => closeSheet(b.dataset.close));
});

// Tapping the elevation strip sets progress manually — the fallback when
// GPS is unavailable or you just want to check what's ahead.
document.getElementById('profile').addEventListener('click', e => {
  if (!state.route) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  state.progress = Math.max(0, Math.min(1, frac)) * state.route.length;
  if (!state.startedAt) state.startedAt = Date.now();
  updateStats();
  requestRender();
});

window.addEventListener('resize', sizeCanvas);
window.addEventListener('online', () => { requestRender(); });
window.addEventListener('offline', () => { requestRender(); });

setInterval(() => { if (state.startedAt) updateStats(); }, 15000);

/* ------------------------------------------------------------- start up */

async function init() {
  sizeCanvas();
  setFollow(false);
  frame();
  document.getElementById('attribution').textContent = TILE_SOURCES[tileSourceKey].attribution;

  if (!window.isSecureContext) {
    document.getElementById('insecureWarning').hidden = false;
  }

  try {
    const prefs = await idbGet('meta', 'layerPrefs');
    if (prefs) {
      state.layers.milestones = prefs.milestones !== false;
      state.milestoneUnit = prefs.unit === 'mi' ? 'mi' : 'km';
      document.getElementById('layerMilestones').checked = state.layers.milestones;
      document.getElementById('milestoneUnitBtn').textContent = state.milestoneUnit === 'km' ? '1 km' : '1 mi';
    }
  } catch (e) { /* first run */ }

  try {
    const lastId = await idbGet('meta', 'lastRoute');
    if (lastId) {
      const r = await idbGet('routes', lastId);
      if (r) loadRoute(r);
    }
  } catch (e) { /* first run */ }

  if (!state.route) {
    view.lat = 50.7648; view.lon = 0.1081; setZoom(12);
  }

  // Ask the browser not to evict our offline maps when storage gets tight.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  updateStats();
  refreshRouteList();
}

init();
