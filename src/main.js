import './style.css';
import { POIS, ROUTES, CATEGORIES } from './pois.js';
import PHOTOS from './photos.json';
import { loadGraph, walk } from './directions.js';

const $ = (s) => document.querySelector(s);
// bottom-sheet layout on phones and on tablets held upright (must match the CSS media query)
const sheetMQ = matchMedia('(max-width: 760px), (max-width: 1100px) and (orientation: portrait)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const touch = matchMedia('(pointer: coarse)').matches;
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const svg = (id, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const byId = new Map(POIS.map((p) => [p.id, p]));
for (const [id, ph] of Object.entries(PHOTOS)) Object.assign(byId.get(id) ?? {}, { img: ph.src, thumb: ph.thumb, credit: ph.credit });
const state = { cat: null, q: '', route: null, sel: null };
const AREAS = [
  { name: 'Cerro del Borrego', lat: 18.8492, lon: -97.1238 },
  { name: 'Cerro de Escamela', lat: 18.8693, lon: -97.0878 },
  { name: 'Centro Histórico', lat: 18.8476, lon: -97.1012 },
  { name: 'Río Orizaba', lat: 18.8556, lon: -97.1126 },
];
const CENTRO = { name: 'Parque Castillo', lat: 18.848839, lon: -97.104939 };
const dir = { from: 'centro', active: null }; // active = { origin, r } while walking directions are shown
const routeStops = () => state.route.stops.map((s) => byId.get(s.replace('~', '')));
const matches = (p) => (!state.cat || p.cat === state.cat) && (!state.q || norm(`${p.name} ${CATEGORIES[p.cat].label} ${p.desc}`).includes(state.q));
const visible = () => (state.route ? routeStops() : POIS.filter(matches));
const metres = (a, b) => Math.hypot((a.lon - b.lon) * 105350, (a.lat - b.lat) * 110574);
const far = (p) => metres(p, CENTRO) > 2500;
let world = null, dirty = true; // dirty: a state change the pins must reflect

// ---------- 3D map: loads in parallel (own chunk); the panel and the cards work without it ----------
const worldReady = import('./world.js')
  .then(({ createWorld }) => createWorld($('#scene'), { reduceMotion, onProgress: (m) => ($('#loader-msg').textContent = m) }))
  .then((w) => { world = w; initMap(); return w; })
  .catch((err) => {
    console.error(err);
    $('#loader').classList.add('done');
    $('#no3d').hidden = false;
    return null;
  });

const layer = $('#pins'), clusters = [];
let startEl;
function initMap() {
  for (const p of [...POIS, ...AREAS, CENTRO]) {
    [p.x, p.z] = world.toXZ(p.lat, p.lon);
    p.y = world.yAt(p.x, p.z) + (p.cat ? 16 : 40);
  }
  for (const p of POIS) {
    const c = CATEGORIES[p.cat], el = document.createElement('button');
    el.className = 'pin';
    el.hidden = true;
    el.style.setProperty('--c', c.color);
    el.innerHTML = `<span class="pin-dot">${svg(c.icon)}</span><span class="pin-label">${p.name}</span>`;
    el.setAttribute('aria-label', `${p.name}, ${c.label}`);
    el.addEventListener('click', () => select(p.id));
    p.el = el;
    layer.append(el);
  }
  for (const a of AREAS) {
    a.el = Object.assign(document.createElement('span'), { className: 'area-label', textContent: a.name });
    layer.prepend(a.el);
  }
  startEl = Object.assign(document.createElement('div'), { className: 'start-marker', hidden: true });
  layer.append(startEl);
  world.onFrame(layoutPins);
  addEventListener('resize', () => (dirty = true));
  renderRoutes();
  if (state.route) { renderList(); drawRoute(state.route, !state.sel); }
  if (state.sel) flyToPoi(byId.get(state.sel));
  $('#loader').classList.add('done');
}

// ---------- pins ----------
const clusterEl = (i) => {
  if (!clusters[i]) {
    const el = Object.assign(document.createElement('button'), { className: 'cluster', hidden: true });
    el.addEventListener('click', () => el.pick());
    layer.append(el);
    clusters[i] = el;
  }
  return clusters[i];
};
const put = (el, x, y) => { const t = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; if (el._t !== t) el.style.transform = el._t = t; };
const show = (el, on) => { if (el.hidden === on) el.hidden = !on; };
const setText = (el, text, label) => { if (el._txt !== label) { el._txt = label; el.textContent = text; el.setAttribute('aria-label', label); } };
function layoutPins(moved) {
  if (!moved && !dirty) return;
  dirty = false;
  const dist = world.distance(), vis = visible(), stopNo = state.route && new Map(routeStops().map((p, i) => [p.id, i + 1]));
  const rank = (p) => (p.id === state.sel ? 1e4 : 0) + (p.featured ? 100 : 0) - (p.n || 60);
  const heads = [];
  for (const p of [...vis].sort((a, b) => rank(b) - rank(a))) {
    const s = world.project(p.x, p.y, p.z);
    if (!s.on) continue;
    const near = p.id !== state.sel && heads.find((h) => Math.abs(h.s.x - s.x) < 34 && Math.abs(h.s.y - s.y) < 34);
    if (near) near.members.push(p);
    else heads.push({ p, s, members: [p] });
  }
  const shown = new Set(), boxes = [];
  const free = (r, own) => !boxes.some((b) => b !== own && r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y);
  for (const h of heads) boxes.push((h.box = { x: h.s.x - 20, y: h.s.y - 50, w: 40, h: 44 }));
  let ci = 0;
  for (const h of heads) {
    if (h.members.length === 1 || h.p.id === state.sel) {
      const { el } = h.p;
      shown.add(h.p);
      put(el, h.s.x, h.s.y);
      el.classList.toggle('sel', h.p.id === state.sel);
      let lab = h.p.id === state.sel || (h.members.length === 1 && (dist < 2600 || (!state.route && !!h.p.featured))), left = false;
      if (lab) { // only where it fits without covering another pin or label: right side first, then left
        const w = (el._lw ||= el.querySelector('.pin-label').offsetWidth) + 6, r = { x: h.s.x + 22, y: h.s.y - 46, w, h: 32 }, l = { ...r, x: h.s.x - 22 - w };
        if (h.p.id === state.sel || free(r, h.box)) boxes.push(r);
        else if (free(l, h.box)) { boxes.push(l); left = true; }
        else lab = false;
      }
      el.classList.toggle('labelled', lab);
      el.classList.toggle('left', left);
      const no = stopNo?.get(h.p.id);
      if (el._no !== no) { el._no = no; el.querySelector('.pin-dot').innerHTML = no ? `<b>${no}</b>` : svg(CATEGORIES[h.p.cat].icon); }
      if (h.members.length > 1) {
        const el2 = clusterEl(ci++), rest = h.members.slice(1);
        show(el2, true);
        put(el2, h.s.x - 30, h.s.y - 64);
        boxes.push({ x: h.s.x - 50, y: h.s.y - 84, w: 40, h: 40 });
        setText(el2, `+${rest.length}`, `${rest.length} lugares más aquí: ${rest.map((m) => m.name).join(', ')}`);
        el2.pick = () => zoomInto(h.members);
      }
      continue;
    }
    const el = clusterEl(ci++);
    show(el, true);
    put(el, h.s.x, h.s.y - 24);
    setText(el, h.members.length, `${h.members.length} lugares: ${h.members.map((m) => m.name).join(', ')}. Acercar`);
    el.pick = () => zoomInto(h.members);
  }
  for (let i = ci; i < clusters.length; i++) show(clusters[i], false);
  for (const p of POIS) show(p.el, shown.has(p));
  for (const a of AREAS) {
    const s = world.project(a.x, a.y, a.z), on = s.on && !state.route && dist > 1400;
    show(a.el, on);
    if (on) put(a.el, s.x, s.y);
  }
  const o = dir.active?.origin, so = o && world.project(o.x, world.yAt(o.x, o.z) + 6, o.z);
  show(startEl, !!so?.on);
  if (so?.on) { put(startEl, so.x, so.y); if (startEl._l !== o.label) startEl.innerHTML = `<span>${(startEl._l = o.label)}</span>`; }
  const az = world.azimuth(), dAz = Math.abs(Math.atan2(Math.sin(az + 0.16), Math.cos(az + 0.16)));
  $('#backdrop').style.opacity = (Math.max(0, 1 - dAz / 1.1) * Math.min(1, Math.max(0, (dist - 2500) / 4000))).toFixed(2); // painted Pico only behind the default view
  $('#compass').style.transform = `rotate(${az}rad)`;
}
function zoomInto(members) {
  const x = members.reduce((a, m) => a + m.x, 0) / members.length, z = members.reduce((a, m) => a + m.z, 0) / members.length;
  const spread = Math.max(...members.map((m) => Math.hypot(m.x - x, m.z - z)));
  world.flyTo({ x, z, dist: Math.max(380, Math.min(world.distance() * 0.45, spread * 9)) });
}
// keep the target clear of the card: above the bottom sheet, or right of the side card
function framed(x, z, dist) {
  const az = world.azimuth();
  return sheetMQ.matches ? [x + Math.sin(az) * dist * 0.3, z + Math.cos(az) * dist * 0.3] : [x - Math.cos(az) * dist * 0.2, z + Math.sin(az) * dist * 0.2];
}

// ---------- selection & detail ----------
function flyToPoi(p) {
  if (!world) return; // initMap flies there once the map is up
  const dist = sheetMQ.matches ? 1300 : 1050, [x, z] = framed(p.x, p.z, dist);
  world.flyTo({ x, z, y: world.yAt(p.x, p.z), dist, polar: 0.93 });
}
function clearDirections() {
  dir.active = null;
  world?.showPath(null);
  dirty = true;
}
function hideDetail() {
  $('#detail').hidden = true;
  $('#app').classList.remove('has-detail');
}
function select(id, { fly = true } = {}) {
  const p = byId.get(id);
  if (!p) return;
  clearDirections();
  state.sel = id;
  renderDetail(p);
  renderList();
  if (fly) flyToPoi(p);
  setHash(state.route ? `ruta/${state.route.id}/${id}` : id);
  $('#panel').classList.remove('open');
}
function closeDetail() {
  clearDirections();
  state.sel = null;
  hideDetail();
  renderList();
  setHash(state.route ? `ruta/${state.route.id}` : '');
}
const ORN = `<svg class="orn" viewBox="0 0 132 14" aria-hidden="true"><path d="M0 7h52M80 7h52" stroke="currentColor" stroke-width="1.2"/><path d="M66 1l6 6-6 6-6-6z" fill="currentColor"/><circle cx="56" cy="7" r="1.8" fill="currentColor"/><circle cx="76" cy="7" r="1.8" fill="currentColor"/></svg>`;
const gmaps = (p, origin) => `https://www.google.com/maps/dir/?api=1${origin ? `&origin=${origin.lat},${origin.lon}` : ''}&destination=${p.lat},${p.lon}&travelmode=${far(p) ? 'driving' : 'walking'}`;
function renderDetail(p) {
  const d = $('#detail'), c = CATEGORIES[p.cat];
  const stops = state.route && routeStops(), i = stops ? stops.indexOf(p) : -1;
  d.style.setProperty('--c', c.color);
  d.innerHTML = `
    <div class="detail-tools"><button class="round" data-copy aria-label="Copiar enlace" title="Copiar enlace">${svg('link')}</button><button class="round detail-close" aria-label="Cerrar ficha">${svg('x')}</button></div>
    <div class="detail-media${p.img ? '' : ' pattern'}">${p.img ? `<img src="${p.img}" alt="${p.name}" width="760" height="428" decoding="async"><span class="credit">${p.credit}</span>` : `<span class="medallion">${svg(c.icon)}</span>`}</div>
    <div class="detail-body">
      <p class="detail-cat">${svg(c.icon)} ${c.label}${p.n ? ` · No. ${p.n} del mapa oficial` : ''}</p>
      <h2 tabindex="-1">${p.name}</h2>
      ${ORN}
      <p class="detail-addr">${svg('pin')}<span>${p.addr}</span></p>
      <p class="detail-desc">${p.desc}</p>
      ${p.dato ? `<aside class="dato"><b>${svg('star')} ¿Sabías que…?</b><p>${p.dato}</p></aside>` : ''}
      ${p.facts ? `<ul class="facts">${p.facts.map((f) => `<li>${svg('info')}<span>${f}</span></li>`).join('')}</ul>` : ''}
      <div class="actions">
        <button class="btn primary" data-dir>${svg('nav')} Cómo llegar</button>
        <a class="btn" href="${gmaps(p)}" target="_blank" rel="noopener">${svg('map')} Google Maps</a>
      </div>
      <section class="dir" id="dir" hidden aria-live="polite"></section>
      ${i < 0 ? '' : `<div class="tour">
        <button class="btn" data-step="-1" aria-label="Parada anterior" ${i === 0 ? 'disabled' : ''}>${svg('left')}</button>
        <p><b>Parada ${i + 1} de ${stops.length}</b>${state.route.name}</p>
        <button class="btn" data-step="1" aria-label="Siguiente parada" ${i === stops.length - 1 ? 'disabled' : ''}>${svg('right')}</button>
      </div><div class="progress"><span style="width:${((i + 1) / stops.length) * 100}%"></span></div>`}
    </div>`;
  d.hidden = false;
  d.scrollTop = 0;
  $('#app').classList.add('has-detail');
  d.querySelector('.detail-close').onclick = closeDetail;
  d.querySelector('[data-dir]').onclick = () => showDirections(p);
  d.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => step(+b.dataset.step)));
  d.querySelector('[data-copy]').onclick = async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(location.href); b.title = '¡Enlace copiado!'; b.setAttribute('aria-label', '¡Enlace copiado!'); b.innerHTML = svg('info'); }
    catch { b.title = 'Copia la dirección del navegador'; }
    setTimeout(() => { b.innerHTML = svg('link'); b.title = 'Copiar enlace'; b.setAttribute('aria-label', 'Copiar enlace'); }, 2200);
  };
  d.querySelector('h2').focus({ preventScroll: true });
}

// ---------- walking directions (in-app, over the OSM street graph) ----------
const TURN = { start: 'start', straight: 'up', left: 'turn-left', right: 'turn-right', uturn: 'uturn', arrive: 'flag' };
const locate = () => new Promise((ok, no) => (navigator.geolocation ? navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: true, timeout: 10000 }) : no()));
async function showDirections(p) {
  const box = $('#dir');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<p class="dir-sum">Calculando la ruta…</p>';
  if (!(await worldReady)) { box.innerHTML = `<p class="dir-note">Este dispositivo no puede mostrar la ruta en 3D. Ábrela en Google Maps:</p><a class="btn" href="${gmaps(p)}" target="_blank" rel="noopener">${svg('map')} Ver en Google Maps</a>`; return; }
  let origin = { ...CENTRO, label: 'Inicio' }, note = '';
  if (dir.from === 'gps') {
    try {
      const { coords } = await locate(), [x, z] = world.toXZ(coords.latitude, coords.longitude);
      if (world.inside(x, z)) origin = { name: 'Tu ubicación', label: 'Tú', lat: coords.latitude, lon: coords.longitude, x, z };
      else note = 'Tu ubicación está fuera de esta zona de Orizaba; mostramos la ruta desde el Parque Castillo.';
    } catch { note = 'No pudimos obtener tu ubicación; mostramos la ruta desde el Parque Castillo.'; }
  }
  try { await loadGraph(); } catch { box.innerHTML = '<p class="dir-note">No se pudo cargar el mapa de calles. Usa Google Maps.</p>'; return; }
  if (state.sel !== p.id) return; // the user moved on while we were waiting
  const r = walk(origin, p, p.name);
  if (!r) { box.innerHTML = '<p class="dir-note">No encontramos un camino a pie. Usa Google Maps.</p>'; return; }
  dir.active = { origin, r };
  dirty = true;
  const b = world.showPath(r.coords), dist = Math.max(900, b.size * 1.9), [x, z] = framed(b.cx, b.cz, dist);
  world.flyTo({ x, z, dist, polar: 0.9 });
  const seg = (k, label) => `<button class="seg" data-from="${k}" aria-pressed="${dir.from === k}">${label}</button>`;
  box.innerHTML = `
    <div class="dir-from" role="group" aria-label="Punto de partida">Desde ${seg('centro', 'Parque Castillo')}${seg('gps', 'Mi ubicación')}</div>
    ${note ? `<p class="dir-note">${note}</p>` : ''}
    <p class="dir-sum">${r.lengthText} <small>· ${r.minutes} min a pie</small></p>
    ${far(p) ? '<p class="dir-note">Está lejos para caminar: te sugerimos taxi o auto (abre Google Maps).</p>' : ''}
    <ol class="steps">${r.steps.map((s) => `<li><span class="turn">${svg(TURN[s.turn])}</span><span>${s.text}</span><small>${s.distText}</small></li>`).join('')}</ol>
    <a class="btn" href="${gmaps(p, origin)}" target="_blank" rel="noopener">${svg('map')} Abrir estas indicaciones en Google Maps</a>`;
  box.querySelectorAll('[data-from]').forEach((el) => (el.onclick = () => { dir.from = el.dataset.from; showDirections(p); }));
  box.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
}
function step(delta) {
  const stops = routeStops(), i = stops.findIndex((p) => p.id === state.sel) + delta;
  if (i >= 0 && i < stops.length) select(stops[i].id);
}

// ---------- routes ----------
function drawRoute(r, fly) {
  const box = world.showRoute(r.id, r.stops);
  if (fly) world.flyTo({ x: box.cx, z: box.cz, dist: Math.max(1600, box.size * 2.2), polar: 0.82 });
}
function startRoute(id, { fly = true } = {}) {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) return;
  clearDirections();
  Object.assign(state, { route: r, cat: null, q: '', sel: null });
  $('#q').value = '';
  hideDetail();
  renderAll();
  setHash(`ruta/${id}`);
  if (world) drawRoute(r, fly); // otherwise initMap draws it
  $('#list-head').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}
function exitRoute() {
  state.route = null;
  state.sel = null;
  world?.showRoute(null);
  hideDetail();
  renderAll();
  setHash('');
  world?.home();
}
const routeMeta = (r) => {
  const info = world?.routeInfo(r.id);
  return `${r.stops.length} paradas${info ? ` · ${(info.walk / 1000).toFixed(1)} km` : ''} · ${r.mode}`;
};

// ---------- panel ----------
function renderRoutes() {
  $('#routes').innerHTML = ROUTES.map((r) => `
    <button class="route-card" data-route="${r.id}" aria-pressed="${state.route?.id === r.id}" style="--c:${CATEGORIES[r.cat].color}">
      <span class="route-ico">${svg(CATEGORIES[r.cat].icon)}</span>
      <span><span class="route-name">${r.name}</span><span class="route-meta">${routeMeta(r)}</span></span>
      ${svg('right', 'i chev')}
    </button>`).join('');
  $('#routes').querySelectorAll('[data-route]').forEach((b) => (b.onclick = () => startRoute(b.dataset.route)));
}
function renderChips() {
  const chips = $('#chips');
  chips.hidden = !!state.route;
  chips.innerHTML = [[null, { label: 'Todos', color: '#1565A8' }], ...Object.entries(CATEGORIES)].map(([k, c]) =>
    `<button class="chip" data-cat="${k ?? ''}" style="--c:${c.color}" aria-pressed="${state.cat === k}"><span class="dot"></span>${c.label}</button>`).join('');
  chips.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { state.cat = b.dataset.cat || null; renderChips(); renderList(); }));
}
function item(p, badge) {
  const c = CATEGORIES[p.cat];
  return `<button class="item" data-id="${p.id}" aria-current="${p.id === state.sel}" style="--c:${c.color}">
    ${badge ?? (p.thumb ? `<img class="thumb" src="${p.thumb}" alt="" width="42" height="42" loading="lazy" decoding="async">` : `<span class="badge">${svg(c.icon)}</span>`)}
    <span><span class="item-name">${p.name}</span><span class="item-meta">${c.label}${p.n ? ` · No. ${p.n}` : ''}</span></span>
  </button>`;
}
function renderList() {
  dirty = true;
  const head = $('#list-head'), list = $('#lista');
  if (state.route) {
    const r = state.route, info = world?.routeInfo(r.id), min = info && Math.round(info.walk / 75);
    const meta = info ? `${(info.walk / 1000).toFixed(1)} km a pie · ≈ ${Math.floor(min / 60) ? `${Math.floor(min / 60)} h ` : ''}${min % 60} min caminando${info.cable ? ' + teleférico' : ''}` : `${r.stops.length} paradas · ${r.mode}`;
    head.innerHTML = `<div><h2 id="places-title">${r.name}</h2><p class="item-meta">${meta}</p></div>
      <button class="btn" id="exit-route">${svg('x')} Salir</button>`;
    list.innerHTML = `<button class="btn primary" id="start-tour" style="margin-bottom:10px">Comenzar en la parada 1</button>` + routeStops().map((p, i) => item(p, `<span class="badge"><b>${i + 1}</b></span>`)).join('');
    $('#exit-route').onclick = exitRoute;
    $('#start-tour').onclick = () => select(routeStops()[0].id);
  } else {
    const vis = POIS.filter(matches);
    head.innerHTML = `<h2 id="places-title">Lugares (${vis.length})</h2>`;
    list.innerHTML = vis.length
      ? Object.entries(CATEGORIES).map(([k, c]) => {
          const ps = vis.filter((p) => p.cat === k);
          return ps.length ? `<h3 class="sr-only">${c.label}</h3>${ps.map((p) => item(p)).join('')}` : '';
        }).join('')
      : `<p class="empty">No encontramos «${state.q.replace(/[<>&"]/g, '')}». Prueba con otro nombre o quita los filtros.</p>`;
  }
  list.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => select(b.dataset.id)));
}
function renderAll() { renderRoutes(); renderChips(); renderList(); }

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    state.q = norm(e.target.value.trim());
    if (state.route && state.q) { state.route = null; world?.showRoute(null); closeDetail(); renderRoutes(); renderChips(); } // searching leaves the tour
    renderList();
  }, 120);
});
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const p = POIS.find(matches); if (p) select(p.id); } });
$('#sheet-handle').onclick = () => {
  const open = $('#panel').classList.toggle('open');
  $('#sheet-handle').setAttribute('aria-expanded', open);
};

// ---------- map controls ----------
$('#zin').onclick = () => world?.zoom(0.6);
$('#zout').onclick = () => world?.zoom(1.6);
$('#home').onclick = () => world?.home();
$('#north').onclick = () => world?.north();
if (touch) $('#hint').textContent = 'Un dedo para mover · Dos dedos para girar y acercar';
const hideHint = () => $('#hint').classList.add('gone');
$('#scene').addEventListener('pointerdown', hideHint, { once: true });
setTimeout(hideHint, 7000);
addEventListener('keydown', (e) => {
  if (e.target.matches('input')) return;
  if (e.key === 'Escape' && !$('#detail').hidden) closeDetail();
  if (state.route && state.sel && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) step(e.key === 'ArrowRight' ? 1 : -1);
});

// ---------- deep links: #palacio-de-hierro · #ruta/centro · #ruta/centro/catedral ----------
function setHash(h) { history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search); }
function applyHash() {
  const [a, b, c] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (a === 'ruta') { startRoute(b, { fly: !c }); if (c) select(c); }
  else if (byId.has(a)) select(a);
}
addEventListener('hashchange', applyHash);
renderAll();
applyHash();
