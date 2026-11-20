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
//   faceRing / groupFaces    selections: the strip of quads across an edge, the faces of a polygroup
//   slideLoop           move an edge loop along its neighbouring edges
//   dissolveLoop        remove an edge loop (its two sides become one face each, straight-through vertices go)
//   collapseEdge        merge an edge's two ends at its middle
//   flatten             press faces onto their average plane
//   splitOff            the selected faces as a separate mesh, and the rest

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
  return { pos, polys: out, src, loop: split.size, segs, ring: [...split.keys()], at: newOn.get(ek(a, b)) };
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

// ---------------- Phase 17: edge loops, crease carry-over, bevel, bridge ----------------
export function vertFaces(polys, nV) {
  const vf = Array.from({ length: nV }, () => []);
  polys.forEach((f, i) => { for (const v of f) vf[v].push(i); });
  return vf;
}
// faces around v in winding order; between[i] = the vertex x of edge (v, x) shared by faces[i] and faces[i + 1].
// null at a border (or a non-manifold) vertex
function ringAt(polys, vfv, v) {
  if (!vfv.length) return null;
  const faces = [], between = [];
  let f = vfv[0];
  for (let guard = 0; guard <= vfv.length; guard++) {
    const g = polys[f], k = g.indexOf(v), prev = g[(k + g.length - 1) % g.length];
    faces.push(f); between.push(prev);
    // the next face around v holds the directed edge v -> prev
    const nf = vfv.find(h => { const q = polys[h], j = q.indexOf(v); return h !== f && q[(j + 1) % q.length] === prev; });
    if (nf === undefined) return null;
    if (nf === faces[0]) return faces.length === vfv.length ? { faces, between } : null;
    f = nf;
  }
  return null;
}
// the loop of edges through (a, b): continues straight through vertices with 4 quads around them
export function edgeLoop(polys, nV, a, b, vf = vertFaces(polys, nV)) {
  const edges = [[a, b]], seen = new Set([ek(a, b)]);
  let closed = false;
  const follow = (u, w, push) => {
    for (let guard = 0; guard < 100000; guard++) {
      const fs = vf[w]; if (fs.length !== 4 || fs.some(f => polys[f].length !== 4)) return;
      const r = ringAt(polys, fs, w); if (!r) return;
      const i = r.between.indexOf(u); if (i < 0) return;
      const x = r.between[(i + 2) % 4], k = ek(w, x);
      if (seen.has(k)) { if (x === a || x === b) closed = true; return; }
      seen.add(k); push([w, x]); u = w; w = x;
    }
  };
  follow(a, b, e => edges.push(e));
  if (!closed) { const back = []; follow(b, a, e => back.push(e)); edges.unshift(...back.reverse().map(([x, y]) => [y, x])); }
  return { edges, closed };
}

// keep crease edges through an operation: an output edge is creased when the input edge it was copied from was,
// and both of its ends are still where they were
export function carryCreases(Pold, polysOut, Pnew, src, crease) {
  if (!crease || !crease.length) return null;
  const set = new Set(); for (let i = 0; i < crease.length; i += 2) set.add(ek(crease[i], crease[i + 1]));
  // a vertex still lies on the old edge (a, b) (unmoved, or slid along it by a bevel)
  const onOld = (v, a, b) => {
    const ax = Pold[a*3], ay = Pold[a*3+1], az = Pold[a*3+2], dx = Pold[b*3] - ax, dy = Pold[b*3+1] - ay, dz = Pold[b*3+2] - az;
    const L2 = dx*dx + dy*dy + dz*dz; if (L2 < 1e-20) return false;
    const px = Pnew[v*3] - ax, py = Pnew[v*3+1] - ay, pz = Pnew[v*3+2] - az, t = (px*dx + py*dy + pz*dz) / L2;
    if (t < -1e-6 || t > 1 + 1e-6) return false;
    const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t;
    return ex*ex + ey*ey + ez*ez <= L2 * 1e-10;
  };
  const out = [], done = new Set();
  for (const f of polysOut) for (let k = 0; k < f.length; k++) {
    const x = f[k], y = f[(k + 1) % f.length], key = ek(x, y);
    if (done.has(key)) continue; done.add(key);
    if (src[x] !== src[y] && set.has(ek(src[x], src[y])) && onOld(x, src[x], src[y]) && onOld(y, src[x], src[y])) out.push(x, y);
  }
  return out.length ? Uint32Array.from(out) : null;
}

// Chamfer the edges (an edge loop or any chain): every edge becomes a strip of quads of one width everywhere:
// `t` x the median length of the edges that meet the bevelled edges, or `opt.distance` (model units); either is
// limited to 0.49 x the shortest of those edges so strips never overlap. The width used to be a fraction of each neighbouring edge, which made a chamfer
// between a long and a short edge taper and flare out at the corner. Chain ends get a small corner face (or, at a
// 3-face corner, the third face takes both new vertices). Needs closed (manifold) surroundings.
// Returns { pos, polys, src, strip: [new strip face indices], width } or null.
export function bevel(P, polys, edges, t = 0.2, opt = {}) {
  const nV = P.length / 3, vf = vertFaces(polys, nV), byEdge = adjacency(polys);
  const E = new Set(); for (const [u, w] of edges) { const k = ek(u, w); if ((byEdge.get(k) || []).length !== 2) return null; E.add(k); }
  if (!E.size) return null;
  const cnt = new Map(); for (const k of E) for (const v of [Math.floor(k / 0x200000), k % 0x200000]) cnt.set(v, (cnt.get(v) || 0) + 1);
  const extra = [], srcX = [];
  const addV = (v, x, y, z) => { extra.push(x, y, z); srcX.push(v); return nV + srcX.length - 1; };
  const rep = new Map();        // face * 2^21 + v -> replacement vertex
  const ins = new Map();        // undirected edge key -> { v, nv }: insert nv next to v on that edge (faces that keep v)
  const corner3 = new Set();    // end vertices with 3 faces: dissolved into the third face
  const T = Math.max(0.01, Math.min(0.49, t));
  const at = (v, x, s) => [P[v*3] + (P[x*3] - P[v*3]) * s, P[v*3+1] + (P[x*3+1] - P[v*3+1]) * s, P[v*3+2] + (P[x*3+2] - P[v*3+2]) * s];
  const len = (v, x) => Math.hypot(...sub(P, x, v));
  // edges at the bevelled vertices that are not bevelled themselves (all of them if every edge is bevelled):
  // the width is t x their median length, at most 0.49 x the shortest so strips never overlap
  const side = [], every = [];
  for (const [v] of cnt) for (const f of vf[v]) { const g = polys[f], k = g.indexOf(v); for (const x of [g[(k + 1) % g.length], g[(k + g.length - 1) % g.length]]) {
    const l = len(v, x); if (l < 1e-12) continue; every.push(l); if (!E.has(ek(v, x))) side.push(l); } }
  const ls = (side.length ? side : every).sort((a, b) => a - b); if (!ls.length) return null;
  const D = Math.min(0.49 * ls[0], opt.distance > 0 ? opt.distance : T * ls[ls.length >> 1]);
  const along = (v, x) => at(v, x, Math.min(0.49, D / Math.max(len(v, x), 1e-12)));   // D along the edge v -> x
  for (const [v, c] of cnt) {
    const r = ringAt(polys, vf[v], v); if (!r) return null;
    const n = r.faces.length, sel = []; for (let i = 0; i < n; i++) if (E.has(ek(v, r.between[i]))) sel.push(i);
    if (c === 1) {
      const i = sel[0], A = r.faces[i], B = r.faces[(i + 1) % n];
      const xa = r.between[(i + n - 1) % n], xb = r.between[(i + 1) % n];   // A's other edge, B's other edge
      const v1 = addV(v, ...along(v, xa)), v2 = addV(v, ...along(v, xb));
      rep.set(A * 0x200000 + v, v1); rep.set(B * 0x200000 + v, v2);
      ins.set(ek(v, xa), { v, nv: v1 }); ins.set(ek(v, xb), { v, nv: v2 });
      if (n === 3) corner3.add(v);
      continue;
    }
    // sectors between consecutive selected edges: one new vertex each, slid along the sector's inner edges
    for (let s = 0; s < sel.length; s++) {
      const i0 = sel[s], i1 = sel[(s + 1) % sel.length], fs = [], inner = [];
      for (let j = (i0 + 1) % n; ; j = (j + 1) % n) { fs.push(r.faces[j]); if (j === i1) break; inner.push(r.between[j]); }
      let x = 0, y = 0, z = 0;
      if (inner.length) { for (const u of inner) { const q = along(v, u); x += q[0]; y += q[1]; z += q[2]; } x /= inner.length; y /= inner.length; z /= inner.length; }
      else {   // no edge to slide along (one face between two bevelled edges): D away from both edges, in the face
        const a = sub(P, r.between[i0], v), b = sub(P, r.between[i1], v), la = Math.hypot(...a) || 1, lb = Math.hypot(...b) || 1;
        const ua = a.map(q => q / la), ub = b.map(q => q / lb), sn = Math.max(0.2, Math.hypot(...cross(ua, ub)));
        const k = Math.min(D / sn, 0.49 * Math.min(la, lb));
        x = P[v*3] + (ua[0] + ub[0]) * k; y = P[v*3+1] + (ua[1] + ub[1]) * k; z = P[v*3+2] + (ua[2] + ub[2]) * k;
      }
      const nvx = addV(v, x, y, z); for (const f of fs) rep.set(f * 0x200000 + v, nvx);
    }
  }
  // rebuild every face: replaced corners, dropped 3-face corners, new end vertices inserted on their edges
  const out = polys.map((g, fi) => {
    const ng = [];
    for (let k = 0; k < g.length; k++) {
      const v = g[k], w = g[(k + 1) % g.length], rv = rep.get(fi * 0x200000 + v);
      if (rv !== undefined) ng.push(rv); else if (!corner3.has(v)) ng.push(v);
      const e = ins.get(ek(v, w));   // between v and w, in faces that still hold the old end vertex
      if (e && (e.v === v || e.v === w) && rep.get(fi * 0x200000 + e.v) === undefined) ng.push(e.nv);
    }
    return ng;
  });
  const strip = [];
  for (const k of E) {
    const [A, B] = byEdge.get(k), g = polys[A], u0 = Math.floor(k / 0x200000), w0 = k % 0x200000;
    const j = g.indexOf(u0), dirUW = g[(j + 1) % g.length] === w0;
    const u = dirUW ? u0 : w0, w = dirUW ? w0 : u0;   // A holds u -> w, B holds w -> u
    const R = (f, v) => rep.get(f * 0x200000 + v);
    strip.push(out.length); out.push([R(A, w), R(A, u), R(B, u), R(B, w)]);
  }
  // close the little holes left at chain ends (corners with more than 3 faces)
  const pos = new Float32Array(P.length + extra.length); pos.set(P); pos.set(extra, P.length);
  const src = new Int32Array(pos.length / 3); for (let v = 0; v < nV; v++) src[v] = v; srcX.forEach((s, i) => { src[nV + i] = s; });
  const cleaned = out.map(f => f.filter((v, i) => v !== f[(i + 1) % f.length]));
  const be = adjacency(cleaned), nxt = new Map();
  for (const [key, fs] of be) if (fs.length === 1) {
    const g = cleaned[fs[0]]; for (let i = 0; i < g.length; i++) { const x = g[i], y = g[(i + 1) % g.length]; if (ek(x, y) === key) { nxt.set(y, x); break; } }
  }
  const used = new Set();
  for (const [s0] of nxt) {
    const c0 = cnt.get(src[s0]); if (used.has(s0) || c0 === undefined || c0 === 2) continue;   // holes only at chain ends and at corners of 3+ edges
    const loop = [s0]; let v = nxt.get(s0);
    while (v !== undefined && v !== s0 && loop.length < 16) { loop.push(v); v = nxt.get(v); }
    if (v === s0 && loop.length >= 3) { loop.forEach(x => used.add(x)); cleaned.push(loop); }
  }
  const c = compact(pos, cleaned, src);
  // the two long edges of every strip face (to keep a crease on the bevelled edge sharp)
  const rails = []; for (const f of strip) { const q = c.polys[f]; rails.push(q[0], q[1], q[2], q[3]); }
  return { ...c, strip: strip.length, rails, width: D };
}

// Bridge two holes with a band of quads (same number of border edges). (a1, b1) and (a2, b2): one border edge of each.
export function holeLoop(polys, a, b) {
  const byEdge = adjacency(polys), l = byEdge.get(ek(a, b)); if (!l || l.length !== 1) return null;
  const out = new Map();
  for (const [k, fs] of byEdge) {
    if (fs.length !== 1) continue;
    const g = polys[fs[0]];
    for (let i = 0; i < g.length; i++) { const x = g[i], y = g[(i + 1) % g.length]; if (ek(x, y) === k) { out.set(y, x); break; } }
  }
  const st = out.has(a) ? a : b, loop = [st]; let v = out.get(st);
  while (v !== undefined && v !== st && loop.length < 100000) { loop.push(v); v = out.get(v); }
  return v === st && loop.length >= 3 ? loop : null;
}
export function bridge(P, polys, a1, b1, a2, b2) {
  const A = holeLoop(polys, a1, b1), B = holeLoop(polys, a2, b2);
  if (!A || !B) return { error: 'border' };
  if (A.includes(B[0])) return { error: 'same' };
  if (A.length !== B.length) return { error: 'count', a: A.length, b: B.length };
  const n = A.length, d2 = (x, y) => { const dx = P[x*3] - P[y*3], dy = P[x*3+1] - P[y*3+1], dz = P[x*3+2] - P[y*3+2]; return dx*dx + dy*dy + dz*dz; };
  let best = 0, bd = Infinity;
  for (let s = 0; s < n; s++) { let d = 0; for (let i = 0; i < n; i++) d += d2(A[i], B[((s - i) % n + n) % n]); if (d < bd) { bd = d; best = s; } }
  const bi = i => B[((best - i) % n + n) % n];
  const out = polys.slice();
  for (let i = 0; i < n; i++) out.push([A[i], A[(i + 1) % n], bi(i + 1), bi(i)]);
  const pos = new Float32Array(P), src = new Int32Array(P.length / 3).map((_, i) => i);
  return { pos, polys: out, src, size: n };
}

// ---------------- more ZModeler-like actions ----------------
// the strip of quads crossing edge (a, b) (the faces "insert loop" would cut)
export function faceRing(P, polys, a, b) { const r = insertLoop(P, polys, a, b, 0.5); return r ? r.ring : null; }
// faces of polygroup `g` (per-vertex groups: a face takes the group most of its corners have, ties -> first corner)
export function faceGroupOf(f, grp) {
  const c = new Map(); let best = grp[f[0]], bn = 0;
  for (const v of f) { const n = (c.get(grp[v]) || 0) + 1; c.set(grp[v], n); if (n > bn) { bn = n; best = grp[v]; } }
  return best;
}
export function groupFaces(polys, grp, f) {
  const g = faceGroupOf(polys[f], grp), out = [];
  polys.forEach((q, i) => { if (faceGroupOf(q, grp) === g) out.push(i); });
  return out;
}

// for each vertex of an edge loop (edges chained in order), the neighbours along the edges leaving it on the
// left and right side of the loop. Returns { verts, left, right } (-1 where there is no such edge)
function loopSides(polys, edges) {
  const byEdge = adjacency(polys), verts = [], left = new Map(), right = new Map();
  const add = v => { if (!left.has(v)) { verts.push(v); left.set(v, -1); right.set(v, -1); } };
  for (const [u, w] of edges) {
    add(u); add(w);
    for (const f of byEdge.get(ek(u, w)) || []) {
      const g = polys[f], n = g.length, i = g.indexOf(u), fw = g[(i + 1) % n] === w;   // u -> w runs along f: f is left
      const side = fw ? left : right;
      // the other edge of f at u and at w
      const nu = fw ? g[(i + n - 1) % n] : g[(i + 1) % n], j = g.indexOf(w), nw = fw ? g[(j + 1) % n] : g[(j + n - 1) % n];
      if (side.get(u) < 0 && nu !== w) side.set(u, nu);
      if (side.get(w) < 0 && nw !== u) side.set(w, nw);
    }
  }
  return { verts, left, right };
}
// slide the loop's vertices along their side edges: t in -1..1 (negative = towards the right side)
export function slideLoop(P, polys, edges, t) {
  const { verts, left, right } = loopSides(polys, edges), pos = new Float32Array(P);
  for (const v of verts) {
    const nb = t >= 0 ? left.get(v) : right.get(v); if (nb < 0) continue;
    const s = Math.abs(t);
    for (let k = 0; k < 3; k++) pos[v*3+k] = P[v*3+k] + (P[nb*3+k] - P[v*3+k]) * s;
  }
  return pos;
}

// merge faces across the given edges (each group of faces joined by them becomes one polygon), then drop the
// vertices of those edges that are left in the middle of a straight side (2 edges). null if a merged region is not
// a simple disc
function mergeAcross(P, polys, keys, drop) {
  const byEdge = adjacency(polys), uf = polys.map((_, i) => i);
  const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  for (const k of keys) { const fs = byEdge.get(k); if (!fs || fs.length !== 2) return null; const a = find(fs[0]), b = find(fs[1]); if (a === b) return null; uf[a] = b; }
  const groups = new Map();
  polys.forEach((_, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(i); });
  const out = [];
  for (const fs of groups.values()) {
    if (fs.length === 1) { out.push(polys[fs[0]].slice()); continue; }
    // boundary half-edges of the region: those whose reverse is not in it
    const he = new Map(), inR = new Set();
    for (const f of fs) { const g = polys[f]; for (let k = 0; k < g.length; k++) inR.add(g[k] + ',' + g[(k + 1) % g.length]); }
    for (const f of fs) { const g = polys[f]; for (let k = 0; k < g.length; k++) { const a = g[k], b = g[(k + 1) % g.length]; if (!inR.has(b + ',' + a)) { if (he.has(a)) return null; he.set(a, b); } } }
    const st = he.keys().next().value, ring = [st];
    for (let v = he.get(st); v !== st; v = he.get(v)) { if (v === undefined || ring.length > he.size) return null; ring.push(v); }
    if (ring.length !== he.size) return null;
    out.push(ring);
  }
  // vertex valence (distinct edges) after merging
  const nb = new Map();
  for (const g of out) for (let k = 0; k < g.length; k++) { const a = g[k], b = g[(k + 1) % g.length]; (nb.get(a) || nb.set(a, new Set()).get(a)).add(b); (nb.get(b) || nb.set(b, new Set()).get(b)).add(a); }
  const gone = new Set(); for (const v of drop) if (nb.get(v) && nb.get(v).size === 2) gone.add(v);
  const polys2 = out.map(g => g.filter(v => !gone.has(v)));
  if (polys2.some(g => g.length < 3)) return null;
  return compact(P, polys2);
}
// remove an edge loop: the faces on its two sides merge (two quads -> one quad on a quad strip)
export function dissolveLoop(P, polys, edges) {
  const keys = new Set(edges.map(([u, w]) => ek(u, w))), drop = new Set();
  for (const [u, w] of edges) { drop.add(u); drop.add(w); }
  const r = mergeAcross(P, polys, keys, drop);
  return r && { ...r, removed: edges.length };
}
// merge the ends of edge (a, b) at its middle; faces that become degenerate disappear
export function collapseEdge(P, polys, a, b) {
  const pos = new Float32Array(P);
  for (let k = 0; k < 3; k++) pos[a*3+k] = (P[a*3+k] + P[b*3+k]) / 2;
  const out = [];
  for (const f of polys) {
    const g = [];
    for (const v of f) { const x = v === b ? a : v; if (g[g.length - 1] !== x) g.push(x); }
    while (g.length > 1 && g[0] === g[g.length - 1]) g.pop();
    if (g.length >= 3) out.push(g);
  }
  // two faces that now cover the same edge pair twice (a sliver) would make the surface non-manifold
  const byEdge = adjacency(out); for (const fs of byEdge.values()) if (fs.length > 2) return null;
  return compact(pos, out);
}
// press the faces' vertices onto the plane through their centre, facing their average normal
export function flatten(P, polys, sel) {
  const vs = new Set(); let nx = 0, ny = 0, nz = 0;
  for (const f of sel) { const n = polyNormal(P, polys[f]); nx += n[0]; ny += n[1]; nz += n[2]; for (const v of polys[f]) vs.add(v); }
  const n = norm([nx, ny, nz]); let cx = 0, cy = 0, cz = 0;
  for (const v of vs) { cx += P[v*3]; cy += P[v*3+1]; cz += P[v*3+2]; }
  cx /= vs.size; cy /= vs.size; cz /= vs.size;
  const pos = new Float32Array(P);
  for (const v of vs) { const d = (P[v*3] - cx) * n[0] + (P[v*3+1] - cy) * n[1] + (P[v*3+2] - cz) * n[2]; pos[v*3] -= n[0] * d; pos[v*3+1] -= n[1] * d; pos[v*3+2] -= n[2] * d; }
  return { pos, count: vs.size };
}
// the selected faces as their own mesh, and the remaining faces
export function splitOff(P, polys, sel) {
  const S = new Set(sel);
  return { part: compact(P, polys.filter((_, i) => S.has(i))), rest: compact(P, polys.filter((_, i) => !S.has(i))) };
}

// ---------------- QMesh, several loops, spin, relax ----------------
// after an extrude (walls appended after the first nOld faces, each starting with its border edge (a, b)): a wall
// that ends up in the plane of the face on the other side of (a, b) merges with it, so the extrusion continues
// that face instead of adding an edge (ZBrush's QMesh)
export function qmeshWeld(P, polys, nOld, deg = 3) {
  const byEdge = adjacency(polys), c = Math.cos(deg * Math.PI / 180), keys = new Set(), drop = new Set();
  for (let w = nOld; w < polys.length; w++) {
    const g = polys[w], a = g[0], b = g[1], k = ek(a, b), fs = byEdge.get(k) || [];
    const o = fs.find(f => f !== w); if (o === undefined || o >= nOld || fs.length !== 2) continue;
    const nw = polyNormal(P, g), no = polyNormal(P, polys[o]);
    // a wall of zero area (no drag) has no direction: leave it
    const ar = Math.hypot(...cross(sub(P, g[1], g[0]), sub(P, g[3], g[0]))); if (ar < 1e-12) continue;
    if (dot(nw, no) >= c) { keys.add(k); drop.add(a); drop.add(b); }
  }
  if (!keys.size) return null;
  const r = mergeAcross(P, polys, keys, drop);
  return r && { ...r, merged: keys.size };
}
// `count` evenly spaced loops across the strip through edge (a, b)
export function insertLoops(P, polys, a, b, count) {
  let cur = { pos: P, polys, src: null }, u = a, total = 0;
  const nV0 = P.length / 3;
  for (let i = 0; i < count; i++) {
    const r = insertLoop(cur.pos, cur.polys, u, b, 1 / (count + 1 - i));
    if (!r) return i ? cur : null;
    const src = new Int32Array(r.pos.length / 3);
    for (let v = 0; v < src.length; v++) { const o = r.src[v]; src[v] = cur.src ? cur.src[o] ?? o : (o < nV0 ? o : o); }
    cur = { pos: r.pos, polys: r.polys, src }; u = r.at; total += r.loop;
  }
  return { ...cur, loop: total };
}
// turn the edge (a, b) between two faces to the next pair of corners of the polygon they form together
export function spinEdge(P, polys, a, b) {
  const byEdge = adjacency(polys), fs = byEdge.get(ek(a, b)); if (!fs || fs.length !== 2) return null;
  const [f1, f2] = fs, g1 = polys[f1], g2 = polys[f2];
  // ring around both faces: f1 holds the edge as x -> y; walk f1 from y round to x, then f2 (which holds y -> x)
  // from just after x round to just before y
  const i1 = g1.indexOf(a), m1 = g1.length, m2 = g2.length;
  const xI = g1[(i1 + 1) % m1] === b ? i1 : (i1 + m1 - 1) % m1, x = g1[xI], ring = [];
  for (let k = 1; k <= m1; k++) ring.push(g1[(xI + k) % m1]);
  const i2 = g2.indexOf(x);
  for (let k = 1; k <= m2 - 2; k++) ring.push(g2[(i2 + k) % m2]);
  const L = ring.length; if (L < 4 || new Set(ring).size !== L) return null;
  // the old edge joins ring[0] (y) and ring[m1 - 1] (x); move both ends one step on
  const p = 1, q = m1 % L;
  const nf1 = [], nf2 = [];
  for (let k = p; ; k = (k + 1) % L) { nf1.push(ring[k]); if (k === q) break; }
  for (let k = q; ; k = (k + 1) % L) { nf2.push(ring[k]); if (k === p) break; }
  if (nf1.length < 3 || nf2.length < 3) return null;
  const out = polys.map((g, i) => i === f1 ? nf1 : i === f2 ? nf2 : g.slice());
  const pos = new Float32Array(P), src = new Int32Array(P.length / 3).map((_, i) => i);
  return { pos, polys: out, src, edge: [ring[p], ring[q]] };
}
// even out the vertices of the faces along the surface (inner vertices move to their neighbours' average,
// keeping to the faces' plane; border vertices of the selection stay)
export function relax(P, polys, sel, iters = 6) {
  const S = new Set(sel), inner = new Map(), nb = new Map();
  const vf = new Map(); polys.forEach((g, i) => { for (const v of g) (vf.get(v) || vf.set(v, []).get(v)).push(i); });
  for (const f of S) for (const v of polys[f]) if (vf.get(v).every(i => S.has(i))) inner.set(v, true);
  for (const v of inner.keys()) { const s = new Set(); for (const f of vf.get(v)) { const g = polys[f], k = g.indexOf(v); s.add(g[(k + 1) % g.length]); s.add(g[(k + g.length - 1) % g.length]); } nb.set(v, [...s]); }
  const pos = new Float32Array(P);
  for (let it = 0; it < iters; it++) {
    const nxt = new Map();
    for (const [v, list] of nb) {
      let x = 0, y = 0, z = 0; for (const u of list) { x += pos[u*3]; y += pos[u*3+1]; z += pos[u*3+2]; }
      x /= list.length; y /= list.length; z /= list.length;
      // keep the vertex on its own tangent plane
      let nx = 0, ny = 0, nz = 0; for (const f of vf.get(v)) { const n = polyNormal(pos, polys[f]); nx += n[0]; ny += n[1]; nz += n[2]; }
      const n = norm([nx, ny, nz]), d = (x - pos[v*3]) * n[0] + (y - pos[v*3+1]) * n[1] + (z - pos[v*3+2]) * n[2];
      nxt.set(v, [x - n[0] * d, y - n[1] * d, z - n[2] * d]);
    }
    for (const [v, p] of nxt) { pos[v*3] = p[0]; pos[v*3+1] = p[1]; pos[v*3+2] = p[2]; }
  }
  return { pos, count: nb.size };
}

// Faces hidden inside other closed pieces (a strap sunk into a box, a lid face resting on the body): every face
// whose centre, corners and edge midpoints (pulled 0.5% toward the centre), lifted `eps` off the face, all lie inside another
// closed piece. Pieces = the connected parts of this mesh (vertices shared) plus `others` ([{ pos, idx }]
// triangle meshes, assumed closed). Inside = odd ray crossings for at least 2 of 3 directions.
// Returns the face indices (for deleteFaces).
export function hiddenFaces(P, polys, others = [], eps = 0) {
  const nV = P.length / 3, par = Int32Array.from({ length: nV }, (_, i) => i);
  const find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (const f of polys) for (let k = 1; k < f.length; k++) { const a = find(f[0]), b = find(f[k]); if (a !== b) par[b] = a; }
  const comp = polys.map(f => find(f[0]));
  // closed pieces as flat triangle arrays (+ bounds)
  const solids = [];
  const addSolid = (id, tri) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tri.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], tri[i+k]); mx[k] = Math.max(mx[k], tri[i+k]); }
    solids.push({ id, tri: Float64Array.from(tri), mn, mx });
  };
  const byComp = new Map(); polys.forEach((f, i) => { const c = comp[i]; if (!byComp.has(c)) byComp.set(c, []); byComp.get(c).push(i); });
  const adj = adjacency(polys);
  for (const [c, fs] of byComp) {
    let closed = true; for (const i of fs) { const f = polys[i]; for (let k = 0; k < f.length; k++) if ((adj.get(ek(f[k], f[(k + 1) % f.length])) || []).length !== 2) closed = false; }
    if (!closed) continue;
    const tri = []; for (const i of fs) { const f = polys[i]; for (let k = 1; k + 1 < f.length; k++) for (const v of [f[0], f[k], f[k + 1]]) tri.push(P[v*3], P[v*3+1], P[v*3+2]); }
    addSolid(c, tri);
  }
  others.forEach((o, j) => { const tri = []; for (const v of o.idx) tri.push(o.pos[v*3], o.pos[v*3+1], o.pos[v*3+2]); addSolid(-1 - j, tri); });
  if (!solids.length) return [];
  if (!(eps > 0)) { let mn = Infinity, mx = -Infinity; for (let i = 0; i < P.length; i++) { mn = Math.min(mn, P[i]); mx = Math.max(mx, P[i]); } eps = Math.max(1e-6, (mx - mn) * 1e-3); }
  const dirs = [[0.5773, 0.5791, 0.5753], [-0.7071, 0.0123, 0.7071], [0.0157, -0.9998, 0.0091]];
  const crossings = (s, o, d) => {   // Moller-Trumbore, count hits with t > 0
    let n = 0; const T = s.tri;
    for (let i = 0; i < T.length; i += 9) {
      const e1x = T[i+3] - T[i], e1y = T[i+4] - T[i+1], e1z = T[i+5] - T[i+2], e2x = T[i+6] - T[i], e2y = T[i+7] - T[i+1], e2z = T[i+8] - T[i+2];
      const px = d[1]*e2z - d[2]*e2y, py = d[2]*e2x - d[0]*e2z, pz = d[0]*e2y - d[1]*e2x, det = e1x*px + e1y*py + e1z*pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det, tx = o[0] - T[i], ty = o[1] - T[i+1], tz = o[2] - T[i+2], u = (tx*px + ty*py + tz*pz) * inv; if (u < 0 || u > 1) continue;
      const qx = ty*e1z - tz*e1y, qy = tz*e1x - tx*e1z, qz = tx*e1y - ty*e1x, v = (d[0]*qx + d[1]*qy + d[2]*qz) * inv; if (v < 0 || u + v > 1) continue;
      if ((e2x*qx + e2y*qy + e2z*qz) * inv > 0) n++;
    }
    return n;
  };
  const inside = (o, own) => solids.some(s => {
    if (s.id === own) return false;
    for (let k = 0; k < 3; k++) if (o[k] < s.mn[k] - 1e-9 || o[k] > s.mx[k] + 1e-9) return false;
    let odd = 0; for (const d of dirs) if (crossings(s, o, d) & 1) odd++;
    return odd >= 2;
  });
  const out = [];
  polys.forEach((f, i) => {
    const n = norm(polyNormal(P, f)), c = polyCenter(P, f), pts = [c];
    for (let j = 0; j < f.length; j++) {   // corners and edge midpoints, pulled 0.5% toward the centre
      const a = f[j], b = f[(j + 1) % f.length];
      pts.push([0, 1, 2].map(k => P[a*3+k] + (c[k] - P[a*3+k]) * 0.005), [0, 1, 2].map(k => (P[a*3+k] + P[b*3+k]) / 2 + (c[k] - (P[a*3+k] + P[b*3+k]) / 2) * 0.005));
    }
    if (pts.every(p => inside([p[0] + n[0] * eps, p[1] + n[1] * eps, p[2] + n[2] * eps], comp[i]))) out.push(i);
  });
  return out;
}

// Normals split at crease edges (hard edges of a subdivided hard-surface part): the corners of faces that meet
// across an edge that is not creased share one normal (area-weighted face normals), so creased edges stay sharp
// in exports and bakes. faces: polygons (vertex index arrays, triangles or quads); isCrease(a, b) for an edge.
// Returns { corner: Int32Array (normal index per face corner, faces in order), normals: Float32Array }.
export function creaseNormals(P, faces, isCrease) {
  let nc = 0; const off = new Int32Array(faces.length + 1);
  faces.forEach((f, i) => { off[i] = nc; nc += f.length; }); off[faces.length] = nc;
  const par = new Int32Array(nc); for (let i = 0; i < nc; i++) par[i] = i;
  const find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const join = (x, y) => { x = find(x); y = find(y); if (x !== y) par[y] = x; };
  const nV = P.length / 3, open = new Map();   // undirected edge -> corner index of its first end in the first face
  faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length], key = a < b ? a * nV + b : b * nV + a;
      const ca = off[i] + k, cb = off[i] + (k + 1) % f.length, o = open.get(key);
      if (o === undefined) { open.set(key, [ca, cb, a]); continue; }
      open.delete(key);   // (a third face on the edge starts over: non-manifold edges stay split)
      if (isCrease(a, b)) continue;
      if (o[2] === a) { join(o[0], ca); join(o[1], cb); } else { join(o[0], cb); join(o[1], ca); }
    }
  });
  // every corner of a vertex not joined to another face still gets its face's normal; group sums
  const sum = new Float64Array(nc * 3);
  faces.forEach((f, i) => {
    let x = 0, y = 0, z = 0;   // Newell (area weighted)
    for (let k = 0; k < f.length; k++) {
      const a = f[k] * 3, b = f[(k + 1) % f.length] * 3;
      x += (P[a+1] - P[b+1]) * (P[a+2] + P[b+2]); y += (P[a+2] - P[b+2]) * (P[a] + P[b]); z += (P[a] - P[b]) * (P[a+1] + P[b+1]);
    }
    for (let k = 0; k < f.length; k++) { const r = find(off[i] + k) * 3; sum[r] += x; sum[r+1] += y; sum[r+2] += z; }
  });
  const id = new Int32Array(nc).fill(-1), corner = new Int32Array(nc), out = [];
  for (let c = 0; c < nc; c++) {
    const r = find(c);
    if (id[r] < 0) { id[r] = out.length / 3; const l = Math.hypot(sum[r*3], sum[r*3+1], sum[r*3+2]) || 1; out.push(sum[r*3] / l, sum[r*3+1] / l, sum[r*3+2] / l); }
    corner[c] = id[r];
  }
  return { corner, normals: Float32Array.from(out) };
}
