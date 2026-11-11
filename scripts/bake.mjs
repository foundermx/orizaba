// Bakes real terrain (AWS Terrain Tiles) + OpenStreetMap data into public/data/.
// Run once: `pnpm bake`. Network responses are cached in scripts/.cache (delete it to refresh).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { POIS, ROUTES } from '../src/pois.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(import.meta.dirname, '.cache');
const OUT = path.join(ROOT, 'public/data');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// Board extent: Cerro del Borrego (W) → 500 Escalones (E), Aeroparque (N) → BIORI (S).
const BBOX = { s: 18.828, w: -97.131, n: 18.874, e: -97.058 };
const LAT0 = (BBOX.s + BBOX.n) / 2, LON0 = (BBOX.w + BBOX.e) / 2;
const MX = Math.cos((LAT0 * Math.PI) / 180) * 111320; // m per degree lon
const MZ = 110574; // m per degree lat
// local metres: x → east, z → south (three.js: north = -z)
const toXZ = (lat, lon) => [(lon - LON0) * MX, -(lat - LAT0) * MZ];
const WIDTH = (BBOX.e - BBOX.w) * MX, DEPTH = (BBOX.n - BBOX.s) * MZ;
const STEP = 12; // m per DEM sample
const NX = Math.round(WIDTH / STEP) + 1, NZ = Math.round(DEPTH / STEP) + 1;

let seed = 7;
const rand = () => ((seed = (seed + 0x6d2b79f5) | 0), (((seed ^ (seed >>> 15)) * (1 | seed)) >>> 0) / 4294967296);
const rnd = (a, b) => a + rand() * (b - a);
const r1 = (v) => Math.round(v * 10) / 10;

async function cached(name, fetcher) {
  const f = path.join(CACHE, name);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const buf = await fetcher();
  fs.writeFileSync(f, buf);
  return buf;
}

// ---------- DEM ----------
const Z = 14;
const lonToPx = (lon) => ((lon + 180) / 360) * 256 * 2 ** Z;
const latToPx = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** Z;
};
const tiles = new Map();
async function loadTile(tx, ty) {
  const key = `${tx}_${ty}`;
  const buf = await cached(`dem_${Z}_${key}.png`, async () => {
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`);
    if (!r.ok) throw new Error(`DEM ${key}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  });
  const d = PNG.sync.read(buf).data, h = new Float32Array(256 * 256);
  for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  tiles.set(key, h);
}
for (let ty = Math.floor(latToPx(BBOX.n) / 256); ty <= Math.floor(latToPx(BBOX.s) / 256) + 1; ty++)
  for (let tx = Math.floor(lonToPx(BBOX.w) / 256); tx <= Math.floor(lonToPx(BBOX.e) / 256) + 1; tx++) await loadTile(tx, ty);
const demPx = (gx, gy) => tiles.get(`${Math.floor(gx / 256)}_${Math.floor(gy / 256)}`)[(gy % 256) * 256 + (gx % 256)];
const heights = new Float32Array(NX * NZ);
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const x = -WIDTH / 2 + i * STEP, z = -DEPTH / 2 + j * STEP;
    const fx = lonToPx(LON0 + x / MX) - 0.5, fy = latToPx(LAT0 - z / MZ) - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    heights[j * NX + i] =
      demPx(x0, y0) * (1 - ax) * (1 - ay) + demPx(x0 + 1, y0) * ax * (1 - ay) +
      demPx(x0, y0 + 1) * (1 - ax) * ay + demPx(x0 + 1, y0 + 1) * ax * ay;
  }
let hmin = Infinity, hmax = -Infinity;
for (const h of heights) { hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
const hAt = (x, z) => {
  const fi = Math.min(NX - 1.001, Math.max(0, (x + WIDTH / 2) / STEP)), fj = Math.min(NZ - 1.001, Math.max(0, (z + DEPTH / 2) / STEP));
  const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, k = j * NX + i;
  return heights[k] * (1 - a) * (1 - b) + heights[k + 1] * a * (1 - b) + heights[k + NX] * (1 - a) * b + heights[k + NX + 1] * a * b;
};
const slopeAt = (x, z) => Math.hypot(hAt(x + STEP, z) - hAt(x - STEP, z), hAt(x, z + STEP) - hAt(x, z - STEP)) / (2 * STEP);
console.log(`terrain ${NX}×${NZ} @${STEP} m · ${WIDTH.toFixed(0)}×${DEPTH.toFixed(0)} m · ${hmin.toFixed(0)}–${hmax.toFixed(0)} m`);

// ---------- OSM ----------
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
async function overpass(name, query) {
  const buf = await cached(name, async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ep = ENDPOINTS[attempt % ENDPOINTS.length];
      try {
        const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'orizaba-map-prototype/0.1' }, signal: AbortSignal.timeout(240000) });
        if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); JSON.parse(b); return b; }
        console.warn(`overpass ${ep}: HTTP ${r.status}`);
      } catch (e) { console.warn(`overpass ${ep}: ${e.message}`); }
      await new Promise((res) => setTimeout(res, 8000));
    }
    throw new Error('Overpass failed');
  });
  return JSON.parse(buf);
}
const bb = `${BBOX.s - 0.002},${BBOX.w - 0.002},${BBOX.n + 0.002},${BBOX.e + 0.002}`;
const streets = await overpass('streets.json', `[out:json][timeout:200];way["highway"](${bb});out body;>;out skel qt;`);
const features = await overpass('features.json', `[out:json][timeout:200];(
  way["building"](${bb});relation["building"](${bb});
  way["landuse"](${bb});relation["landuse"](${bb});
  way["leisure"](${bb});relation["leisure"](${bb});
  way["natural"](${bb});relation["natural"](${bb});
  way["waterway"](${bb});way["railway"](${bb});way["aerialway"](${bb});
  way["amenity"~"school|university|college|hospital|parking"](${bb});
);out geom;`);

const geomXZ = (g) => g.flatMap((p) => toXZ(p.lat, p.lon));
const rings = (el) => (el.type === 'way' ? (el.geometry ? [geomXZ(el.geometry)] : [])
  : (el.members || []).filter((m) => m.role === 'outer' && m.geometry).map((m) => geomXZ(m.geometry)));

// area kinds: 0 urban 1 park 2 forest 3 farm 4 water 5 pitch 6 cemetery
function areaKind(t) {
  if (t.natural === 'water' || ['reservoir', 'basin'].includes(t.landuse) || t.leisure === 'swimming_pool') return 4;
  if (['wood', 'scrub'].includes(t.natural) || t.landuse === 'forest') return 2;
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 6;
  if (['pitch', 'stadium', 'track', 'sports_centre'].includes(t.leisure)) return 5;
  if (['park', 'garden', 'playground', 'recreation_ground', 'nature_reserve', 'dog_park'].includes(t.leisure) || ['grass', 'recreation_ground', 'village_green', 'meadow'].includes(t.landuse) || t.natural === 'grassland') return 1;
  if (['farmland', 'orchard', 'farmyard', 'plant_nursery', 'greenhouse_horticulture'].includes(t.landuse)) return 3;
  if (t.landuse || t.amenity) return 0;
  return -1;
}
const areas = [], waterLines = [], rails = [], osmBuildings = [];
let aerial = null;
for (const el of features.elements) {
  const t = el.tags || {};
  if (t.building && !t.amenity?.match?.(/parking/)) {
    for (const r of rings(el)) osmBuildings.push({ ring: r, t });
    continue;
  }
  if (t.waterway && el.geometry) {
    const w = { river: 16, canal: 6, stream: 5, drain: 2.5, ditch: 2 }[t.waterway];
    if (w) waterLines.push([w, ...geomXZ(el.geometry).map(r1)]);
    continue;
  }
  if (t.railway === 'rail' && el.geometry) { rails.push(geomXZ(el.geometry).map(r1)); continue; }
  if (t.aerialway && el.geometry && t.aerialway !== 'station') { aerial = geomXZ(el.geometry).map(r1); continue; }
  const k = areaKind(t);
  if (k >= 0) for (const r of rings(el)) if (r.length >= 6) areas.push([k, ...r.map(r1)]);
}

// ---------- roads ----------
// classes: 0 major 1 secondary 2 tertiary 3 residential 4 service 5 path 6 steps
const ROAD = { motorway: 0, trunk: 0, primary: 0, motorway_link: 0, trunk_link: 0, primary_link: 0, secondary: 1, secondary_link: 1, tertiary: 2, tertiary_link: 2, residential: 3, unclassified: 3, living_street: 3, road: 3, service: 4, pedestrian: 5, footway: 5, path: 5, cycleway: 5, track: 5, bridleway: 5, steps: 6, corridor: 5 };
const ROAD_W = [16, 13, 11, 8.5, 5, 3, 3];
const nodes = new Map();
for (const el of streets.elements) if (el.type === 'node') nodes.set(el.id, toXZ(el.lat, el.lon));
const ways = streets.elements.filter((e) => e.type === 'way' && ROAD[e.tags.highway] !== undefined);
const roads = ways.map((w) => [ROAD[w.tags.highway], ...w.nodes.flatMap((id) => nodes.get(id)).map(r1)]);

// ---------- occupancy grid (2 m) ----------
const CELL = 2, GW = Math.ceil(WIDTH / CELL), GH = Math.ceil(DEPTH / CELL);
const grid = new Uint8Array(GW * GH); // 0 free 1 road 2 building 3 water 4 park 5 forest 6 other 7 farm
const URB = 8, UW = Math.ceil(WIDTH / URB), UH = Math.ceil(DEPTH / URB);
const urban = new Uint8Array(UW * UH); // 1 = within reach of a street
function fillRing(g, w, h, cell, ring, val) {
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 1; i < ring.length; i += 2) { zmin = Math.min(zmin, ring[i]); zmax = Math.max(zmax, ring[i]); }
  const r0 = Math.max(0, Math.floor((zmin + DEPTH / 2) / cell)), r1_ = Math.min(h - 1, Math.ceil((zmax + DEPTH / 2) / cell));
  const n = ring.length / 2;
  for (let r = r0; r <= r1_; r++) {
    const zc = -DEPTH / 2 + (r + 0.5) * cell, xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const zi = ring[i * 2 + 1], zj = ring[j * 2 + 1];
      if ((zi > zc) !== (zj > zc)) xs.push(ring[i * 2] + ((zc - zi) / (zj - zi)) * (ring[j * 2] - ring[i * 2]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.round((xs[k] + WIDTH / 2) / cell)), c1 = Math.min(w - 1, Math.round((xs[k + 1] + WIDTH / 2) / cell) - 1);
      for (let c = c0; c <= c1; c++) g[r * w + c] = val;
    }
  }
}
function strokeLine(g, w, h, cell, pts, width, val) {
  const rad = width / 2, rc = Math.ceil(rad / cell);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [x0, z0, x1, z1] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / (cell * 0.7)));
    for (let s = 0; s <= n; s++) {
      const cx = Math.floor((x0 + ((x1 - x0) * s) / n + WIDTH / 2) / cell), cz = Math.floor((z0 + ((z1 - z0) * s) / n + DEPTH / 2) / cell);
      for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) {
        if ((dx * dx + dz * dz) * cell * cell > rad * rad + cell) continue;
        const X = cx + dx, Zc = cz + dz;
        if (X >= 0 && Zc >= 0 && X < w && Zc < h) g[Zc * w + X] = val;
      }
    }
  }
}
const GRID = [grid, GW, GH, CELL];
const ORDER = { 3: 7, 2: 5, 1: 4, 5: 6, 6: 6, 4: 3 }; // area kind → grid value (urban stays free)
for (const k of [3, 2, 1, 5, 6, 4]) for (const a of areas) if (a[0] === k) fillRing(...GRID, a.slice(1), ORDER[k]);
for (const wl of waterLines) strokeLine(...GRID, wl.slice(1), wl[0] + 4, 3);
for (const r of rails) strokeLine(...GRID, r, 7, 1);
for (const r of roads) {
  strokeLine(...GRID, r.slice(1), ROAD_W[r[0]] + 2, 1);
  if (r[0] <= 4) strokeLine(urban, UW, UH, URB, r.slice(1), 130, 1);
}
for (const b of osmBuildings) fillRing(...GRID, b.ring, 2);

// ---------- buildings ----------
const LEVELS = () => { const p = rand(); return p < 0.42 ? 1 : p < 0.82 ? 2 : p < 0.96 ? 3 : 4; };
const [cxCenter, czCenter] = toXZ(18.8488, -97.1049); // Parque Castillo
const buildings = [];
for (const { ring, t } of osmBuildings) {
  let cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cz += ring[i + 1]; }
  cx /= ring.length / 2; cz /= ring.length / 2;
  if (Math.abs(cx) > WIDTH / 2 - 8 || Math.abs(cz) > DEPTH / 2 - 8) continue;
  const church = /church|cathedral|chapel/.test(t.building) || t.amenity === 'place_of_worship';
  const lv = parseFloat(t['building:levels']) || (t.height ? parseFloat(t.height) / 3.2 : 0) || (church ? 4 : LEVELS());
  const pts = ring.length > 4 && ring[0] === ring.at(-2) && ring[1] === ring.at(-1) ? ring.slice(0, -2) : ring;
  buildings.push([Math.min(lv, 12), church ? 1 : 0, ...pts.map(r1)]);
}
const nOsm = buildings.length, rects = [];
function rectFree(cx, cz, w, d, ux, uz) {
  for (let a = -w / 2; a <= w / 2; a += 1.4) for (let b = -d / 2; b <= d / 2; b += 1.4) {
    const x = cx + ux * a - uz * b, z = cz + uz * a + ux * b;
    const X = Math.floor((x + WIDTH / 2) / CELL), Zc = Math.floor((z + DEPTH / 2) / CELL);
    if (X < 4 || Zc < 4 || X >= GW - 4 || Zc >= GH - 4 || grid[Zc * GW + X] !== 0) return false;
  }
  return true;
}
const rectRing = (cx, cz, w, d, ux, uz) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([a, b]) => [cx + (ux * a * w) / 2 - (uz * b * d) / 2, cz + (uz * a * w) / 2 + (ux * b * d) / 2]);
for (const r of roads) {
  const cls = r[0];
  if (cls > 4) continue;
  const half = ROAD_W[cls] / 2 + 3.2; // clear of the road mask (2 m cells + brush slack)
  for (let i = 1; i + 3 < r.length; i += 2) {
    const x0 = r[i], z0 = r[i + 1], dx = r[i + 2] - x0, dz = r[i + 3] - z0, L = Math.hypot(dx, dz);
    if (L < 9) continue;
    const ux = dx / L, uz = dz / L;
    for (const side of [-1, 1]) {
      let t = rnd(0, 3);
      while (t < L - 5) {
        const w = rnd(7, 13), d = rnd(10, cls <= 1 ? 24 : 20);
        let off = half;
        for (const depth of [d, rnd(8, 16), rnd(8, 14)]) {
          const o = off + depth / 2, cx = x0 + ux * (t + w / 2) - uz * side * o, cz = z0 + uz * (t + w / 2) + ux * side * o;
          if (slopeAt(cx, cz) > 0.33 || !rectFree(cx, cz, w + 1, depth + 1, ux, uz)) break;
          fillRing(...GRID, rectRing(cx, cz, w + 1.2, depth + 1.2, ux, uz), 2);
          const lv = Math.max(1, LEVELS() - (off > half ? 1 : 0)) + (Math.hypot(cx - cxCenter, cz - czCenter) < 800 && rand() < 0.4 ? 1 : 0);
          rects.push(cx, cz, Math.atan2(uz, ux), w, depth, lv);
          off += depth + rnd(1, 4);
          if (rand() < 0.35) break;
        }
        t += w + (rand() < 0.1 ? rnd(4, 10) : 0.4);
      }
    }
  }
}
console.log(`buildings: ${nOsm} OSM + ${rects.length / 6} procedural`);

// ---------- trees: one byte per 13 m cell (0 none, else 1 + type*8 + height bucket) ----------
// position jitter is a hash of the cell (same function in src/world.js), so only presence/type/size is stored
const cellHash = (i, j, k) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const TREE = { step: 13, x0: -WIDTH / 2 + 10, z0: -DEPTH / 2 + 10 };
TREE.nx = Math.floor((WIDTH - 20) / TREE.step); TREE.nz = Math.floor((DEPTH - 20) / TREE.step);
const treeGrid = new Uint8Array(TREE.nx * TREE.nz);
let treeCount = 0;
for (let j = 0; j < TREE.nz; j++)
  for (let i = 0; i < TREE.nx; i++) {
    const px = TREE.x0 + i * TREE.step + (cellHash(i, j, 1) - 0.5) * 10, pz = TREE.z0 + j * TREE.step + (cellHash(i, j, 2) - 0.5) * 10;
    const g = grid[Math.floor((pz + DEPTH / 2) / CELL) * GW + Math.floor((px + WIDTH / 2) / CELL)];
    const near = urban[Math.floor((pz + DEPTH / 2) / URB) * UW + Math.floor((px + WIDTH / 2) / URB)];
    const sl = slopeAt(px, pz), h = hAt(px, pz);
    let p, type = 1;
    if (g === 5) { p = 0.85; type = rand() < 0.55 ? 0 : 1; }
    else if (g === 4) p = 0.32;
    else if (g === 7) p = 0.03;
    else if (g !== 0) p = 0;
    else if (near && sl < 0.3) p = 0.025;
    else { p = Math.min(0.9, 0.2 + sl * 2 + Math.max(0, h - 1300) / 250); type = rand() < 0.5 ? 0 : 1; }
    if (rand() < p) { treeGrid[j * TREE.nx + i] = 1 + type * 8 + Math.floor(rand() * 8); treeCount++; }
  }
console.log(`trees: ${treeCount}`);

// ---------- walking routes ----------
const ids = [...nodes.keys()], index = new Map(ids.map((id, i) => [id, i]));
const adj = ids.map(() => []);
const COST = { 0: 1.2, 1: 1.15, 5: 0.95, 6: 1.1 };
for (const w of ways) {
  const cls = ROAD[w.tags.highway];
  if (w.tags.highway.startsWith('motorway')) continue;
  for (let i = 0; i + 1 < w.nodes.length; i++) {
    const a = index.get(w.nodes[i]), b = index.get(w.nodes[i + 1]);
    const [ax, az] = nodes.get(w.nodes[i]), [bx, bz] = nodes.get(w.nodes[i + 1]);
    const c = Math.hypot(bx - ax, bz - az) * (COST[cls] ?? 1);
    adj[a].push(b, c); adj[b].push(a, c);
  }
}
const comp = new Int32Array(ids.length).fill(-1);
let best = 0, bestSize = 0;
for (let s = 0, cid = 0; s < ids.length; s++) {
  if (comp[s] >= 0 || !adj[s].length) continue;
  const stack = [s]; comp[s] = cid; let size = 0;
  while (stack.length) { const u = stack.pop(); size++; for (let k = 0; k < adj[u].length; k += 2) if (comp[adj[u][k]] < 0) { comp[adj[u][k]] = cid; stack.push(adj[u][k]); } }
  if (size > bestSize) { bestSize = size; best = cid; }
  cid++;
}
function nearestNode(x, z) {
  let bi = -1, bd = Infinity;
  for (let i = 0; i < ids.length; i++) {
    if (comp[i] !== best) continue;
    const [nx, nz] = nodes.get(ids[i]), d = (nx - x) ** 2 + (nz - z) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}
function dijkstra(src, dst) {
  const dist = new Float64Array(ids.length).fill(Infinity), prev = new Int32Array(ids.length).fill(-1);
  const heap = [[0, src]]; dist[src] = 0;
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop();
    if (u === dst) break;
    if (d > dist[u]) continue;
    for (let k = 0; k < adj[u].length; k += 2) { const v = adj[u][k], nd = d + adj[u][k + 1]; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); } }
  }
  const path = [];
  for (let u = dst; u >= 0; u = prev[u]) path.unshift(u);
  return path[0] === src ? path : null;
}
const poiById = new Map(POIS.map((p) => [p.id, p]));
const routes = {};
for (const r of ROUTES) {
  const coords = [], legs = [];
  let walk = 0, cable = 0;
  const add = (x, z) => { const n = coords.length; if (n) { const d = Math.hypot(x - coords[n - 2], z - coords[n - 1]); if (d < 0.5) return 0; coords.push(r1(x), r1(z)); return d; } coords.push(r1(x), r1(z)); return 0; };
  r.stops.forEach((stop, i) => {
    const byCable = stop.startsWith('~'), p = poiById.get(stop.replace('~', ''));
    if (!p) throw new Error(`route ${r.id}: unknown stop ${stop}`);
    const [x, z] = toXZ(p.lat, p.lon);
    if (i === 0) { add(x, z); legs.push(0); return; }
    if (byCable) { cable += add(x, z); legs.push(coords.length / 2 - 1); return; }
    const prevStop = poiById.get(r.stops[i - 1].replace('~', ''));
    const path = dijkstra(nearestNode(...toXZ(prevStop.lat, prevStop.lon)), nearestNode(x, z));
    if (!path) throw new Error(`route ${r.id}: no path to ${stop}`);
    for (const u of path) walk += add(...nodes.get(ids[u]));
    walk += add(x, z);
    legs.push(coords.length / 2 - 1);
  });
  routes[r.id] = { coords, legs, walk: Math.round(walk), cable: Math.round(cable) };
  console.log(`route ${r.id}: ${(walk / 1000).toFixed(2)} km a pie${cable ? ` + ${cable.toFixed(0)} m teleférico` : ''}`);
}

// ---------- walking graph for in-app directions (lazy-loaded by the page) ----------
const gIndex = new Int32Array(ids.length).fill(-1), gNodes = [], gEdges = [], names = [''], nameIdx = new Map([['', 0]]);
ids.forEach((id, i) => { if (comp[i] === best) { gIndex[i] = gNodes.length / 2; gNodes.push(...nodes.get(id).map(Math.round)); } });
for (const w of ways) {
  if (w.tags.highway.startsWith('motorway')) continue;
  const label = w.tags.name || '';
  if (!nameIdx.has(label)) { nameIdx.set(label, names.length); names.push(label); }
  for (let i = 0; i + 1 < w.nodes.length; i++) {
    const a = gIndex[index.get(w.nodes[i])], b = gIndex[index.get(w.nodes[i + 1])];
    if (a >= 0 && b >= 0) gEdges.push(a, b, nameIdx.get(label), ROAD[w.tags.highway]);
  }
}
fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify({ nodes: gNodes, edges: gEdges, names }));
console.log(`graph: ${gNodes.length / 2} nodes, ${gEdges.length / 4} edges, ${(fs.statSync(path.join(OUT, 'graph.json')).size / 1e6).toFixed(2)} MB`);

// ---------- write ----------
// terrain.bin: int16 decimetres, first column absolute, then deltas along each row
const t16 = new Int16Array(heights.length);
for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
  const k = j * NX + i, v = Math.round(heights[k] * 10);
  t16[k] = i ? v - Math.round(heights[k - 1] * 10) : v;
}
fs.writeFileSync(path.join(OUT, 'terrain.bin'), Buffer.from(t16.buffer));
// city.bin (little-endian): houses 9 B each [cx,cz int16 ×0.5 m][angle uint16 2π/65536][w,d uint8 ×0.1 m][levels uint8]
// then OSM footprints [levels|church<<7 uint8][n uint16][n × (x,z int16 ×0.5 m)], then the tree grid
const nRect = rects.length / 6, polyBytes = buildings.reduce((a, b) => a + 3 + (b.length - 2) * 2, 0);
const city = Buffer.alloc(nRect * 9 + polyBytes + treeGrid.length);
let o = 0;
for (let k = 0; k < rects.length; k += 6) {
  const [cx, cz, ang, w, d, lv] = rects.slice(k, k + 6);
  city.writeInt16LE(Math.round(cx * 2), o); city.writeInt16LE(Math.round(cz * 2), o + 2);
  city.writeUInt16LE(Math.round((((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 65535), o + 4);
  city.writeUInt8(Math.round(w * 10), o + 6); city.writeUInt8(Math.round(d * 10), o + 7); city.writeUInt8(lv, o + 8);
  o += 9;
}
for (const b of buildings) {
  city.writeUInt8(Math.min(127, Math.round(b[0])) | (b[1] ? 128 : 0), o); city.writeUInt16LE((b.length - 2) / 2, o + 1); o += 3;
  for (let i = 2; i < b.length; i++, o += 2) city.writeInt16LE(Math.round(b[i] * 2), o);
}
city.set(treeGrid, o);
fs.writeFileSync(path.join(OUT, 'city.bin'), city);
const clip = (arr) => arr.filter((a) => a.some((v, i) => i > 0 && i % 2 === 1 && Math.abs(v) < WIDTH / 2 + 50));
const int = (a) => a.map(Math.round);
const map = {
  meta: { lat0: LAT0, lon0: LON0, mx: MX, mz: MZ, width: WIDTH, depth: DEPTH, nx: NX, nz: NZ, step: STEP, hmin, hmax,
    city: { rects: nRect, polys: buildings.length, polyBytes, tree: TREE } },
  roads: clip(roads).map(int), areas: areas.map(int), water: water(), rails: rails.map(int), aerial, routes,
};
function water() { return waterLines.map((w) => [w[0], ...w.slice(1).map(Math.round)]); }
fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(map));
for (const f of ['map.json', 'terrain.bin', 'city.bin', 'graph.json']) console.log(`${f} ${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2)} MB`);
