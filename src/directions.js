// Walking directions over the OSM street graph baked by scripts/bake.mjs (public/data/graph.json, loaded on first use).
let G = null;
const FACTOR = { 0: 1.2, 1: 1.15, 5: 0.95, 6: 1.1 }; // prefer footpaths, avoid big avenues a little

export async function loadGraph() {
  if (G) return G;
  const { nodes, edges, names } = await fetch('data/graph.json').then((r) => r.json());
  const n = nodes.length / 2, start = new Int32Array(n + 1);
  for (let i = 0; i < edges.length; i += 4) { start[edges[i] + 1]++; start[edges[i + 1] + 1]++; }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const m = start[n], to = new Int32Array(m), cost = new Float32Array(m), name = new Int32Array(m), cls = new Int8Array(m), fill = start.slice(0, n);
  for (let i = 0; i < edges.length; i += 4) {
    const [a, b, nm, c] = [edges[i], edges[i + 1], edges[i + 2], edges[i + 3]];
    const len = Math.hypot(nodes[2 * b] - nodes[2 * a], nodes[2 * b + 1] - nodes[2 * a + 1]) * (FACTOR[c] ?? 1);
    for (const [u, v] of [[a, b], [b, a]]) { const k = fill[u]++; to[k] = v; cost[k] = len; name[k] = nm; cls[k] = c; }
  }
  return (G = { nodes, names, n, start, to, cost, name, cls });
}

function nearest(x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < G.n; i++) { const d = (G.nodes[2 * i] - x) ** 2 + (G.nodes[2 * i + 1] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}

function shortest(src, dst) { // Dijkstra with a binary heap; returns the edge slots along the path
  const dist = new Float64Array(G.n).fill(Infinity), via = new Int32Array(G.n).fill(-1), prev = new Int32Array(G.n), heap = [[0, src]];
  dist[src] = 0;
  const up = (i) => { while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let k = i; if (l < heap.length && heap[l][0] < heap[k][0]) k = l; if (r < heap.length && heap[r][0] < heap[k][0]) k = r; if (k === i) return; [heap[k], heap[i]] = [heap[i], heap[k]]; i = k; } };
  while (heap.length) {
    const [d, u] = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; down(0); }
    if (u === dst) break;
    if (d > dist[u]) continue;
    for (let k = G.start[u]; k < G.start[u + 1]; k++) {
      const v = G.to[k], nd = d + G.cost[k];
      if (nd < dist[v]) { dist[v] = nd; via[v] = k; prev[v] = u; heap.push([nd, v]); up(heap.length - 1); }
    }
  }
  const edges = [];
  for (let v = dst; v !== src; v = prev[v]) { if (via[v] < 0) return null; edges.unshift(via[v]); }
  return edges;
}

const CARD = ['el este', 'el noreste', 'el norte', 'el noroeste', 'el oeste', 'el suroeste', 'el sur', 'el sureste'];
const UNNAMED = { 4: 'la calle de servicio', 5: 'el andador', 6: 'las escaleras' };
const fmt = (m) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

// from/to: {x, z} in board metres. Returns null when no path exists.
export function walk(from, to, placeName) {
  const s = nearest(from.x, from.z), t = nearest(to.x, to.z);
  const edges = s === t ? [] : shortest(s, t);
  if (!edges) return null;
  const P = (i) => [G.nodes[2 * i], G.nodes[2 * i + 1]];
  const coords = [from.x, from.z, ...P(s)];
  // group consecutive edges by street, keeping the heading at both ends of each group
  const groups = [];
  let node = s;
  for (const k of edges) {
    const [ax, az] = P(node), next = G.to[k], [bx, bz] = P(next), len = Math.hypot(bx - ax, bz - az);
    const label = G.names[G.name[k]] || UNNAMED[G.cls[k]] || 'la calle', head = [bx - ax, az - bz]; // (east, north)
    const g = groups.at(-1);
    if (g && g.label === label) { g.len += len; g.out = head; } else groups.push({ label, len, in: head, out: head });
    coords.push(bx, bz);
    node = next;
  }
  coords.push(to.x, to.z);
  // fold tiny connectors (crossings, short links) into the previous street
  const steps = [];
  for (const g of groups) {
    const prev = steps.at(-1);
    if (prev && (g.len < 25 || g.label === prev.label)) { prev.len += g.len; prev.out = g.out; } else steps.push({ ...g });
  }
  const total = coords.reduce((a, _, i) => (i >= 2 && i % 2 === 0 ? a + Math.hypot(coords[i] - coords[i - 2], coords[i + 1] - coords[i - 1]) : a), 0);
  const out = steps.map((g, i) => {
    if (!i) {
      const ang = Math.atan2(g.in[1], g.in[0]), card = CARD[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
      return { turn: 'start', text: `Sal hacia ${card} por ${g.label}`, dist: g.len };
    }
    const [e1, n1] = steps[i - 1].out, [e2, n2] = g.in;
    const a = (Math.atan2(e1 * n2 - n1 * e2, e1 * e2 + n1 * n2) * 180) / Math.PI; // + = left
    if (Math.abs(a) < 30) return { turn: 'straight', text: `Sigue derecho por ${g.label}`, dist: g.len };
    if (Math.abs(a) > 150) return { turn: 'uturn', text: `Da vuelta y sigue por ${g.label}`, dist: g.len };
    return { turn: a > 0 ? 'left' : 'right', text: `Gira a la ${a > 0 ? 'izquierda' : 'derecha'} en ${g.label}`, dist: g.len };
  });
  out.push({ turn: 'arrive', text: `Llegas a ${placeName}`, dist: 0 });
  return { coords, length: total, steps: out.map((x) => ({ ...x, distText: x.dist ? fmt(x.dist) : '' })), lengthText: fmt(total), minutes: Math.max(1, Math.round(total / 75)) };
}
