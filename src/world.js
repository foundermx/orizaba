// The diorama: real terrain cut as a block, painted streets, extruded city, instanced trees,
// animated teleférico and route lines. Metres throughout (x east, z south, y up).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const EXAG = 1.7; // terrain vertical exaggeration
const LEVEL = 3.2 * 2.2; // metres per building level (exaggerated so the city reads from above)
const TREE = 1.35; // tree size exaggeration
const SKIRT = 70; // soil cut below the lowest point

// Quality tiers, picked once per device; the frame loop then adapts resolution and tree density on top.
// Force one with ?calidad=alta|media|baja (handy for demos on a projector or an old phone).
const QUALITY = {
  alta: { dpr: 2, div: 1, tex: 4096, shadow: 4096, trees: 1, tanks: true, pbr: true },
  media: { dpr: 1.5, div: 2, tex: 2048, shadow: 2048, trees: 0.55, tanks: true, pbr: true },
  baja: { dpr: 1, div: 3, tex: 2048, shadow: 0, trees: 0.3, tanks: false, pbr: false },
};
function pickTier(gpu) {
  const forced = new URLSearchParams(location.search).get('calidad');
  if (QUALITY[forced]) return forced;
  if (/swiftshader|llvmpipe|software/i.test(gpu)) return 'baja';
  if ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3) return 'baja';
  return matchMedia('(pointer: coarse)').matches ? 'media' : 'alta';
}

const ease = (t) => 1 - (1 - t) ** 3;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// keep in sync with scripts/bake.mjs (tree positions are rebuilt from it)
const cellHash = (i, j, k) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const nextTask = () => new Promise((r) => setTimeout(r, 0)); // let input and paint through between heavy steps

export async function createWorld(canvas, { reduceMotion, onProgress }) {
  onProgress('Cargando relieve y calles…');
  const [map, tBuf, cBuf] = await Promise.all([
    fetch('data/map.json').then((r) => r.json()),
    fetch('data/terrain.bin').then((r) => r.arrayBuffer()),
    fetch('data/city.bin').then((r) => r.arrayBuffer()),
  ]);
  const M = map.meta, W = M.width, D = M.depth, H = new Int16Array(tBuf);
  for (let j = 0; j < M.nz; j++) for (let k = j * M.nx + 1, e = (j + 1) * M.nx; k < e; k++) H[k] += H[k - 1]; // row deltas → decimetres
  const hAt = (x, z) => {
    const fi = clamp((x + W / 2) / M.step, 0, M.nx - 1.001), fj = clamp((z + D / 2) / M.step, 0, M.nz - 1.001);
    const i = fi | 0, j = fj | 0, a = fi - i, b = fj - j, k = j * M.nx + i;
    return (H[k] * (1 - a) * (1 - b) + H[k + 1] * a * (1 - b) + H[k + M.nx] * (1 - a) * b + H[k + M.nx + 1] * a * b) / 10;
  };
  const yAt = (x, z) => (hAt(x, z) - M.hmin) * EXAG;
  const toXZ = (lat, lon) => [(lon - M.lon0) * M.mx, -(lat - M.lat0) * M.mz];

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  const gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const tier = pickTier(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ''), Q = QUALITY[tier];
  let dpr = Math.min(devicePixelRatio, Q.dpr);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  if (Q.shadow) Object.assign(renderer.shadowMap, { enabled: true, type: THREE.PCFShadowMap, autoUpdate: false }); // static scene: bake once
  const scene = new THREE.Scene();
  if (Q.pbr) {
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;
  }
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.7);
  sun.position.set(-5200, 6400, 3400);
  if (Q.shadow) {
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(Q.shadow);
    Object.assign(sun.shadow.camera, { left: -5400, right: 5400, top: 4200, bottom: -4200, near: 100, far: 20000 });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 2;
  }
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xe4eef8, 0x5a6236, Q.pbr ? 1.2 : 1.45));
  const lambert = (o) => new THREE.MeshLambertMaterial(o); // cheap shading for everything but the terrain
  let needs = true; // a frame is owed (on-demand rendering)
  function requestRender() { needs = true; }

  const camera = new THREE.PerspectiveCamera(30, 1, 20, 80000);
  const controls = new OrbitControls(camera, canvas);
  // map-style gestures: drag/one finger moves the map; right button, Ctrl+drag or two fingers rotate; wheel/pinch zooms
  Object.assign(controls, {
    enableDamping: true, dampingFactor: 0.12, minDistance: 260, maxDistance: 17000, maxPolarAngle: 1.22, minPolarAngle: 0.1,
    zoomToCursor: true, screenSpacePanning: false, rotateSpeed: 0.6,
    mouseButtons: { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE },
    touches: { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE },
  });
  const cityY = yAt(...toXZ(18.8488, -97.1049));

  // ---------- terrain ----------
  onProgress('Pintando calles y ríos…');
  await nextTask();
  const tgeo = terrainGeometry(Q.div);
  const ground = paintGround();
  ground.color.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const terrain = new THREE.Mesh(tgeo, Q.pbr
    ? new THREE.MeshStandardMaterial({ map: ground.color, roughnessMap: ground.rough, roughness: 1, metalness: 0 })
    : lambert({ map: ground.color }));
  terrain.receiveShadow = terrain.castShadow = true;
  scene.add(terrain, makeSkirt(), ...makePlinth());

  function terrainGeometry(div) { // every div-th DEM sample; normals from central differences
    const cols = Math.floor((M.nx - 1) / div) + 1, rows = Math.floor((M.nz - 1) / div) + 1, n = cols * rows;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    const Y = (i, j) => (H[Math.min(M.nz - 1, Math.max(0, j)) * M.nx + Math.min(M.nx - 1, Math.max(0, i))] / 10 - M.hmin) * EXAG;
    for (let r = 0, v = 0; r < rows; r++)
      for (let c = 0; c < cols; c++, v++) {
        const i = c * div, j = r * div, x = -W / 2 + (i / (M.nx - 1)) * W, z = -D / 2 + (j / (M.nz - 1)) * D;
        pos[v * 3] = x; pos[v * 3 + 1] = Y(i, j); pos[v * 3 + 2] = z;
        const dx = (Y(i + div, j) - Y(i - div, j)) / (2 * div * M.step), dz = (Y(i, j + div) - Y(i, j - div)) / (2 * div * M.step), l = Math.hypot(dx, 1, dz);
        nor[v * 3] = -dx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = -dz / l;
        uv[v * 2] = x / W + 0.5; uv[v * 2 + 1] = 0.5 - z / D;
      }
    for (let r = 0, k = 0; r < rows - 1; r++)
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + cols;
        idx[k++] = a; idx[k++] = b; idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1; idx[k++] = a + 1;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  function paintGround() {
    const cw = Q.tex, ch = Math.round((cw * D) / W), sx = cw / W;
    const can = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    const g = can.getContext('2d');
    // base: elevation + slope tint per DEM cell, upscaled
    const st = Q.tex >= 4096 ? 1 : 2, bw = Math.ceil(M.nx / st), bh = Math.ceil(M.nz / st);
    const base = Object.assign(document.createElement('canvas'), { width: bw, height: bh });
    const bg = base.getContext('2d'), img = bg.createImageData(bw, bh), px = img.data;
    const valley = [124, 146, 74], forest = [66, 92, 44], rock = [128, 118, 100];
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        const k = y * st * M.nx + x * st, h = H[k] / 10, o = (y * bw + x) * 4;
        const dx = (H[Math.min(k + 1, H.length - 1)] - H[Math.max(k - 1, 0)]) / 20 / M.step;
        const dz = (H[Math.min(k + M.nx, H.length - 1)] - H[Math.max(k - M.nx, 0)]) / 20 / M.step;
        const s = Math.hypot(dx, dz), t = clamp((h - 1240) / 220 + s * 0.9, 0, 1), r = clamp((s - 0.75) * 2, 0, 0.6), n = 0.92 + rand() * 0.16;
        for (let c = 0; c < 3; c++) px[o + c] = ((valley[c] * (1 - t) + forest[c] * t) * (1 - r) + rock[c] * r) * n;
        px[o + 3] = 255;
      }
    bg.putImageData(img, 0, 0);
    g.drawImage(base, 0, 0, cw, ch);
    // one Path2D per style: a few canvas calls instead of thousands
    const path = (list, from, closed) => {
      const p = new Path2D();
      for (const a of list) {
        p.moveTo((a[from] + W / 2) * sx, (a[from + 1] + D / 2) * sx);
        for (let i = from + 2; i < a.length; i += 2) p.lineTo((a[i] + W / 2) * sx, (a[i + 1] + D / 2) * sx);
        if (closed) p.closePath();
      }
      return p;
    };
    const stroke = (ctx, p, width, style) => { Object.assign(ctx, { strokeStyle: style, lineWidth: Math.max(1, width * sx), lineCap: 'round', lineJoin: 'round' }); ctx.stroke(p); };
    stroke(g, path(map.roads.filter((r) => r[0] >= 1 && r[0] <= 3), 1), 96, 'rgba(206,196,176,0.92)'); // urban ground
    stroke(g, path(map.roads.filter((r) => r[0] === 4), 1), 36, 'rgba(206,196,176,0.8)');
    const AREA = ['#cdc3ae', '#86b052', '#47622c', '#a4ab5e', '#4f8fb0', '#74ad4b', '#a9ab90'];
    for (const k of [0, 3, 2, 1, 5, 6, 4]) { g.fillStyle = AREA[k]; g.fill(path(map.areas.filter((a) => a[0] === k), 1, true)); }
    for (const w of map.water) stroke(g, path([w], 1), w[0], '#4f8fb0');
    const ROADC = ['#8d8a84', '#9a9790', '#a6a39c', '#b3b0a8', '#bab6ad', '#d7c79f', '#cdbfa3'], ROADW = [16, 13, 11, 8.5, 5, 3, 3];
    for (const cls of [5, 6, 4, 3, 2, 1, 0]) stroke(g, path(map.roads.filter((r) => r[0] === cls), 1), ROADW[cls], ROADC[cls]);
    stroke(g, path(map.rails, 0), 4, '#6b5b4c');
    // flocked grain
    const grain = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const gg = grain.getContext('2d'), gi = gg.createImageData(128, 128);
    for (let i = 0; i < gi.data.length; i += 4) { const v = rand() * 255; gi.data[i] = gi.data[i + 1] = gi.data[i + 2] = v; gi.data[i + 3] = 255; }
    gg.putImageData(gi, 0, 0);
    Object.assign(g, { globalAlpha: 0.13, globalCompositeOperation: 'overlay', fillStyle: g.createPattern(grain, 'repeat') });
    g.fillRect(0, 0, cw, ch);
    Object.assign(g, { globalAlpha: 1, globalCompositeOperation: 'source-over' });
    const color = new THREE.CanvasTexture(can);
    color.colorSpace = THREE.SRGBColorSpace;
    if (!Q.pbr) return { color };
    // roughness: water is glossy
    const rc = Object.assign(document.createElement('canvas'), { width: cw / 2, height: ch / 2 });
    const r = rc.getContext('2d');
    r.scale(0.5, 0.5); r.fillStyle = '#fff'; r.fillRect(0, 0, cw, ch);
    r.fillStyle = '#333'; r.fill(path(map.areas.filter((a) => a[0] === 4), 1, true));
    for (const w of map.water) stroke(r, path([w], 1), w[0], '#333');
    return { color, rough: new THREE.CanvasTexture(rc) };
  }

  function makeSkirt() {
    // side walls of the cut: moss lip on top, layered soil below (strata follow absolute height)
    const pos = [], col = [], uv = [], idx = [];
    const moss = new THREE.Color('#7a9a46'), soil = new THREE.Color('#d2a57c'), deep = new THREE.Color('#a07652');
    const edges = [[[-W / 2, -D / 2], [W / 2, -D / 2]], [[W / 2, -D / 2], [W / 2, D / 2]], [[W / 2, D / 2], [-W / 2, D / 2]], [[-W / 2, D / 2], [-W / 2, -D / 2]]];
    for (const [[x0, z0], [x1, z1]] of edges) {
      const n = Math.round(Math.hypot(x1 - x0, z1 - z0) / (M.step * Q.div)), b = pos.length / 3;
      for (let i = 0; i <= n; i++) {
        const x = x0 + ((x1 - x0) * i) / n, z = z0 + ((z1 - z0) * i) / n, y = yAt(x, z), u = (i * M.step * Q.div) / 400;
        for (const [yy, c] of [[y, moss], [y - 14, soil], [-SKIRT, deep]]) { pos.push(x, yy, z); col.push(c.r, c.g, c.b); uv.push(u, (yy + SKIRT) / 260); }
        if (i < n) { const a = b + i * 3; idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 512 });
    const g = c.getContext('2d');
    for (let y = 0; y < 512; y += 2) { const v = 200 + Math.sin(y * 0.11) * 25 + rand() * 30; g.fillStyle = `rgb(${v},${v * 0.93},${v * 0.86})`; g.fillRect(0, y, 64, 2); }
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(40,28,20,${rand() * 0.35})`; g.fillRect(rand() * 64, rand() * 512, 1 + rand() * 3, 1 + rand() * 2); }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(geo, lambert({ vertexColors: true, map: tex, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    return mesh;
  }

  function makePlinth() {
    // lacquered base with the Pueblo Mágico colour band, a brass name plaque and a soft contact shadow
    const c = Object.assign(document.createElement('canvas'), { width: 1024, height: 64 });
    const g = c.getContext('2d');
    g.fillStyle = '#23272e'; g.fillRect(0, 0, 1024, 64);
    const band = ['#5BA85B', '#7DC062', '#DB7A2F', '#F2C08E', '#D9314A', '#D7308F', '#A33A93', '#5F47A6', '#4890D8', '#5FC0EF'];
    band.forEach((b, i) => { g.fillStyle = b; g.fillRect((i * 1024) / band.length, 4, 1024 / band.length + 1, 16); });
    const side = new THREE.CanvasTexture(c);
    side.colorSpace = THREE.SRGBColorSpace;
    const sideMat = lambert({ map: side }), flat = lambert({ color: '#23272e' });
    const ph = 240, plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 140, ph, D + 140), [sideMat, sideMat, flat, flat, sideMat, sideMat]);
    plinth.position.y = -SKIRT - ph / 2;
    plinth.receiveShadow = true;
    const sc = Object.assign(document.createElement('canvas'), { width: 12, height: 12 });
    const sg = sc.getContext('2d');
    sg.fillStyle = 'rgba(20,30,45,0.3)'; sg.fillRect(3, 3, 6, 6);
    sg.fillStyle = 'rgba(20,30,45,0.5)'; sg.fillRect(4, 4, 4, 4); // bilinear upscaling does the blur
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, D * 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(260, -SKIRT - ph - 2, -160);
    const pc = Object.assign(document.createElement('canvas'), { width: 2048, height: 192 });
    const plaqueTex = new THREE.CanvasTexture(pc);
    plaqueTex.colorSpace = THREE.SRGBColorSpace;
    const paintPlaque = () => {
      const p = pc.getContext('2d'), grad = p.createLinearGradient(0, 0, 0, 192);
      grad.addColorStop(0, '#f6ead0'); grad.addColorStop(1, '#dcc796');
      p.fillStyle = grad; p.fillRect(0, 0, 2048, 192);
      p.strokeStyle = '#8a6a3a'; p.lineWidth = 5; p.strokeRect(16, 16, 2016, 160);
      p.fillStyle = '#3b2a14'; p.textAlign = 'center';
      p.font = '700 84px Fraunces, Georgia, serif'; p.fillText('Orizaba · Pueblo Mágico', 1024, 104);
      p.font = 'italic 500 40px Fraunces, Georgia, serif'; p.fillText('Ahuilizapan, «en las aguas alegres»', 1024, 156);
      plaqueTex.needsUpdate = true;
      requestRender();
    };
    paintPlaque();
    document.fonts?.load('700 84px Fraunces').then(paintPlaque, () => {});
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(2400, 225), lambert({ map: plaqueTex }));
    plaque.position.set(0, -SKIRT - ph / 2, D / 2 + 71.5);
    return [plinth, shadow, plaque];
  }

  // ---------- city: houses + OSM footprints straight into typed arrays (no per-vertex objects) ----------
  async function buildCity() {
    const dv = new DataView(cBuf), C = M.city;
    let verts = C.rects * 20, tris = C.rects * 10, o = C.rects * 9;
    for (let k = 0; k < C.polys; k++) { const n = dv.getUint16(o + 1, true); verts += 5 * n; tris += 3 * n - 2; o += 3 + n * 4; }
    const pos = new Float32Array(verts * 3), nor = new Int8Array(verts * 3), col = new Uint8Array(verts * 3), idx = new Uint32Array(tris * 3);
    const hex = (list) => list.map((h) => { const c = new THREE.Color(h); return [c.r * 255, c.g * 255, c.b * 255]; });
    const WALLS = hex(['#f3e9d8', '#f6f1e7', '#efd9a7', '#e8b98a', '#d98f6f', '#c9d6dc', '#e9c3c0', '#d7e2c4', '#e2c79f', '#f1e4c8', '#bf8f72', '#f0dfb8']);
    const ROOFS = hex(['#b65c3e', '#a8503a', '#c7684a', '#c9c4ba', '#ebe7e0', '#a09b93', '#dcd7cd', '#b3aea5', '#b65c3e']);
    const [CHURCH_W, CHURCH_R] = hex(['#eadcc0', '#c9b28f']);
    let v = 0, t = 0;
    const tanks = [];
    const vert = (x, y, z, nx, ny, nz, c, s) => {
      const i = v * 3;
      pos[i] = x; pos[i + 1] = y; pos[i + 2] = z; nor[i] = nx; nor[i + 1] = ny; nor[i + 2] = nz;
      col[i] = Math.min(255, c[0] * s); col[i + 1] = Math.min(255, c[1] * s); col[i + 2] = Math.min(255, c[2] * s);
      return v++;
    };
    const tri = (a, b, c) => { idx[t++] = a; idx[t++] = b; idx[t++] = c; };
    // footprints arrive with negative signed area (x,z); with that order these windings face outward/up
    const extrude = (xs, zs, n, lv, church, roofTris) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { const y = yAt(xs[i], zs[i]); lo = Math.min(lo, y); hi = Math.max(hi, y); }
      const base = lo - 2, top = hi + lv * LEVEL * (church ? 1.25 : 1);
      const wall = church ? CHURCH_W : WALLS[(rand() * WALLS.length) | 0], roof = church ? CHURCH_R : ROOFS[(rand() * ROOFS.length) | 0];
      const shade = 0.9 + rand() * 0.14;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, dx = xs[j] - xs[i], dz = zs[j] - zs[i], L = Math.hypot(dx, dz) || 1, nx = Math.round((-dz / L) * 127), nz = Math.round((dx / L) * 127);
        const a = vert(xs[i], base, zs[i], nx, 0, nz, wall, shade), b = vert(xs[j], base, zs[j], nx, 0, nz, wall, shade);
        const c = vert(xs[j], top, zs[j], nx, 0, nz, wall, shade), d = vert(xs[i], top, zs[i], nx, 0, nz, wall, shade);
        tri(a, b, c); tri(a, c, d);
      }
      const r0 = v;
      for (let i = 0; i < n; i++) vert(xs[i], top, zs[i], 0, 127, 0, roof, 1);
      roofTris(r0);
      return top;
    };
    const xs = new Float64Array(4096), zs = new Float64Array(4096);
    for (let k = 0, p = 0; k < C.rects; k++, p += 9) {
      if (k % 5000 === 4999) await nextTask();
      const cx = dv.getInt16(p, true) / 2, cz = dv.getInt16(p + 2, true) / 2, ang = (dv.getUint16(p + 4, true) / 65535) * 2 * Math.PI;
      const w = dv.getUint8(p + 6) / 20, d = dv.getUint8(p + 7) / 20, lv = dv.getUint8(p + 8), ux = Math.cos(ang), uz = Math.sin(ang);
      const corners = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
      for (let i = 0; i < 4; i++) { const [a, b] = corners[i]; xs[i] = cx + ux * a * w - uz * b * d; zs[i] = cz + uz * a * w + ux * b * d; }
      const top = extrude(xs, zs, 4, lv, false, (r) => { tri(r, r + 1, r + 2); tri(r, r + 2, r + 3); });
      if (Q.tanks && cellHash(k, 7, 3) < 0.3) tanks.push(cx + (cellHash(k, 1, 4) - 0.5) * w, top, cz + (cellHash(k, 2, 4) - 0.5) * d);
    }
    for (let k = 0, p = C.rects * 9; k < C.polys; k++) {
      const head = dv.getUint8(p), n = dv.getUint16(p + 1, true);
      let area = 0;
      for (let i = 0; i < n; i++) { xs[i] = dv.getInt16(p + 3 + i * 4, true) / 2; zs[i] = dv.getInt16(p + 5 + i * 4, true) / 2; }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += xs[i] * zs[j] - xs[j] * zs[i]; }
      if (area > 0) { xs.subarray(0, n).reverse(); zs.subarray(0, n).reverse(); }
      const contour = Array.from({ length: n }, (_, i) => new THREE.Vector2(xs[i], zs[i]));
      extrude(xs, zs, n, head & 127, head >> 7, (r) => {
        for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
          const up = (zs[b] - zs[a]) * (xs[c] - xs[a]) - (xs[b] - xs[a]) * (zs[c] - zs[a]) > 0; // y of (b-a)×(c-a)
          if (up) tri(r + a, r + b, r + c); else tri(r + a, r + c, r + b);
        }
      });
      p += 3 + n * 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, t), 1));
    geo.computeBoundingSphere();
    const city = new THREE.Mesh(geo, lambert({ vertexColors: true, side: THREE.DoubleSide }));
    city.castShadow = city.receiveShadow = true;
    const out = [city];
    if (tanks.length) {
      const tank = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.4, 1.4, 3, 8).translate(0, 1.5, 0), lambert({ color: '#3a3d42' }), tanks.length / 3);
      for (let i = 0; i < tanks.length; i += 3) tank.setMatrixAt(i / 3, new THREE.Matrix4().makeTranslation(tanks[i], tanks[i + 1], tanks[i + 2]));
      tank.castShadow = true;
      out.push(tank);
    }
    return out;
  }

  // ---------- trees: rebuilt from the one-byte-per-cell grid, in spatial chunks (frustum culling) ----------
  const treeMeshes = [];
  let treeFactor = 1;
  async function buildTrees() {
    const T = M.city.tree, grid = new Uint8Array(cBuf, M.city.rects * 9 + M.city.polyBytes, T.nx * T.nz);
    const paint = (geo, c) => { const a = new Float32Array(geo.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i); geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); return geo; };
    const white = new THREE.Color(1, 1, 1), bark = new THREE.Color('#6b5040');
    // low-poly on purpose (tens of thousands of instances): open cones, 4-sided trunk
    const trunk = () => paint(new THREE.CylinderGeometry(0.05, 0.07, 0.25, 4, 1, true).translate(0, 0.12, 0).toNonIndexed(), bark);
    const pine = mergeGeometries([trunk(), paint(new THREE.ConeGeometry(0.34, 0.62, 7, 1, true).translate(0, 0.45, 0).toNonIndexed(), white), paint(new THREE.ConeGeometry(0.25, 0.5, 7, 1, true).translate(0, 0.75, 0).toNonIndexed(), white)]);
    const leafy = mergeGeometries([trunk(), paint(new THREE.IcosahedronGeometry(0.42, 0).scale(1, 0.85, 1).translate(0, 0.6, 0), white)]);
    const COLS = [['#2c4a25', '#34522a', '#28401f', '#3b5a2c'], ['#4c6e2b', '#5a7a30', '#466628', '#6b8a36', '#3f5f27']].map((l) => l.map((c) => new THREE.Color(c)));
    const CX = 6, CZ = 4, chunks = Array.from({ length: 2 * CX * CZ }, () => []);
    for (let j = 0; j < T.nz; j++)
      for (let i = 0; i < T.nx; i++) {
        const b = grid[j * T.nx + i];
        if (!b || cellHash(i, j, 6) > Q.trees) continue;
        const type = (b - 1) >> 3, x = T.x0 + i * T.step + (cellHash(i, j, 1) - 0.5) * 10, z = T.z0 + j * T.step + (cellHash(i, j, 2) - 0.5) * 10;
        const chunk = type * CX * CZ + Math.min(CZ - 1, (((z + D / 2) / D) * CZ) | 0) * CX + Math.min(CX - 1, (((x + W / 2) / W) * CX) | 0);
        chunks[chunk].push([x, z, (12 + ((b - 1) & 7) * (10 / 7)) * (type ? 0.85 : 1), i, j]);
      }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const mats = [lambert({ vertexColors: true, flatShading: true }), lambert({ vertexColors: true, flatShading: true })];
    for (const [c, list] of chunks.entries()) {
      if (!list.length) continue;
      await nextTask();
      const type = c >= CX * CZ ? 1 : 0;
      list.sort((a, b) => cellHash(a[3], a[4], 7) - cellHash(b[3], b[4], 7)); // random order → `count` thins evenly
      const mesh = new THREE.InstancedMesh(type ? leafy : pine, mats[type], list.length);
      list.forEach(([x, z, hh, i, j], n) => {
        const h = hh * TREE;
        p.set(x, yAt(x, z) - 1, z);
        q.setFromAxisAngle(up, cellHash(i, j, 3) * 6.28);
        s.set(h * (0.9 + cellHash(i, j, 4) * 0.25), h, h * (0.9 + cellHash(i, j, 5) * 0.25));
        mesh.setMatrixAt(n, m.compose(p, q, s));
        mesh.setColorAt(n, COLS[type][(cellHash(i, j, 8) * COLS[type].length) | 0]);
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.full = list.length;
      treeMeshes.push(mesh);
    }
    return treeMeshes;
  }
  const thinTrees = (dist) => { // from afar the forest floor already reads as forest
    const f = (dist > 9000 ? 0.4 : dist > 5000 ? 0.65 : 1) * treeFactor;
    for (const t of treeMeshes) t.count = Math.ceil(t.userData.full * f);
  };

  // ---------- teleférico ----------
  const gondolas = [];
  let cableLine = null, cableMid = null;
  function buildTeleferico() {
    if (!map.aerial) return [];
    const out = [];
    const a = new THREE.Vector3(map.aerial[0], 0, map.aerial[1]), b = new THREE.Vector3(map.aerial.at(-2), 0, map.aerial.at(-1));
    a.y = yAt(a.x, a.z) + 26; b.y = yAt(b.x, b.z) + 26;
    const pts = [a];
    for (const t of [0.36, 0.7]) { const p = a.clone().lerp(b, t); p.y = Math.max(p.y, yAt(p.x, p.z) + 34); pts.push(p); }
    pts.push(b);
    cableLine = pts;
    cableMid = a.clone().lerp(b, 0.5);
    const dir = b.clone().sub(a).setY(0).normalize(), side = new THREE.Vector3(-dir.z, 0, dir.x);
    const steel = lambert({ color: '#3b4048' }), white = lambert({ color: '#f1efe9' }), red = lambert({ color: '#c8352b' }), glass = lambert({ color: '#cfe6f3' });
    for (const st of [a, b]) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(34, 20, 22), white);
      g.position.set(st.x, st.y - 16, st.z); g.lookAt(st.x + dir.x, st.y - 16, st.z + dir.z);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(38, 4, 26), red);
      roof.position.set(0, 12, 0); g.add(roof);
      g.castShadow = roof.castShadow = true;
      out.push(g);
    }
    for (const t of pts.slice(1, -1)) {
      const hgt = t.y - yAt(t.x, t.z) + 4, tw = new THREE.Mesh(new THREE.BoxGeometry(3.5, hgt, 3.5), steel);
      tw.position.set(t.x, t.y - hgt / 2 + 2, t.z); tw.castShadow = true;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 18), steel);
      arm.position.set(t.x, t.y + 1, t.z); arm.lookAt(t.x + side.x, t.y + 1, t.z + side.z);
      out.push(tw, arm);
    }
    for (const sgn of [-1, 1]) {
      const path = new THREE.CurvePath();
      for (let i = 0; i + 1 < pts.length; i++) path.add(new THREE.LineCurve3(pts[i].clone().addScaledVector(side, sgn * 7), pts[i + 1].clone().addScaledVector(side, sgn * 7)));
      out.push(new THREE.Mesh(new THREE.TubeGeometry(path, 64, 0.9, 4), steel));
      for (let k = 0; k < 3; k++) {
        const cab = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(8, 7, 8), red), win = new THREE.Mesh(new THREE.BoxGeometry(8.4, 2.6, 8.4), glass);
        body.position.y = -9; win.position.y = -7.6;
        const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.8, 6, 0.8), steel);
        hanger.position.y = -3;
        cab.add(body, win, hanger);
        out.push(cab);
        gondolas.push({ cab, path, phase: k / 3, dir: sgn });
      }
    }
    return out;
  }

  // ---------- lines: constant-width screen-space polylines draped on the terrain, drawn on top ----------
  // tour routes = white casing + animated gold dashes; walking directions = white casing + solid blue
  const lineMats = [
    new LineMaterial({ color: 0xffffff, linewidth: 9, depthTest: false, transparent: true, opacity: 0.95 }),
    new LineMaterial({ color: 0xf2a900, linewidth: 5, dashed: true, dashSize: 28, gapSize: 16, depthTest: false, transparent: true }),
    new LineMaterial({ color: 0xffffff, linewidth: 10, depthTest: false, transparent: true, opacity: 0.95 }),
    new LineMaterial({ color: 0x1565a8, linewidth: 5.5, depthTest: false, transparent: true }),
  ];
  const layers = { route: [], path: [] };
  function draw(layer, coords, mats, cableAt = new Set()) {
    for (const l of layers[layer]) { scene.remove(l); l.geometry.dispose(); }
    layers[layer] = [];
    requestRender();
    if (!coords) return null;
    const pts = [];
    for (let i = 0; i < coords.length; i += 2) {
      const x = coords[i], z = coords[i + 1];
      if (pts.length) {
        const prev = pts.at(-1), d = Math.hypot(x - prev.x, z - prev.z);
        if (cableAt.has(i / 2) && cableLine) { // ride the teleférico cable instead of draping
          const line = cableLine[0].distanceTo(prev) < cableLine.at(-1).distanceTo(prev) ? cableLine : [...cableLine].reverse();
          pts.push(...line.slice(1).map((p) => p.clone().setY(p.y - 9)));
        } else for (let k = 1; k < d / 14; k++) { const t = (k * 14) / d, px = prev.x + (x - prev.x) * t, pz = prev.z + (z - prev.z) * t; pts.push(new THREE.Vector3(px, yAt(px, pz) + 9, pz)); }
      }
      pts.push(new THREE.Vector3(x, yAt(x, z) + 9, z));
    }
    const flat = pts.flatMap((p) => [p.x, p.y, p.z]);
    for (const mat of mats) {
      const geo = new LineGeometry();
      geo.setPositions(flat);
      const line = new Line2(geo, mat);
      line.computeLineDistances();
      line.renderOrder = layer === 'path' ? 11 : 10;
      scene.add(line);
      layers[layer].push(line);
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, size: Math.max(maxX - minX, (maxZ - minZ) * 1.3) };
  }
  let routeAnim = false;
  const showRoute = (id, stops) => {
    const r = id && map.routes[id];
    routeAnim = !!r;
    return draw('route', r?.coords, lineMats.slice(0, 2), r && new Set(stops.map((s, i) => (s.startsWith('~') ? r.legs[i] : -1))));
  };
  const showPath = (coords) => draw('path', coords, lineMats.slice(2));

  // ---------- camera moves ----------
  const HOME = { x: 0, z: 120, dist: 10200, polar: 0.98, az: -0.16 };
  const fitHome = () => { // distance at which the board's width (plus margin) fills the view
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
    HOME.dist = clamp((W * (camera.aspect < 1 ? 0.45 : 0.55)) / Math.tan(hfov / 2), 8000, 30000);
    controls.maxDistance = HOME.dist * 1.4;
  };
  let tween = null;
  function setView(v) {
    controls.target.set(v.x, v.y ?? cityY, v.z);
    camera.position.setFromSpherical(new THREE.Spherical(v.dist, v.polar, v.az)).add(controls.target);
    camera.lookAt(controls.target);
  }
  function flyTo(v) {
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const to = { x: v.x, y: v.y ?? yAt(v.x, v.z), z: v.z, dist: v.dist ?? from.radius, polar: v.polar ?? from.phi, az: v.az ?? from.theta };
    const daz = Math.atan2(Math.sin(to.az - from.theta), Math.cos(to.az - from.theta));
    const start = { x: controls.target.x, y: controls.target.y, z: controls.target.z, dist: from.radius, polar: from.phi, az: from.theta };
    if (reduceMotion) { setView({ ...to, az: start.az + daz }); return; }
    tween = { t0: performance.now(), dur: 1000, start, to: { ...to, az: start.az + daz } };
  }
  controls.addEventListener('start', () => (tween = null));

  // ---------- loop: render only when something changed; drop resolution while moving if the device struggles ----------
  const frameCbs = [];
  let lastSig = '', lastMove = 0, slow = 0, lowWhileMoving = false, lowRes = false;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas.parentElement;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const m of lineMats) m.resolution.set(w, h);
    fitHome();
    needs = true;
  };
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();
  setView(HOME);
  const clock = new THREE.Clock();
  const loop = () => {
    const raw = clock.getDelta(), dt = Math.min(raw, 0.05), now = performance.now();
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / tween.dur), e = ease(t), s = tween.start, d = tween.to, L = (k) => s[k] + (d[k] - s[k]) * e;
      const lift = 1 + Math.sin(Math.PI * e) * Math.min(0.5, Math.hypot(d.x - s.x, d.z - s.z) / 7000); // rise a little over long trips
      setView({ x: L('x'), y: L('y'), z: L('z'), dist: L('dist') * lift, polar: L('polar'), az: L('az') });
      if (t >= 1) tween = null;
    }
    controls.update();
    controls.target.x = clamp(controls.target.x, -W / 2, W / 2);
    controls.target.z = clamp(controls.target.z, -D / 2, D / 2);
    const sig = camera.matrixWorld.elements.join() + camera.aspect, moved = sig !== lastSig;
    lastSig = sig;
    const dist = camera.position.distanceTo(controls.target);
    if (moved) {
      thinTrees(dist);
      lastMove = now;
      if (lowWhileMoving && !lowRes && dpr > 1) { renderer.setPixelRatio(1); lowRes = true; }
      // frames over ~24 ms while moving → render at 1× while moving; still slow → fewer trees
      slow = raw > 1 / 42 && raw < 0.5 ? slow + 1 : Math.max(0, slow - 1);
      if (slow > 14) { if (!lowWhileMoving && dpr > 1) lowWhileMoving = true; else treeFactor = Math.max(0.3, treeFactor * 0.75); slow = 0; }
    } else if (lowRes && now - lastMove > 220) { renderer.setPixelRatio(dpr); lowRes = false; needs = true; }
    const gondolasOn = gondolas.length > 0 && !reduceMotion && dist < 4500 && cableMid.distanceTo(controls.target) < 3000;
    const dashes = routeAnim && !reduceMotion;
    if (moved || tween || gondolasOn || dashes || needs) {
      needs = false;
      if (gondolasOn)
        for (const g of gondolas) {
          const u = (clock.elapsedTime * 0.012 + g.phase) % 1, along = g.dir > 0 ? u : 1 - u;
          g.cab.position.copy(g.path.getPointAt(along));
          const tg = g.path.getTangentAt(along);
          g.cab.rotation.y = Math.atan2(tg.x, tg.z);
        }
      if (dashes) lineMats[1].dashOffset -= dt * 40;
      renderer.render(scene, camera);
    }
    for (const cb of frameCbs) cb(moved);
  };

  // terrain is ready: compile its shaders without blocking where supported, then start drawing
  if (renderer.compileAsync) await renderer.compileAsync(scene, camera).catch(() => {});
  if (Q.shadow) renderer.shadowMap.needsUpdate = true;
  renderer.setAnimationLoop(loop);

  // the city streams in after the first frames, one heavy step per task
  (async () => {
    const add = async (objs) => {
      if (!objs.length) return;
      const g = new THREE.Group();
      g.add(...objs);
      if (renderer.compileAsync) await renderer.compileAsync(g, camera, scene).catch(() => {});
      scene.add(g);
      needs = true;
      await nextTask();
    };
    await nextTask();
    await add(await buildCity());
    await add(await buildTrees());
    thinTrees(camera.position.distanceTo(controls.target));
    await add(buildTeleferico());
    if (Q.shadow) renderer.shadowMap.needsUpdate = true;
  })();

  const v = new THREE.Vector3();
  return {
    tier, toXZ, yAt, requestRender,
    inside: (x, z) => Math.abs(x) < W / 2 - 20 && Math.abs(z) < D / 2 - 20,
    project(x, y, z) {
      v.set(x, y, z).project(camera);
      const { clientWidth: w, clientHeight: h } = canvas;
      return { x: (v.x + 1) * 0.5 * w, y: (1 - v.y) * 0.5 * h, on: v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15 };
    },
    distance: () => camera.position.distanceTo(controls.target),
    azimuth: () => controls.getAzimuthalAngle(),
    onFrame: (cb) => frameCbs.push(cb),
    flyTo,
    home: () => flyTo({ ...HOME, y: cityY }),
    north: () => flyTo({ x: controls.target.x, y: controls.target.y, z: controls.target.z, az: 0 }),
    zoom: (f) => flyTo({ x: controls.target.x, y: controls.target.y, z: controls.target.z, dist: clamp(camera.position.distanceTo(controls.target) * f, controls.minDistance, controls.maxDistance) }),
    showRoute,
    showPath,
    routeInfo: (id) => map.routes[id],
  };
}
