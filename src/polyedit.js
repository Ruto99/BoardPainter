// Polygon modelling (ZModeler-like) on a polygon mesh: { pos: Float32Array, polys: number[][] } with faces wound
// counter-clockwise seen from outside. Every operation returns a new mesh plus `src`, the original vertex each
// output vertex copies its attributes (mask, color, group) from, so callers can carry those along.
//
//   quadsFromTriangles  pair triangles into quads (for meshes that have no polygon faces yet)
//   extrude / inset     move a set of faces out along their normals (and/or shrink them), adding side walls
//   insertLoop          cut a loop of quads in two across an edge (stops at non-quads / borders)
//   deleteFaces         remove faces (leaves a hole) and the vertices nothing uses any more
//   closeHole           fill the border loop through an edge with one polygon
//   triangulate         polygons -> triangles for display / sculpting

const ek = (a, b) => a < b ? a * 0x200000 + b : b * 0x200000 + a;   // undirected edge key (vertices < 2M)
const sub = (P, a, b) => [P[a*3] - P[b*3], P[a*3+1] - P[b*3+1], P[a*3+2] - P[b*3+2]];
const cross = (u, v) => [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
const dot = (u, v) => u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };

export function polyNormal(P, f) {   // Newell
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < f.length; k++) {
    const a = f[k] * 3, b = f[(k + 1) % f.length] * 3;
    x += (P[a+1] - P[b+1]) * (P[a+2] + P[b+2]); y += (P[a+2] - P[b+2]) * (P[a] + P[b]); z += (P[a] - P[b]) * (P[a+1] + P[b+1]);
  }
  return norm([x, y, z]);
}
export function polyCenter(P, f) {
  let x = 0, y = 0, z = 0; for (const v of f) { x += P[v*3]; y += P[v*3+1]; z += P[v*3+2]; }
  return [x / f.length, y / f.length, z / f.length];
}

export function toPolys(start, idx) { const out = []; for (let f = 0; f + 1 < start.length; f++) out.push(Array.from(idx.subarray(start[f], start[f + 1]))); return out; }
export function fromPolys(polys) {
  const start = new Uint32Array(polys.length + 1); let n = 0;
  polys.forEach((f, i) => { n += f.length; start[i + 1] = n; });
  const idx = new Uint32Array(n); let o = 0; for (const f of polys) for (const v of f) idx[o++] = v;
  return { start, idx };
}

// quads along the shorter diagonal, n-gons as a fan from their first corner
export function triangulate(P, polys) {
  let n = 0; for (const f of polys) n += f.length - 2;
  const t = new Uint32Array(n * 3); let o = 0;
  const d2 = (a, b) => { const v = sub(P, a, b); return dot(v, v); };
  for (const f of polys) {
    if (f.length === 4 && d2(f[1], f[3]) < d2(f[0], f[2])) { t.set([f[0], f[1], f[3], f[1], f[2], f[3]], o); o += 6; continue; }
    for (let k = 1; k + 1 < f.length; k++) { t[o++] = f[0]; t[o++] = f[k]; t[o++] = f[k + 1]; }
  }
  return t;
}

// Pair neighbouring triangles into quads when the pair is nearly flat and close to a rectangle (best pairs first).
export function quadsFromTriangles(P, idx) {
  const nT = idx.length / 3, byEdge = new Map(), tn = [];
  for (let t = 0; t < nT; t++) {
    const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
    tn.push(norm(cross(sub(P, b, a), sub(P, c, a))));
    for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = ek(x, y); (byEdge.get(k) || byEdge.set(k, []).get(k)).push(t); }
  }
  const cand = [];
  for (const [k, l] of byEdge) {
    if (l.length !== 2) continue;
    const [s, t] = l; if (dot(tn[s], tn[t]) < 0.94) continue;   // ~20 degrees
    const A = [idx[s*3], idx[s*3+1], idx[s*3+2]], B = [idx[t*3], idx[t*3+1], idx[t*3+2]];
    const other = B.find(v => !A.includes(v)); if (other === undefined) continue;
    // quad in A's winding: insert B's apex after the shared edge's first vertex
    let q = null;
    for (let i = 0; i < 3; i++) { const x = A[i], y = A[(i + 1) % 3]; if (ek(x, y) === k) { q = [x, other, y, A[(i + 2) % 3]]; break; } }
    if (!q) continue;
    let worst = 0;   // corner angles: how far from 90 degrees
    for (let i = 0; i < 4; i++) {
      const u = norm(sub(P, q[(i + 3) % 4], q[i])), v = norm(sub(P, q[(i + 1) % 4], q[i]));
      worst = Math.max(worst, Math.abs(dot(u, v)));
    }
    if (worst > 0.7) continue;   // a corner beyond ~45 degrees off square
    cand.push([worst - dot(tn[s], tn[t]) * 0.1, s, t, q]);
  }
  cand.sort((x, y) => x[0] - y[0]);
  const used = new Uint8Array(nT), polys = [];
  for (const [, s, t, q] of cand) { if (used[s] || used[t]) continue; used[s] = used[t] = 1; polys.push(q); }
  for (let t = 0; t < nT; t++) if (!used[t]) polys.push([idx[t*3], idx[t*3+1], idx[t*3+2]]);
  return polys;
}

// faces sharing an edge with face `f` (index lists), and the faces around a vertex
export function adjacency(polys) {
  const byEdge = new Map();
  polys.forEach((f, i) => f.forEach((v, k) => { const key = ek(v, f[(k + 1) % f.length]); (byEdge.get(key) || byEdge.set(key, []).get(key)).push(i); }));
  return byEdge;
}
// the connected faces whose normals stay within `deg` of face f's normal (a flat side of a box, ...)
export function flatIsland(P, polys, f, deg = 8) {
  const byEdge = adjacency(polys), n0 = polyNormal(P, polys[f]), c = Math.cos(deg * Math.PI / 180);
  const seen = new Set([f]), q = [f];
  while (q.length) {
    const g = polys[q.pop()];
    for (let k = 0; k < g.length; k++) for (const h of byEdge.get(ek(g[k], g[(k + 1) % g.length]))) {
      if (seen.has(h) || dot(polyNormal(P, polys[h]), n0) < c) continue;
      seen.add(h); q.push(h);
    }
  }
  return [...seen];
}

// Extrude faces `sel` (indices) as one region: its vertices are copied, side walls join each border edge to its
// copy. `amount(v, n, c)` gives the new position of a copied vertex from its old position, normal and the region
// centre, so the caller can drag it afterwards. Returns { pos, polys, src, moved: [[newVertex, oldVertex, normal]] }.
export function extrude(P, polys, sel) {
  const S = new Set(sel), nV = P.length / 3;
  const vn = new Map();   // region vertex -> summed face normals
  for (const f of S) { const n = polyNormal(P, polys[f]); for (const v of polys[f]) { const s = vn.get(v) || [0, 0, 0]; vn.set(v, [s[0] + n[0], s[1] + n[1], s[2] + n[2]]); } }
  // border edges: used once inside the region (direction as in the region face)
  const count = new Map();
  for (const f of S) { const g = polys[f]; g.forEach((v, k) => { const key = ek(v, g[(k + 1) % g.length]); count.set(key, (count.get(key) || 0) + 1); }); }
  const copy = new Map(); let next = nV;
  for (const v of vn.keys()) copy.set(v, next++);
  const pos = new Float32Array(next * 3); pos.set(P);
  const src = new Int32Array(next); for (let v = 0; v < nV; v++) src[v] = v;
  const moved = [];
  for (const [v, c] of copy) { pos.set(P.subarray(v * 3, v * 3 + 3), c * 3); src[c] = v; moved.push([c, v, norm(vn.get(v))]); }
  const out = polys.map((f, i) => S.has(i) ? f.map(v => copy.get(v)) : f.slice());
  for (const f of S) {
    const g = polys[f];
    for (let k = 0; k < g.length; k++) {
      const a = g[k], b = g[(k + 1) % g.length];
      if (count.get(ek(a, b)) === 1) out.push([a, b, copy.get(b), copy.get(a)]);
    }
  }
  return { pos, polys: out, src, moved };
}

// Split the strip of quads crossing edge (a, b) at fraction t (0..1 from a). Faces that are not quads but touch a
// split edge get the new vertex inserted into that side, so the mesh stays closed.
export function insertLoop(P, polys, a, b, t = 0.5) {
  const byEdge = adjacency(polys), nV = P.length / 3;
  const extra = [], newOn = new Map();   // edge key -> new vertex
  const point = (u, w, s) => {   // vertex at fraction s from u towards w on edge (u, w)
    const k = ek(u, w); if (newOn.has(k)) return newOn.get(k);
    const id = nV + extra.length / 3;
    extra.push(P[u*3] + (P[w*3] - P[u*3]) * s, P[u*3+1] + (P[w*3+1] - P[u*3+1]) * s, P[u*3+2] + (P[w*3+2] - P[u*3+2]) * s);
    newOn.set(k, id); return id;
  };
  const split = new Map(), segs = [];   // quad index -> its two halves; the new edges (for a preview)
  // walk from edge (u, w) through quad f; returns the next (edge, quad) or null
  const walk = (u, w, s, f) => {
    while (f !== undefined && !split.has(f)) {
      const g = polys[f];
      if (g.length !== 4) return;
      const i = g.findIndex((v, k) => (v === u && g[(k + 1) % 4] === w) || (v === w && g[(k + 1) % 4] === u));
      if (i < 0) return;
      // orient so the quad is [p0, p1, p2, p3] with the entry edge p0 -> p1 and (u at fraction 0) mapped onto it
      const q = [g[i], g[(i + 1) % 4], g[(i + 2) % 4], g[(i + 3) % 4]];
      const sp = q[0] === u ? s : 1 - s;               // fraction from q[0] towards q[1]
      const m0 = point(q[0], q[1], sp), m1 = point(q[3], q[2], sp);   // opposite edge runs q[3] -> q[2]
      split.set(f, [[q[0], m0, m1, q[3]], [m0, q[1], q[2], m1]]); segs.push(m0, m1);
      // continue across the opposite edge (q[3], q[2]) with q[3] at the same fraction
      const next = byEdge.get(ek(q[2], q[3])).find(h => h !== f);
      u = q[3]; w = q[2]; s = sp; f = next;
    }
  };
  const faces = byEdge.get(ek(a, b)) || [];
  for (const f of faces) walk(a, b, t, f);
  if (!split.size) return null;
  const out = [];
  polys.forEach((g, i) => {
    if (split.has(i)) { out.push(...split.get(i)); return; }
    // non-quad faces on a split edge: insert the new vertex between the edge's ends
    const ng = [];
    for (let k = 0; k < g.length; k++) { const v = g[k], w = g[(k + 1) % g.length]; ng.push(v); const m = newOn.get(ek(v, w)); if (m !== undefined) ng.push(m); }
    out.push(ng);
  });
  const pos = new Float32Array(P.length + extra.length); pos.set(P); pos.set(extra, P.length);
  const src = new Int32Array(pos.length / 3); for (let v = 0; v < nV; v++) src[v] = v;
  for (const [k, id] of newOn) src[id] = Math.floor(k / 0x200000);
  return { pos, polys: out, src, loop: split.size, segs };
}

// drop vertices no face uses; returns { pos, polys, src }
export function compact(P, polys, src0) {
  const nV = P.length / 3, map = new Int32Array(nV).fill(-1); let n = 0;
  for (const f of polys) for (const v of f) if (map[v] < 0) map[v] = n++;
  const pos = new Float32Array(n * 3), src = new Int32Array(n);
  for (let v = 0; v < nV; v++) if (map[v] >= 0) { pos.set(P.subarray(v * 3, v * 3 + 3), map[v] * 3); src[map[v]] = src0 ? src0[v] : v; }
  return { pos, polys: polys.map(f => f.map(v => map[v])), src };
}
export function deleteFaces(P, polys, sel) {
  const S = new Set(sel);
  return compact(P, polys.filter((_, i) => !S.has(i)));
}

// fill the border loop through edge (a, b) (an edge with a face on one side only) with one polygon
export function closeHole(P, polys, a, b) {
  const byEdge = adjacency(polys);
  const l = byEdge.get(ek(a, b)); if (!l || l.length !== 1) return null;
  // border half-edges run opposite to their face's winding: out[v] = next vertex along the hole
  const out = new Map();
  for (const [k, fs] of byEdge) {
    if (fs.length !== 1) continue;
    const g = polys[fs[0]];
    for (let i = 0; i < g.length; i++) { const x = g[i], y = g[(i + 1) % g.length]; if (ek(x, y) === k) { out.set(y, x); break; } }
  }
  const g = polys[l[0]], i = g.findIndex((v, k) => ek(v, g[(k + 1) % g.length]) === ek(a, b));
  const st = g[(i + 1) % g.length];
  const loop = [st]; let v = out.get(st);
  while (v !== undefined && v !== st && loop.length < 100000) { loop.push(v); v = out.get(v); }
  if (v !== st || loop.length < 3) return null;
  const pos = new Float32Array(P), src = new Int32Array(P.length / 3).map((_, i) => i);
  return { pos, polys: polys.concat([loop]), src, size: loop.length };
}

// edges of the faces (for wireframe / highlight), and the open border edges
export function borderEdges(polys) {
  const byEdge = adjacency(polys), out = [];
  for (const [k, fs] of byEdge) if (fs.length === 1) out.push([Math.floor(k / 0x200000), k % 0x200000]);
  return out;
}
export { ek as edgeKey };
