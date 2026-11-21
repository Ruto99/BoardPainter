// Field-aligned quad retopology, following Instant Field-Aligned Meshes
// (Jakob, Tarini, Panozzo, Sorkine-Hornung, SIGGRAPH Asia 2015):
//  1. uniform working mesh (voxel remesh) a few times denser than the target
//  2. 4-RoSy orientation field and an aligned position (lattice) field, smoothed on a multigrid hierarchy
//     - sharp edges / corners of the source constrain the fields (edge loops run along creases)
//     - symmetry: the fields are solved on the x >= 0 half with a seam constraint, then mirrored
//     - curvature: where the principal curvature directions are clearly anisotropic and coherent (limbs,
//       cylinders, folds) they constrain the orientation, so loops wrap around limbs like ZRemesher's
//  3. extraction: vertices sharing a lattice point merge; lattice neighbours become edges (at most one per
//     direction of the cross field); faces are traced around each vertex; triangle + pentagon pairs become two
//     quads, other n-gons are split into quads, triangle pairs merged into quads
//  4. cleanup: rows of quads ending in a triangle at both ends (dislocations of the lattice) are collapsed
//  5. relaxation along polygon edges (pure quads: on the coarse polygons first), snapping to the source surface /
//     sharp edges / corners
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { remesh, tryAccel, accelInfo } from './remesh.js';

const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const get = (A, i) => [A[i*3], A[i*3+1], A[i*3+2]];
const set3 = (A, i, v) => { A[i*3] = v[0]; A[i*3+1] = v[1]; A[i*3+2] = v[2]; };
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const tangentOf = (v, n) => { const d = v[0]*n[0] + v[1]*n[1] + v[2]*n[2]; return [v[0] - n[0]*d, v[1] - n[1]*d, v[2] - n[2]*d]; };

function buildNeighbors(n, idx) {
  const start = new Uint32Array(n + 1), seen = new Int32Array(n).fill(-1);
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1] += 2;
  for (let v = 0; v < n; v++) start[v + 1] += start[v];
  const raw = new Uint32Array(start[n]), fill = start.slice(0, n);
  for (let f = 0; f < idx.length; f += 3) for (let k = 0; k < 3; k++) { const a = idx[f+k]; raw[fill[a]++] = idx[f+(k+1)%3]; raw[fill[a]++] = idx[f+(k+2)%3]; }
  const os = new Uint32Array(n + 1), out = [];
  for (let v = 0; v < n; v++) { os[v] = out.length; for (let j = start[v]; j < start[v + 1]; j++) { const u = raw[j]; if (seen[u] !== v) { seen[u] = v; out.push(u); } } }
  os[n] = out.length;
  return { start: os, list: Uint32Array.from(out) };
}
function vertexNormals(p, ix) {
  const n = new Float32Array(p.length);
  for (let f = 0; f < ix.length; f += 3) {
    const a = ix[f]*3, b = ix[f+1]*3, c = ix[f+2]*3;
    const ux = p[b]-p[a], uy = p[b+1]-p[a+1], uz = p[b+2]-p[a+2], wx = p[c]-p[a], wy = p[c+1]-p[a+1], wz = p[c+2]-p[a+2];
    const x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx;
    for (const t of [a, b, c]) { n[t] += x; n[t+1] += y; n[t+2] += z; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i+1], n[i+2]) || 1; n[i] /= l; n[i+1] /= l; n[i+2] /= l; }
  return n;
}

// ---------- principal curvature on the working mesh ----------
// Per-vertex shape operator by least squares (normal change along each edge ~ S * edge, in the tangent plane).
// Its traceless part is a line field z = |k1 - k2| / 2 * e^(2i phi) in the vertex's tangent frame (phi: direction
// of the larger signed curvature). Averages of z transport each direction into the local tangent plane first, so
// directions don't cancel around a tube. coh = |averaged z| / averaged |z|: 1 where the principal directions agree
// over the whole neighbourhood (cylinders, limbs, folds), small on noise and on bumps.
// The field is averaged over the multigrid hierarchy too, so coherence can be judged at any radius cheaply.
function curvFrames(N) {
  const n = N.length / 3, FU = new Float32Array(n * 3), FW = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const nn = get(N, v), u = norm(Math.abs(nn[0]) < 0.9 ? [0, -nn[2], nn[1]] : [nn[2], 0, -nn[0]]);
    set3(FU, v, u); set3(FW, v, cross(nn, u));
  }
  return { FU, FW };
}
// a direction (3D) as z in frame (u, w), with magnitude m
const lineZ = (D, o, FU, FW, p, m, out) => {
  const a = D[o]*FU[p*3] + D[o+1]*FU[p*3+1] + D[o+2]*FU[p*3+2], b = D[o]*FW[p*3] + D[o+1]*FW[p*3+1] + D[o+2]*FW[p*3+2], l2 = a*a + b*b;
  if (l2 < 1e-12) return false;
  out[0] += m * (a*a - b*b) / l2; out[1] += m * 2*a*b / l2; return true;
};
function curvDirs(C) {
  const n = C.H.length, D = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const ph = Math.atan2(C.Z[v*2+1], C.Z[v*2]) / 2, c = Math.cos(ph), sn = Math.sin(ph);
    for (let k = 0; k < 3; k++) D[v*3+k] = C.FU[v*3+k] * c + C.FW[v*3+k] * sn;
  }
  return D;
}
function curvSmooth(C, adj, iters) {
  const n = C.H.length, acc = [0, 0];
  for (let it = 0; it < iters; it++) {
    const D = curvDirs(C), Z2 = new Float32Array(n * 2), H2 = new Float32Array(n), R2 = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      acc[0] = C.Z[v*2]; acc[1] = C.Z[v*2+1]; let h = C.H[v], r = C.R[v];
      for (let j = adj.start[v]; j < adj.start[v + 1]; j++) {
        const t = adj.list[j]; h += C.H[t]; r += C.R[t];
        const m = Math.hypot(C.Z[t*2], C.Z[t*2+1]); if (m > 0) lineZ(D, t * 3, C.FU, C.FW, v, m, acc);
      }
      const k = adj.start[v + 1] - adj.start[v] + 1;
      Z2[v*2] = acc[0] / k; Z2[v*2+1] = acc[1] / k; H2[v] = h / k; R2[v] = r / k;
    }
    C.Z = Z2; C.H = H2; C.R = R2;
  }
}
function curvatureBase(V, N, adj) {
  const n = V.length / 3, { FU, FW } = curvFrames(N);
  const Z = new Float32Array(n * 2), H = new Float32Array(n), R = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const u = get(FU, v), w = get(FW, v), nx = N[v*3], ny = N[v*3+1], nz = N[v*3+2];
    let a00 = 0, a01 = 0, a11 = 0, b00 = 0, b01 = 0, b10 = 0, b11 = 0;
    for (let j = adj.start[v]; j < adj.start[v + 1]; j++) {
      const t = adj.list[j];
      const ex = V[t*3]-V[v*3], ey = V[t*3+1]-V[v*3+1], ez = V[t*3+2]-V[v*3+2];
      const dx = N[t*3]-nx, dy = N[t*3+1]-ny, dz = N[t*3+2]-nz;
      const e0 = ex*u[0] + ey*u[1] + ez*u[2], e1 = ex*w[0] + ey*w[1] + ez*w[2];
      const d0 = dx*u[0] + dy*u[1] + dz*u[2], d1 = dx*w[0] + dy*w[1] + dz*w[2];
      a00 += e0*e0; a01 += e0*e1; a11 += e1*e1;
      b00 += d0*e0; b01 += d0*e1; b10 += d1*e0; b11 += d1*e1;
    }
    const det = a00*a11 - a01*a01;
    if (!(Math.abs(det) > 1e-24)) continue;
    const i00 = a11/det, i01 = -a01/det, i11 = a00/det;   // S = B A^-1, symmetrized
    const m00 = b00*i00 + b01*i01, m11 = b10*i01 + b11*i11, m01 = ((b00*i01 + b01*i11) + (b10*i00 + b11*i01)) / 2;
    H[v] = (m00 + m11) / 2; Z[v*2] = (m00 - m11) / 2; Z[v*2+1] = m01; R[v] = Math.hypot(Z[v*2], Z[v*2+1]);
  }
  return { FU, FW, Z, H, R };
}
// the field on every hierarchy level: children averaged into their parent (directions transported), then smoothed
// `iters` times on that level. Returns per level { FU, FW, Z, H, R, el (mean edge length) }.
function curvatureLevels(levels, iters0, iters, judge) {
  const meanEdge = L => { let e = 0; for (let v = 0; v < L.V.length / 3; v++) for (let j = L.adj.start[v]; j < L.adj.start[v + 1]; j++) e += Math.sqrt(dist2(L.V, v, L.adj.list[j])); return e / (L.adj.list.length || 1); };
  const C0 = curvatureBase(levels[0].V, levels[0].N, levels[0].adj);
  curvSmooth(C0, levels[0].adj, iters0);
  C0.el = meanEdge(levels[0]);
  const out = [C0];
  for (let l = 1; l < levels.length; l++) {
    const lo = levels[l - 1], Cl = out[l - 1], m = levels[l].V.length / 3, { FU, FW } = curvFrames(levels[l].N);
    const Z = new Float64Array(m * 2), H = new Float32Array(m), R = new Float32Array(m), cnt = new Float32Array(m), D = curvDirs(Cl), acc = [0, 0];
    for (let v = 0; v < Cl.H.length; v++) {
      const p = lo.parent[v]; cnt[p]++; H[p] += Cl.H[v]; R[p] += Cl.R[v];
      const mm = Math.hypot(Cl.Z[v*2], Cl.Z[v*2+1]);
      if (mm > 0) { acc[0] = acc[1] = 0; if (lineZ(D, v * 3, FU, FW, p, mm, acc)) { Z[p*2] += acc[0]; Z[p*2+1] += acc[1]; } }
    }
    for (let p = 0; p < m; p++) { const c = cnt[p] || 1; Z[p*2] /= c; Z[p*2+1] /= c; H[p] /= c; R[p] /= c; }
    const C = { FU, FW, Z: Float32Array.from(Z), H, R };
    curvSmooth(C, levels[l].adj, iters);
    C.el = meanEdge(levels[l]);
    out.push(C);
  }
  // judged copies: smoothed `judge` more times on each level (radius ~ el * sqrt(judge + iters))
  const J = out.map((C, l) => { const c = { FU: C.FU, FW: C.FW, Z: C.Z.slice(), H: C.H.slice(), R: C.R.slice(), el: C.el }; curvSmooth(c, levels[l].adj, judge); c.rad = C.el * Math.sqrt(judge + (l ? iters : iters0) + 1); return c; });
  return { chain: out, judge: J };
}

// ---------- sharp features of the source (creases between faces > angle, corners where >= 3 meet) ----------
function sharpFeatures(pos, idx, angleDeg, minLen = 0) {
  const nF = idx.length / 3, nV = pos.length / 3, fn = new Float32Array(nF * 3);
  for (let f = 0; f < nF; f++) {
    const a = idx[f*3]*3, b = idx[f*3+1]*3, c = idx[f*3+2]*3;
    set3(fn, f, norm(cross([pos[b]-pos[a], pos[b+1]-pos[a+1], pos[b+2]-pos[a+2]], [pos[c]-pos[a], pos[c+1]-pos[a+1], pos[c+2]-pos[a+2]])));
  }
  const cosA = Math.cos(angleDeg * Math.PI / 180), first = new Map(), edges = [], segs = [], deg = new Map();
  for (let f = 0; f < nF; f++) for (let k = 0; k < 3; k++) {
    const a = idx[f*3+k], b = idx[f*3+(k+1)%3], key = a < b ? a * nV + b : b * nV + a, g = first.get(key);
    if (g === undefined) { first.set(key, f); continue; }
    if (fn[f*3]*fn[g*3] + fn[f*3+1]*fn[g*3+1] + fn[f*3+2]*fn[g*3+2] < cosA) edges.push(a, b);
  }
  // connected crease chains shorter than minLen are dropped: on organic shapes they are the narrow valleys where
  // limbs join (armpits, crotch), not creases, and loops cannot follow a crease shorter than a couple of quads
  let keep = null;
  if (minLen > 0 && edges.length) {
    const par = new Map(), find = x => { let r = x; while (par.get(r) !== r) r = par.get(r); while (par.get(x) !== r) { const n = par.get(x); par.set(x, r); x = n; } return r; };
    for (const v of edges) if (!par.has(v)) par.set(v, v);
    for (let e = 0; e < edges.length; e += 2) { const x = find(edges[e]), y = find(edges[e+1]); if (x !== y) par.set(x, y); }
    const len = new Map();
    for (let e = 0; e < edges.length; e += 2) { const a = edges[e], b = edges[e+1], r = find(a); len.set(r, (len.get(r) || 0) + Math.sqrt(dist2(pos, a, b))); }
    keep = e => len.get(find(edges[e])) >= minLen;
  }
  for (let e = 0; e < edges.length; e += 2) {
    if (keep && !keep(e)) continue;
    const a = edges[e], b = edges[e+1];
    segs.push(pos[a*3], pos[a*3+1], pos[a*3+2], pos[b*3], pos[b*3+1], pos[b*3+2]);
    deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1);
  }
  const corners = [];
  for (const [v, d] of deg) if (d >= 3) corners.push(pos[v*3], pos[v*3+1], pos[v*3+2]);
  return { segs: new Float32Array(segs), corners: new Float32Array(corners) };
}
// polygroup borders as features: per-vertex groups, so the border runs through the triangles whose corners
// differ (between edge midpoints); where three groups meet there is a corner at the triangle's center
function groupFeatures(pos, idx, groups) {
  // border graph: nodes are edge midpoints (key = edge) and triple-junction centers (key = face); the raw path
  // zigzags across the triangles, so it is chained and smoothed before its directions steer the field
  const nV = pos.length / 3, P = new Map(), adj = new Map(), fixed = new Set();
  const ekey = (a, b) => a < b ? a * nV + b : b * nV + a;
  const node = (k, p) => { if (!P.has(k)) { P.set(k, p); adj.set(k, []); } return k; };
  const mid = (a, b) => node(ekey(a, b), [(pos[a*3] + pos[b*3]) / 2, (pos[a*3+1] + pos[b*3+1]) / 2, (pos[a*3+2] + pos[b*3+2]) / 2]);
  const link = (x, y) => { adj.get(x).push(y); adj.get(y).push(x); };
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f+1], c = idx[f+2], ga = groups[a], gb = groups[b], gc = groups[c];
    if (ga === gb && gb === gc) continue;
    if (ga !== gb && gb !== gc && ga !== gc) {
      const k = node(-1 - f / 3, [(pos[a*3] + pos[b*3] + pos[c*3]) / 3, (pos[a*3+1] + pos[b*3+1] + pos[c*3+1]) / 3, (pos[a*3+2] + pos[b*3+2] + pos[c*3+2]) / 3]);
      fixed.add(k);
      for (const [x, y] of [[a, b], [b, c], [c, a]]) link(k, mid(x, y));
      continue;
    }
    const odd = ga === gb ? c : gb === gc ? a : b, [x, y] = odd === a ? [b, c] : odd === b ? [c, a] : [a, b];
    link(mid(odd, x), mid(odd, y));
  }
  for (let it = 0; it < 10; it++) {
    const next = new Map();
    for (const [k, nb] of adj) {
      if (fixed.has(k) || nb.length !== 2) continue;
      const p = P.get(k), q = P.get(nb[0]), r = P.get(nb[1]);
      next.set(k, [p[0] * 0.5 + (q[0] + r[0]) * 0.25, p[1] * 0.5 + (q[1] + r[1]) * 0.25, p[2] * 0.5 + (q[2] + r[2]) * 0.25]);
    }
    for (const [k, p] of next) P.set(k, p);
  }
  const segs = [], corners = [];
  for (const [k, nb] of adj) for (const j of nb) if (k < j) segs.push(...P.get(k), ...P.get(j));
  for (const k of fixed) corners.push(...P.get(k));
  return { segs, corners };
}
// spatial hash over segments / points for nearest queries
class FeatureIndex {
  constructor(F, cell) {
    this.F = F; this.cell = cell; this.grid = new Map(); this.cgrid = new Map();
    const S = F.segs, k = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let s = 0; s < S.length / 6; s++) {
      const o = s * 6, steps = Math.max(1, Math.ceil(Math.hypot(S[o+3]-S[o], S[o+4]-S[o+1], S[o+5]-S[o+2]) / cell));
      const keys = new Set();
      for (let i = 0; i <= steps; i++) { const t = i / steps; keys.add(k(S[o] + (S[o+3]-S[o])*t, S[o+1] + (S[o+4]-S[o+1])*t, S[o+2] + (S[o+5]-S[o+2])*t)); }
      for (const kk of keys) (this.grid.get(kk) || this.grid.set(kk, []).get(kk)).push(s);
    }
    const C = F.corners;
    for (let c = 0; c < C.length / 3; c++) { const kk = k(C[c*3], C[c*3+1], C[c*3+2]); (this.cgrid.get(kk) || this.cgrid.set(kk, []).get(kk)).push(c); }
  }
  near(grid, p, fn) {
    const c = this.cell, x = Math.floor(p[0] / c), y = Math.floor(p[1] / c), z = Math.floor(p[2] / c);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) { const l = grid.get(`${x+a},${y+b},${z+d}`); if (l) for (const i of l) fn(i); }
  }
  closestSeg(p, maxD) {
    const S = this.F.segs; let best = null, bd = maxD;
    this.near(this.grid, p, s => {
      const o = s * 6, d = [S[o+3]-S[o], S[o+4]-S[o+1], S[o+5]-S[o+2]], l2 = d[0]*d[0] + d[1]*d[1] + d[2]*d[2] || 1;
      const t = Math.max(0, Math.min(1, ((p[0]-S[o])*d[0] + (p[1]-S[o+1])*d[1] + (p[2]-S[o+2])*d[2]) / l2));
      const q = [S[o] + d[0]*t, S[o+1] + d[1]*t, S[o+2] + d[2]*t], dist = Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]);
      if (dist < bd) { bd = dist; best = { point: q, dir: norm(d), dist }; }
    });
    return best;
  }
  closestCorner(p, maxD) {
    const C = this.F.corners; let best = null, bd = maxD;
    this.near(this.cgrid, p, c => { const q = [C[c*3], C[c*3+1], C[c*3+2]], d = Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]); if (d < bd) { bd = d; best = { point: q, dist: d }; } });
    return best;
  }
}

// ---------- multigrid hierarchy (greedy edge matching); constraints propagate to coarse levels ----------
function buildHierarchy(V, N, adj, con) {
  const levels = [{ V, N, adj, con, parent: null }];
  for (let depth = 0; depth < 24; depth++) {
    const L = levels[levels.length - 1], n = L.V.length / 3;
    if (n < 80) break;
    const parent = new Int32Array(n).fill(-1);
    let m = 0;
    for (let v = 0; v < n; v++) {
      if (parent[v] >= 0) continue;
      let best = -1, bs = -Infinity;
      for (let j = L.adj.start[v]; j < L.adj.start[v + 1]; j++) {
        const u = L.adj.list[j]; if (parent[u] >= 0) continue;
        const s = L.N[v*3]*L.N[u*3] + L.N[v*3+1]*L.N[u*3+1] + L.N[v*3+2]*L.N[u*3+2]; if (s > bs) { bs = s; best = u; }
      }
      parent[v] = m; if (best >= 0) parent[best] = m; m++;
    }
    if (m > n * 0.85) break;
    const cV = new Float32Array(m * 3), cN = new Float32Array(m * 3), cnt = new Float32Array(m);
    const cc = { fq: new Uint8Array(m), fo: new Uint8Array(m), fx: new Uint8Array(m), q: new Float32Array(m * 3), o: new Float32Array(m * 3) };
    for (let v = 0; v < n; v++) {
      const p = parent[v]; cnt[p]++;
      for (let k = 0; k < 3; k++) { cV[p*3+k] += L.V[v*3+k]; cN[p*3+k] += L.N[v*3+k]; }
      if (L.con.fq[v] && !cc.fq[p]) { cc.fq[p] = 1; for (let k = 0; k < 3; k++) cc.q[p*3+k] = L.con.q[v*3+k]; }
      if (L.con.fo[v] && !cc.fo[p]) { cc.fo[p] = 1; for (let k = 0; k < 3; k++) cc.o[p*3+k] = L.con.o[v*3+k]; }
      if (L.con.fx[v]) cc.fx[p] = 1;
    }
    for (let p = 0; p < m; p++) { for (let k = 0; k < 3; k++) cV[p*3+k] /= cnt[p]; set3(cN, p, norm(get(cN, p))); }
    // constrained orientations must lie in the coarse tangent plane
    for (let p = 0; p < m; p++) if (cc.fq[p]) set3(cc.q, p, norm(tangentOf(get(cc.q, p), get(cN, p))));
    const sets = Array.from({ length: m }, () => new Set());
    for (let v = 0; v < n; v++) for (let j = L.adj.start[v]; j < L.adj.start[v + 1]; j++) { const a = parent[v], b = parent[L.adj.list[j]]; if (a !== b) sets[a].add(b); }
    const st = new Uint32Array(m + 1), list = [];
    for (let p = 0; p < m; p++) { st[p] = list.length; for (const b of sets[p]) list.push(b); }
    st[m] = list.length;
    L.parent = parent;
    levels.push({ V: cV, N: cN, adj: { start: st, list: Uint32Array.from(list) }, con: cc, parent: null });
  }
  return levels;
}

// ---------- fields ----------
function compatOrient(q0, n0, q1, n1) {
  const A = [q0, cross(n0, q0)], B = [q1, cross(n1, q1)];
  let best = -1, bi = 0, bj = 0, sgn = 1;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const d = A[i][0]*B[j][0] + A[i][1]*B[j][1] + A[i][2]*B[j][2];
    if (Math.abs(d) > best) { best = Math.abs(d); bi = i; bj = j; sgn = d < 0 ? -1 : 1; }
  }
  return [A[bi], [B[bj][0]*sgn, B[bj][1]*sgn, B[bj][2]*sgn]];
}
// visiting order: a fixed random permutation (scan order biases the fields along the voxel grid)
function order(n, seed) {
  const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = i;
  let r = seed >>> 0 || 1;
  for (let i = n - 1; i > 0; i--) { r = (r * 1664525 + 1013904223) >>> 0; const j = r % (i + 1); const t = o[i]; o[i] = o[j]; o[j] = t; }
  return o;
}
const f32 = a => a instanceof Float32Array ? a : Float32Array.from(a);
// native field smoothing runs on all cores (graph-coloured Gauss-Seidel); off = the exact JavaScript visiting order
export const PARALLEL = { on: true };

function smoothOrientations(L, Q, iters, shuffle) {
  const nat = tryAccel('smoothOrient', [f32(L.N), Q, L.adj.start, L.adj.list, L.con.fq, iters, !!shuffle, PARALLEL.on]);
  if (nat) { Q.set(nat); return; }
  const n = L.V.length / 3, ord = shuffle ? order(n, 7) : null;
  for (let it = 0; it < iters; it++) for (let ii = 0; ii < n; ii++) {
    const i = ord ? ord[ii] : ii;
    if (L.con.fq[i]) continue;
    const ni = get(L.N, i); let q = get(Q, i), ws = 0;
    for (let j = L.adj.start[i]; j < L.adj.start[i + 1]; j++) {
      const u = L.adj.list[j], w = L.con.fq[u] ? 4 : 1;   // constraints pull harder
      const [a, b] = compatOrient(q, ni, get(Q, u), get(L.N, u));
      q = norm(tangentOf([a[0]*ws + b[0]*w, a[1]*ws + b[1]*w, a[2]*ws + b[2]*w], ni));
      ws += w;
    }
    set3(Q, i, q);
  }
}
function lattice(o, q, n, p, s, round) {
  const t = cross(n, q), d = [p[0]-o[0], p[1]-o[1], p[2]-o[2]], f = round ? Math.round : Math.floor;
  const a = f((d[0]*q[0] + d[1]*q[1] + d[2]*q[2]) / s), b = f((d[0]*t[0] + d[1]*t[1] + d[2]*t[2]) / s);
  return [o[0] + (q[0]*a + t[0]*b)*s, o[1] + (q[1]*a + t[1]*b)*s, o[2] + (q[2]*a + t[2]*b)*s];
}
function middlePoint(p0, n0, p1, n1) {
  const n0p0 = n0[0]*p0[0]+n0[1]*p0[1]+n0[2]*p0[2], n0p1 = n0[0]*p1[0]+n0[1]*p1[1]+n0[2]*p1[2];
  const n1p0 = n1[0]*p0[0]+n1[1]*p0[1]+n1[2]*p0[2], n1p1 = n1[0]*p1[0]+n1[1]*p1[1]+n1[2]*p1[2];
  const n0n1 = n0[0]*n1[0]+n0[1]*n1[1]+n0[2]*n1[2], den = 1 / (1 - n0n1*n0n1 + 1e-4);
  const l0 = 2 * (n0p1 - n0p0 - n0n1 * (n1p0 - n1p1)) * den, l1 = 2 * (n1p0 - n1p1 - n0n1 * (n0p1 - n0p0)) * den;
  return [0.5*(p0[0]+p1[0]) - 0.25*(n0[0]*l0 + n1[0]*l1), 0.5*(p0[1]+p1[1]) - 0.25*(n0[1]*l0 + n1[1]*l1), 0.5*(p0[2]+p1[2]) - 0.25*(n0[2]*l0 + n1[2]*l1)];
}
function compatPos(p0, n0, q0, o0, p1, n1, q1, o1, s) {
  const t0 = cross(n0, q0), t1 = cross(n1, q1), m = middlePoint(p0, n0, p1, n1);
  const a0 = lattice(o0, q0, n0, m, s, false), a1 = lattice(o1, q1, n1, m, s, false);
  let best = Infinity, r0 = null, r1 = null;
  for (let i = 0; i < 4; i++) {
    const c0 = [a0[0] + ((i&1)*q0[0] + ((i>>1)&1)*t0[0])*s, a0[1] + ((i&1)*q0[1] + ((i>>1)&1)*t0[1])*s, a0[2] + ((i&1)*q0[2] + ((i>>1)&1)*t0[2])*s];
    for (let j = 0; j < 4; j++) {
      const c1 = [a1[0] + ((j&1)*q1[0] + ((j>>1)&1)*t1[0])*s, a1[1] + ((j&1)*q1[1] + ((j>>1)&1)*t1[1])*s, a1[2] + ((j&1)*q1[2] + ((j>>1)&1)*t1[2])*s];
      const d = (c0[0]-c1[0])**2 + (c0[1]-c1[1])**2 + (c0[2]-c1[2])**2;
      if (d < best) { best = d; r0 = c0; r1 = c1; }
    }
  }
  return [r0, r1];
}
// SC: per-vertex spacing multiplier (density painting) or null; a pair of vertices uses the mean of their spacings
function smoothPositions(L, Q, O, s, iters, shuffle) {
  const SC = L.SC || null;
  const nat = SC ? tryAccel('smoothPosScaled', [f32(L.V), f32(L.N), Q, O, L.adj.start, L.adj.list, L.con.fo, L.con.fx, s, iters, !!shuffle, PARALLEL.on, SC])
                 : tryAccel('smoothPos', [f32(L.V), f32(L.N), Q, O, L.adj.start, L.adj.list, L.con.fo, L.con.fx, s, iters, !!shuffle, PARALLEL.on]);
  if (nat) { O.set(nat); return; }
  const n = L.V.length / 3, ord = shuffle ? order(n, 13) : null;
  for (let it = 0; it < iters; it++) for (let ii = 0; ii < n; ii++) {
    const i = ord ? ord[ii] : ii;
    if (L.con.fo[i]) continue;
    const vi = get(L.V, i), ni = get(L.N, i), qi = get(Q, i);
    let o = get(O, i), ws = 0;
    for (let j = L.adj.start[i]; j < L.adj.start[i + 1]; j++) {
      const u = L.adj.list[j], w = L.con.fo[u] ? 4 : 1;
      const [a, b] = compatPos(vi, ni, qi, o, get(L.V, u), get(L.N, u), get(Q, u), get(O, u), SC ? s * (SC[i] + SC[u]) / 2 : s);
      o = [(a[0]*ws + b[0]*w) / (ws + w), (a[1]*ws + b[1]*w) / (ws + w), (a[2]*ws + b[2]*w) / (ws + w)];
      ws += w;
      const d = (o[0]-vi[0])*ni[0] + (o[1]-vi[1])*ni[1] + (o[2]-vi[2])*ni[2];
      o = [o[0] - ni[0]*d, o[1] - ni[1]*d, o[2] - ni[2]*d];
    }
    o = lattice(o, qi, ni, vi, SC ? s * SC[i] : s, true);
    if (L.con.fx[i]) o = onPlane(o, qi, cross(ni, qi));
    set3(O, i, o);
  }
}
// move a lattice point along the lattice direction most aligned with x so that it lies on x = 0
function onPlane(o, q, t) {
  const d = Math.abs(q[0]) >= Math.abs(t[0]) ? q : t;
  return Math.abs(d[0]) > 1e-3 ? [o[0] - d[0] * o[0] / d[0], o[1] - d[1] * o[0] / d[0], o[2] - d[2] * o[0] / d[0]] : o;
}

// ---------- polygon helpers ----------
const dist2 = (P, a, b) => (P[a*3]-P[b*3])**2 + (P[a*3+1]-P[b*3+1])**2 + (P[a*3+2]-P[b*3+2])**2;
function quadQuality(P, f) {   // worst corner angle deviation from 90 deg (radians)
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const a = f[(k+3)%4], b = f[k], c = f[(k+1)%4];
    const u = norm([P[a*3]-P[b*3], P[a*3+1]-P[b*3+1], P[a*3+2]-P[b*3+2]]), v = norm([P[c*3]-P[b*3], P[c*3+1]-P[b*3+1], P[c*3+2]-P[b*3+2]]);
    worst = Math.max(worst, Math.abs(Math.acos(Math.max(-1, Math.min(1, u[0]*v[0] + u[1]*v[1] + u[2]*v[2]))) - Math.PI / 2));
  }
  return worst;
}

// Make the polygon set a closed manifold: at most two faces per edge (one on the symmetry seam, whose other
// side is the mirror copy), and every remaining hole closed: one polygon in pure-quad mode (split through its
// centre below), else a fan of quads (and a triangle if the count is odd).
// Faces earlier in the list win when an edge is over-used, so the polygons added to fill holes go first.
function repairSurface(faces, seamV, pure, orient) {
  const ek = (a, b) => a < b ? a * 1e7 + b : b * 1e7 + a;
  const seamE = (a, b) => seamV(a) && seamV(b);
  for (let pass = 0; pass < 8; pass++) {
    const use = new Map(), keep = [];
    for (const f of faces) {
      const keys = f.map((v, k) => ek(v, f[(k + 1) % f.length]));
      if (f.some((v, k) => (use.get(keys[k]) || 0) >= (seamE(v, f[(k + 1) % f.length]) ? 1 : 2))) continue;
      for (const k of keys) use.set(k, (use.get(k) || 0) + 1);
      keep.push(f);
    }
    faces = keep;
    // consistent winding from geometry: a face whose normal disagrees with the field's normals at its corners
    // (relative to how most faces are wound) is reversed. Local, so one bad spot can't flip a whole region.
    {
      if (orient) {
        const sg = faces.map(orient), maj = sg.reduce((n, x) => n + Math.sign(x), 0) >= 0 ? 1 : -1;
        faces = faces.map((f, i) => sg[i] * maj < 0 ? f.slice().reverse() : f);
      }
      // faces that still disagree with a neighbour sit in a fold: drop them, the hole is filled next pass
      const dir = new Map(), bad = new Set();
      faces.forEach((f, i) => f.forEach((v, k) => { const key = v * 1e7 + f[(k + 1) % f.length]; if (dir.has(key)) { bad.add(i); bad.add(dir.get(key)); } else dir.set(key, i); }));
      if (bad.size) { faces = faces.filter((_, i) => !bad.has(i)); continue; }
    }
    // boundary half-edges b -> a (reverse of a face edge a -> b that no other face shares), seam edges excluded
    const out = new Map();
    let nb = 0;
    for (const f of faces) for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (use.get(ek(a, b)) !== 1 || seamE(a, b)) continue;
      (out.get(b) || out.set(b, []).get(b)).push(a); nb++;
    }
    if (!nb) break;
    const used = new Set(), fills = [];
    const emit = loop => {
      if (loop.length < 3) return;
      if (loop.length <= 4 || pure) fills.push(loop.slice());   // pure quads: split later through its centre
      else for (const q of fanSplit(loop, use)) fills.push(q);
    };
    // start on the seam first, so holes touching it become open paths seam -> seam (closed along the seam)
    const starts = [...out.keys()].sort((x, y) => (seamV(y) ? 1 : 0) - (seamV(x) ? 1 : 0));
    for (const st of starts) for (const first of out.get(st)) {
      if (used.has(st * 1e7 + first)) continue;
      used.add(st * 1e7 + first);
      const path = [st], at = new Map([[st, 0]]);
      let v = first;
      for (let steps = 0; steps < 4096; steps++) {
        if (at.has(v)) {   // closed a loop (or a sub-loop at a pinch vertex): fill it and go on from v
          const loop = path.splice(at.get(v));
          for (const x of loop) at.delete(x);
          emit(loop);
        }
        at.set(v, path.length); path.push(v);
        const nx = (out.get(v) || []).filter(w => !used.has(v * 1e7 + w));
        if (!nx.length) {
          // a path that left the seam and came back: its closing edge lies on the mirror plane
          if (path.length >= 3 && seamV(path[0]) && seamV(v)) emit(path.slice());
          break;
        }
        const w = nx.includes(path[0]) ? path[0] : nx[0];
        used.add(v * 1e7 + w); v = w;
      }
    }
    if (!fills.length) break;
    faces = faces.concat(fills);
  }
  if (!pure && faces.some(f => f.length > 4)) {   // quads and triangles only from here on
    const use = new Map();
    for (const f of faces) f.forEach((v, k) => use.set(ek(v, f[(k + 1) % f.length]), 1));
    faces = faces.flatMap(f => f.length > 4 ? fanSplit(f, use) : [f]);
  }
  return faces;
}
// Triangles of a quad-dominant mesh are where an edge loop ends (position-field dislocations). A triangle T1, a
// straight row of k quads (entered and left through opposite edges) and a triangle T2 are a finite extra row: rails
// u_0..u_k and v_0..v_k joined by rungs (u_i, v_i), closed by the apexes a and b. Collapsing every rung (v_i merges
// into u_i) removes the row; its neighbours take up the space, so the poles go away for a gentle size change
// (the trade ZRemesher makes). Done only when it lowers the irregularity (sum of |valence - 4| over the vertices
// involved, minus triW per triangle removed), rows shortest first, up to maxLen quads. Faces must be consistently
// wound and manifold; the result is too. P: positions (merged rungs move to their midpoints).
// fixed(v): vertices that must not merge (seam, creases, corners).
function collapseRows(faces, P, maxLen, fixed, triW) {
  const ek = (a, b) => a < b ? a * 1e7 + b : b * 1e7 + a;
  const rot = (f, v) => { const k = f.indexOf(v); return f.map((_, i) => f[(k + i) % f.length]); };
  const irr = d => Math.abs(d - 4);
  for (let pass = 0; pass < 8; pass++) {
    const ef = new Map(), val = new Map(), vf = new Map();
    faces.forEach((f, i) => f.forEach((v, k) => {
      (vf.get(v) || vf.set(v, []).get(v)).push(i);
      const w = f[(k + 1) % f.length], key = ek(v, w), l = ef.get(key);
      if (l) l.push(i); else { ef.set(key, [i]); val.set(v, (val.get(v) || 0) + 1); val.set(w, (val.get(w) || 0) + 1); }
    }));
    const cands = [];
    faces.forEach((f, t) => {
      if (f.length !== 3) return;
      for (let k = 0; k < 3; k++) {
        const a = f[(k + 2) % 3]; let x = f[k], y = f[(k + 1) % 3];   // crossing edge x -> y in the current face
        const U = [x], V = [y], strip = [t]; let end = -1;
        for (let step = 0; step <= maxLen; step++) {
          const l = ef.get(ek(x, y)); if (!l || l.length !== 2) break;
          const g = l[0] === strip[strip.length - 1] ? l[1] : l[0], G = faces[g];
          if (strip.includes(g)) break;
          if (G.length === 3) { end = g; break; }
          if (G.length !== 4) break;
          const R = rot(G, y); if (R[1] !== x) break;    // inconsistent winding
          strip.push(g); x = R[2]; y = R[3]; U.push(x); V.push(y);   // R = [v_{i-1}, u_{i-1}, u_i, v_i]
        }
        if (end < 0 || end <= t && strip.length === 1) continue;
        const T2 = rot(faces[end], y); if (T2[1] !== x) continue;
        cands.push({ all: strip.concat([end]), U, V, a, b: T2[2] });
      }
    });
    cands.sort((p, q) => p.all.length - q.all.length);
    const dead = new Set(), lock = new Set();
    for (const { all, U, V, a, b } of cands) {
      const K = U.length - 1;
      if (all.some(i => dead.has(i))) continue;
      const vs = new Set([a, b, ...U, ...V]); if (vs.size !== 2 * K + 4 || [...vs].some(v => lock.has(v))) continue;
      if (U.some(fixed) || V.some(fixed)) continue;
      // valence change: the apexes lose an edge, a merged rung vertex gets d(u) + d(v) - 4
      let gain = -2 * triW;
      for (const x of [a, b]) gain += irr(val.get(x) - 1) - irr(val.get(x));
      for (let i = 0; i <= K; i++) gain += irr(val.get(U[i]) + val.get(V[i]) - 4) - irr(val.get(U[i])) - irr(val.get(V[i]));
      if (gain >= 0) continue;
      // relabel v_i -> u_i in the faces around the row; reject if a face degenerates, two faces coincide or an
      // edge would get more than two faces
      const to = new Map(V.map((v, i) => [v, U[i]])), inRow = new Set(all), around = new Set();
      for (const v of [...U, ...V]) for (const fi of vf.get(v) || []) if (!inRow.has(fi)) around.add(fi);
      let ok = true; const nf = [], keys = new Set(), use = new Map(), ring = new Set(U);
      for (const fi of around) {
        const g = faces[fi].map(v => to.get(v) ?? v);
        if (new Set(g).size !== g.length) { ok = false; break; }
        const key = [...g].sort((x, y) => x - y).join(','); if (keys.has(key)) { ok = false; break; } keys.add(key);
        nf.push([fi, g]);
      }
      if (ok) for (const [, g] of nf) g.forEach((v, k) => {
        const w = g[(k + 1) % g.length]; if (!ring.has(v) && !ring.has(w)) return;
        const kk = ek(v, w), c = (use.get(kk) || 0) + 1; use.set(kk, c); if (c > 2) ok = false;
      });
      if (!ok) continue;
      for (const i of all) dead.add(i);
      for (const [fi, g] of nf) faces[fi] = g;
      for (let i = 0; i <= K; i++) for (let d = 0; d < 3; d++) P[U[i]*3+d] = (P[U[i]*3+d] + P[V[i]*3+d]) / 2;
      for (const v of vs) lock.add(v);
      for (const fi of around) for (const v of faces[fi]) lock.add(v);
    }
    if (!dead.size) break;
    faces = faces.filter((_, i) => !dead.has(i));
  }
  return faces;
}
// split a polygon into a fan of quads (+ one triangle if odd), from the corner whose diagonals aren't edges yet
function fanSplit(loop, use) {
  const L = loop.length, ek = (a, b) => a < b ? a * 1e7 + b : b * 1e7 + a, out = [];
  let r = 0;
  for (let t = 0; t < L; t++) { let ok = true; for (let i = 2; i < L - 1 && ok; i++) if (use.has(ek(loop[t], loop[(t + i) % L]))) ok = false; if (ok) { r = t; break; } }
  const lp = loop.map((_, i) => loop[(r + i) % L]);
  let i = 1;
  for (; i + 2 < L; i += 2) out.push([lp[0], lp[i], lp[i + 1], lp[i + 2]]);
  if (i + 1 < L) out.push([lp[0], lp[i], lp[i + 1]]);
  for (const f of out) f.forEach((v, k) => use.set(ek(v, f[(k + 1) % f.length]), 1));
  return out;
}

/**
 * @param src { pos, idx }
 * @param opt { target: quads, smooth: relax passes, sym: mirror about x = 0, sharpAngle: degrees (0 = off),
 *   pureQuad, groups, guides, density,
 *   curvature: 0..1 (default 0.5) align loops with the principal curvature directions; 0 = off, higher = more
 *     places count as anisotropic enough,
 *   collapseRows: boolean (default true) collapse dislocation rows (fewer poles, slightly uneven sizes) }
 * @returns { pos, idx (triangles), polys: { start, idx }, stats }
 */
export function fieldRetopo(src, opt) {
  const r = fieldRetopoOnce(src, opt);
  // pure quads promised: the final weld / fold cleanup can leave a few triangles where curvature-aligned loops
  // meet sharp edges; redo that mesh without curvature alignment if so
  if (opt.pureQuad !== false && r.stats.tris > 0 && (opt.curvature ?? 0.5) > 0 && !opt.noFallback) {
    const r2 = fieldRetopoOnce(src, { ...opt, curvature: 0 });
    if (r2.stats.tris < r.stats.tris) { r2.stats.curvFallback = true; return r2; }
  }
  return r;
}
function fieldRetopoOnce(src, opt) {
  const sp = src.pos, si = src.idx;
  let area = 0, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  // density painting (opt.density: per source vertex, -1..1 = half .. double the edge density): the spacing at a
  // point is s * 2^-d, and s is chosen so the painted surface still gets about `target` faces
  const D = opt.density && opt.density.length === sp.length / 3 && opt.density.some(x => Math.abs(x) > 0.01) ? opt.density : null;
  let fmin = 1;
  for (let f = 0; f < si.length; f += 3) {
    const a = si[f]*3, b = si[f+1]*3, c = si[f+2]*3;
    const ux = sp[b]-sp[a], uy = sp[b+1]-sp[a+1], uz = sp[b+2]-sp[a+2], wx = sp[c]-sp[a], wy = sp[c+1]-sp[a+1], wz = sp[c+2]-sp[a+2];
    const A = Math.hypot(uy*wz - uz*wy, uz*wx - ux*wz, ux*wy - uy*wx) / 2;
    if (D) { const fs = 2 ** -((D[si[f]] + D[si[f+1]] + D[si[f+2]]) / 3); area += A / (fs * fs); fmin = Math.min(fmin, fs); } else area += A;
  }
  for (let i = 0; i < sp.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], sp[i+k]); mx[k] = Math.max(mx[k], sp[i+k]); }
  const pure = opt.pureQuad !== false;
  const s = Math.sqrt(area / Math.max(50, opt.target / (pure ? 4 : 1)));
  const ext = Math.max(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]);
  let sym = !!opt.sym && mn[0] < -s * 0.5 && mx[0] > s * 0.5;     // only when the shape straddles x = 0

  // ---- working mesh
  // desktop (native kernels): allow a finer working mesh, so high targets keep ~2.5 working vertices per quad edge
  const res = Math.min(accelInfo() ? 512 : 320, Math.max(24, Math.round(ext / (s * fmin / (opt.workDensity ?? 2.5)))));
  const W = remesh({ pos: sp, idx: si }, { res, project: true, smooth: 2, symX: sym });
  if (!W) return null;
  let V = W.pos, WI = W.idx;
  // half for symmetric mode: vertices with x > 0; seam = those with a neighbour on the other side
  let seam = null;
  if (sym) {
    const n0 = V.length / 3, keep = new Int32Array(n0).fill(-1); let k = 0;
    for (let v = 0; v < n0; v++) if (V[v*3] > 0) keep[v] = k++;
    const isSeam = new Uint8Array(k), I2 = [];
    for (let f = 0; f < WI.length; f += 3) {
      const a = WI[f], b = WI[f+1], c = WI[f+2], ka = keep[a], kb = keep[b], kc = keep[c];
      if (ka >= 0 && kb >= 0 && kc >= 0) I2.push(ka, kb, kc);
      else for (const t of [ka, kb, kc]) if (t >= 0) isSeam[t] = 1;
    }
    const V2 = new Float32Array(k * 3);
    for (let v = 0; v < n0; v++) if (keep[v] >= 0) { V2[keep[v]*3] = V[v*3]; V2[keep[v]*3+1] = V[v*3+1]; V2[keep[v]*3+2] = V[v*3+2]; }
    if (!isSeam.some(x => x)) sym = false; else { V = V2; WI = new Uint32Array(I2); seam = isSeam; }
  }
  const n = V.length / 3, N = vertexNormals(V, WI), adj = buildNeighbors(n, WI);
  let SC = null;
  if (D) {   // the painted density on the working mesh (nearest source point, then smoothed so it changes gradually)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(sp, 3)); g.setIndex(new THREE.BufferAttribute(si.slice(), 1));
    const bvh = new MeshBVH(g), q = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }, tri = new THREE.Triangle(), bc = new THREE.Vector3();
    const gi = g.index.array, A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    let d = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      q.set(V[v*3], V[v*3+1], V[v*3+2]);
      if (!bvh.closestPointToPoint(q, hit)) continue;
      const f = hit.faceIndex * 3, a = gi[f], b = gi[f+1], c = gi[f+2];
      A.fromArray(sp, a * 3); B.fromArray(sp, b * 3); C.fromArray(sp, c * 3); tri.set(A, B, C); tri.getBarycoord(hit.point, bc);
      d[v] = D[a] * bc.x + D[b] * bc.y + D[c] * bc.z;
    }
    for (let it = 0; it < 6; it++) {
      const e = new Float32Array(n);
      for (let v = 0; v < n; v++) { let t = d[v], k = 1; for (let j = adj.start[v]; j < adj.start[v + 1]; j++) { t += d[adj.list[j]]; k++; } e[v] = t / k; }
      d = e;
    }
    SC = new Float32Array(n); for (let v = 0; v < n; v++) SC[v] = 2 ** -Math.max(-1, Math.min(1, d[v]));
  }
  const scAt = v => SC ? SC[v] : 1;

  // ---- constraints: symmetry seam, sharp edges and corners
  const con = { fq: new Uint8Array(n), fo: new Uint8Array(n), fx: new Uint8Array(n), q: new Float32Array(n * 3), o: new Float32Array(n * 3) };
  const angle = opt.sharpAngle ?? 40;
  const F = angle > 0 ? sharpFeatures(sp, si, angle, (opt.sharpMinLen ?? 2) * s) : { segs: new Float32Array(0), corners: new Float32Array(0) };
  // polygroup borders (smoothed) and guide lines steer the direction of the loops; they are not snapped to like
  // sharp edges, because borders are usually soft curves and pinning to them makes the loops jagged.
  // Guides are mirrored in symmetric mode.
  let GI = null;
  {
    let g = opt.guides && opt.guides.length >= 6 ? Array.from(opt.guides) : [];
    if (sym) for (let o = 0, n0 = g.length; o + 5 < n0; o += 6) g.push(-g[o], g[o+1], g[o+2], -g[o+3], g[o+4], g[o+5]);
    if (opt.groups && opt.groups.length === sp.length / 3) g = g.concat(groupFeatures(sp, si, opt.groups).segs);
    if (g.length) GI = new FeatureIndex({ segs: new Float32Array(g), corners: new Float32Array(0) }, s);
  }
  if (sym && F.segs.length) {   // where a crease crosses the mirror plane there must be a vertex: treat it as a corner
    const S = F.segs, extra = [];
    for (let o = 0; o < S.length; o += 6) {
      const x0 = S[o], x1 = S[o+3];
      if ((x0 < 0) !== (x1 < 0) && x0 !== x1) { const t = x0 / (x0 - x1); extra.push(0, S[o+1] + (S[o+4]-S[o+1]) * t, S[o+2] + (S[o+5]-S[o+2]) * t); }
    }
    const C = new Float32Array(F.corners.length + extra.length); C.set(F.corners); C.set(extra, F.corners.length); F.corners = C;
  }
  const FI = F.segs.length ? new FeatureIndex(F, s) : null;
  const vertexKind = new Uint8Array(n);   // 2 sharp edge, 3 corner (seam is tracked separately)
  for (let v = 0; v < n; v++) {
    const p = get(V, v), nn = get(N, v);
    if (seam && seam[v]) {
      let q = tangentOf([1, 0, 0], nn), l = Math.hypot(q[0], q[1], q[2]);
      if (l > 0.2) {
        q = [q[0]/l, q[1]/l, q[2]/l];
        con.fq[v] = 1; set3(con.q, v, q);
        con.fx[v] = 1;
        // a seam vertex can also sit on a crease crossing / corner: pin its lattice point there
        const c = FI && FI.closestCorner(p, s * scAt(v) * 0.6);
        if (c) { con.fo[v] = 1; set3(con.o, v, c.point); }
        continue;
      }
    }
    if (GI) {
      const g = GI.closestSeg(p, s * scAt(v) * 1.2);
      if (g) { const q = tangentOf(g.dir, nn), l = Math.hypot(q[0], q[1], q[2]); if (l > 0.3) { con.fq[v] = 1; set3(con.q, v, [q[0]/l, q[1]/l, q[2]/l]); } }
    }
    if (!FI) continue;
    const c = FI.closestCorner(p, s * scAt(v) * 0.6);
    if (c) { con.fo[v] = 1; set3(con.o, v, c.point); vertexKind[v] = 3; continue; }
    const e = FI.closestSeg(p, s * scAt(v) * 0.45);
    if (e) {
      const q = tangentOf(e.dir, nn), l = Math.hypot(q[0], q[1], q[2]);
      if (l > 0.3) { con.fq[v] = 1; set3(con.q, v, [q[0]/l, q[1]/l, q[2]/l]); }
      if (opt.pinEdges) { con.fo[v] = 1; set3(con.o, v, e.point); }
      vertexKind[v] = 2;
    }
  }
  const levels = buildHierarchy(V, N, adj, con);
  // curvature alignment: where the curvature is clearly anisotropic and its directions agree over a radius of
  // about curvRadius x max(spacing, curvature radius) - cylinders, limbs, folds, saddles - the cross field follows
  // the principal directions, so loops wrap around limbs. Judged with the curvature radius, the test doesn't
  // depend on the resolution: a limb is coherent along its length, a sculpted bump is not, at any target.
  let curvCon = 0;
  const curvK = Math.max(0, Math.min(1, opt.curvature ?? 0.5));
  const CL = curvK > 0 ? curvatureLevels(levels, opt.curvSmooth ?? 3, 2, 6).judge : null;
  if (curvK > 0) {
    const C0 = CL[0], D0 = curvDirs(C0);
    // vertices near a sharp crease / corner (graph rings): rounded voxel creases, the crease steers there
    const nearF = new Uint8Array(n);
    for (let v = 0; v < n; v++) if (vertexKind[v]) nearF[v] = 1;
    if (FI) for (let r = 0, rings = Math.ceil(3 * s / C0.el); r < rings; r++) {
      const grow = [];
      for (let v = 0; v < n; v++) if (!nearF[v]) for (let j = adj.start[v]; j < adj.start[v + 1]; j++) if (nearF[adj.list[j]]) { grow.push(v); break; }
      if (!grow.length) break;
      for (const v of grow) nearF[v] = 1;
    }
    // level to judge at: its smoothing radius reaches curvRadius x the spacing (quad-sized noise averages out) and,
    // while the clusters stay below 0.3 x the curvature radius (finer than the limb, so transporting directions by
    // projection is still sound), up to curvRadius x the curvature radius (a bump that size is averaged as a whole
    // and rejected)
    const aMin = 0.75 - 0.45 * curvK, cMin = 0.9 - 0.2 * curvK, kMin = Math.max(0.5 / ext, 0.01 / s), cr = opt.curvRadius ?? 2.5;
    const acc = [0, 0];
    for (let v = 0; v < n; v++) {
      if (con.fq[v] || vertexKind[v] || nearF[v]) continue;
      const zv = Math.hypot(C0.Z[v*2], C0.Z[v*2+1]); if (!zv) continue;
      const rho = 1 / Math.max(Math.abs(C0.H[v]) + zv, 1e-9), sv = s * scAt(v);
      let l = 0, a = v;
      while (l < CL.length - 1 && (CL[l].rad < cr * sv || CL[l].rad < cr * rho && CL[l + 1].el < 0.3 * rho)) { a = levels[l].parent[a]; l++; }
      const C = CL[l], z = Math.hypot(C.Z[a*2], C.Z[a*2+1]), h = C.H[a], dk = 2 * z;
      if (dk < kMin || dk < aMin * (Math.abs(h + z) + Math.abs(h - z)) || z < cMin * C.R[a]) continue;
      // the local direction must agree with the coherent one (within ~20 deg)
      acc[0] = acc[1] = 0;
      if (l > 0) {
        const Dl = [Math.cos(Math.atan2(C.Z[a*2+1], C.Z[a*2]) / 2), Math.sin(Math.atan2(C.Z[a*2+1], C.Z[a*2]) / 2)];
        const d3 = [C.FU[a*3]*Dl[0] + C.FW[a*3]*Dl[1], C.FU[a*3+1]*Dl[0] + C.FW[a*3+1]*Dl[1], C.FU[a*3+2]*Dl[0] + C.FW[a*3+2]*Dl[1]];
        if (!lineZ(d3, 0, C0.FU, C0.FW, v, 1, acc)) continue;
        if ((acc[0] * C0.Z[v*2] + acc[1] * C0.Z[v*2+1]) / zv < Math.cos(Math.PI * 40 / 180)) continue;
      }
      const q = tangentOf(get(D0, v), get(N, v)), ql = Math.hypot(q[0], q[1], q[2]);
      if (ql > 0.3) { con.fq[v] = 1; set3(con.q, v, [q[0]/ql, q[1]/ql, q[2]/ql]); curvCon++; }
    }
    // pass the new constraints down the hierarchy (as buildHierarchy does: the first constrained child wins)
    for (let l = 1; l < levels.length; l++) {
      const lo = levels[l - 1], hi = levels[l];
      for (let v = 0; v < lo.V.length / 3; v++) {
        const p = lo.parent[v];
        if (!lo.con.fq[v] || hi.con.fq[p]) continue;
        hi.con.fq[p] = 1;
        set3(hi.con.q, p, norm(tangentOf(get(lo.con.q, v), get(hi.N, p))));
      }
    }
  }
  if (SC) {   // spacing on the coarse levels: mean of the vertices each one stands for
    levels[0].SC = SC;
    for (let l = 1; l < levels.length; l++) {
      const lo = levels[l - 1], m2 = levels[l].V.length / 3, sum = new Float32Array(m2), cnt = new Float32Array(m2);
      for (let v = 0; v < lo.SC.length; v++) { sum[lo.parent[v]] += lo.SC[v]; cnt[lo.parent[v]]++; }
      for (let p = 0; p < m2; p++) sum[p] = cnt[p] ? sum[p] / cnt[p] : 1;
      levels[l].SC = sum;
    }
  }

  // ---- orientation field (coarse to fine)
  let rnd = 12345; const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  let Q = null;
  const Qs = [];
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l], m = L.V.length / 3, q = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      const ni = get(L.N, i);
      let v = L.con.fq[i] ? get(L.con.q, i) : Q ? get(Q, L.parent[i]) : [rand(), rand(), rand()];
      let w = tangentOf(v, ni);
      if (Math.hypot(w[0], w[1], w[2]) < 1e-8) w = Math.abs(ni[0]) < 0.9 ? [0, -ni[2], ni[1]] : [ni[2], 0, -ni[0]];
      set3(q, i, norm(w));
    }
    smoothOrientations(L, q, l === 0 ? (opt.itO ?? 30) : 15, opt.shuffle !== false);
    Q = q; Qs[l] = q;
  }
  // ---- position field (coarse to fine)
  let O = null;
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l], m = L.V.length / 3, o = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      if (L.con.fo[i]) { set3(o, i, get(L.con.o, i)); continue; }
      const vi = get(L.V, i), ni = get(L.N, i), qi = get(Qs[l], i);
      const si2 = L.SC ? s * L.SC[i] : s;
      let p0 = O ? get(O, L.parent[i]) : [vi[0] + rand() * si2, vi[1] + rand() * si2, vi[2] + rand() * si2];
      const d = (p0[0]-vi[0])*ni[0] + (p0[1]-vi[1])*ni[1] + (p0[2]-vi[2])*ni[2];
      let li = lattice([p0[0] - ni[0]*d, p0[1] - ni[1]*d, p0[2] - ni[2]*d], qi, ni, vi, si2, true);
      if (L.con.fx[i]) li = onPlane(li, qi, cross(ni, qi));
      set3(o, i, li);
    }
    smoothPositions(L, Qs[l], o, s, l === 0 ? (opt.itP ?? 30) : 15, opt.shuffle !== false);
    O = o;
  }

  // ---- extraction: merge vertices on the same lattice point, collect lattice-neighbour edges
  const uf = new Int32Array(n).map((_, i) => i);
  const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  const cand = [];
  for (let i = 0; i < n; i++) for (let j = adj.start[i]; j < adj.start[i + 1]; j++) {
    const u = adj.list[j]; if (u < i) continue;
    const vi = get(V, i), ni = get(N, i), qi = get(Q, i), oi = get(O, i), sij = SC ? s * (SC[i] + SC[u]) / 2 : s;
    const [a, b] = compatPos(vi, ni, qi, oi, get(V, u), get(N, u), get(Q, u), get(O, u), sij);
    const D = [(a[0]-oi[0]) - (b[0]-O[u*3]), (a[1]-oi[1]) - (b[1]-O[u*3+1]), (a[2]-oi[2]) - (b[2]-O[u*3+2])];
    const ti = cross(ni, qi);
    const du = Math.round((D[0]*qi[0] + D[1]*qi[1] + D[2]*qi[2]) / sij), dv = Math.round((D[0]*ti[0] + D[1]*ti[1] + D[2]*ti[2]) / sij);
    if (du === 0 && dv === 0) {
      const gap = Math.hypot(O[i*3] - O[u*3], O[i*3+1] - O[u*3+1], O[i*3+2] - O[u*3+2]);
      if (gap < sij * (opt.mergeGap ?? 9)) { const x = find(i), y = find(u); if (x !== y) uf[x] = y; }
    }
    else if (Math.abs(du) + Math.abs(dv) === 1) cand.push(i, u);
  }
  const cid = new Int32Array(n).fill(-1); let m = 0;
  for (let i = 0; i < n; i++) { const r = find(i); if (cid[r] < 0) cid[r] = m++; cid[i] = cid[r]; }
  const P = new Float32Array(m * 3), PN = new Float32Array(m * 3), PQ = new Float32Array(m * 3), cnt = new Float32Array(m), kind = new Uint8Array(m), onSeam = new Uint8Array(m);
  for (let i = 0; i < n; i++) {
    const c = cid[i]; cnt[c]++;
    for (let k = 0; k < 3; k++) { P[c*3+k] += O[i*3+k]; PN[c*3+k] += N[i*3+k]; }
    if (cnt[c] === 1) set3(PQ, c, get(Q, i));
    kind[c] = Math.max(kind[c], vertexKind[i]);
    if (seam && seam[i]) onSeam[c] = 1;
  }
  for (let c = 0; c < m; c++) { for (let k = 0; k < 3; k++) P[c*3+k] /= cnt[c]; set3(PN, c, norm(get(PN, c))); set3(PQ, c, norm(tangentOf(get(PQ, c), get(PN, c)))); }
  const support = new Map();
  for (let e = 0; e < cand.length; e += 2) { const a = cid[cand[e]], b = cid[cand[e+1]]; if (a === b) continue; const k = a < b ? a * m + b : b * m + a; support.set(k, (support.get(k) || 0) + 1); }
  // at most one edge per cross-field direction at each vertex (removes stray diagonals)
  const pick = new Map();
  const frameAngle = (c, u) => { const nn = get(PN, c), q = get(PQ, c), t = cross(nn, q), d = [P[u*3]-P[c*3], P[u*3+1]-P[c*3+1], P[u*3+2]-P[c*3+2]]; return Math.atan2(d[0]*t[0]+d[1]*t[1]+d[2]*t[2], d[0]*q[0]+d[1]*q[1]+d[2]*q[2]); };
  for (const [k, sup] of support) {
    const a = Math.floor(k / m), b = k % m;
    for (const [c, u] of [[a, b], [b, a]]) {
      const ang = frameAngle(c, u), quad = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4, dev = Math.abs(ang - Math.round(ang / (Math.PI / 2)) * Math.PI / 2);
      const score = sup - dev, key = c * 4 + quad, cur = pick.get(key);
      if (!cur || score > cur.score) pick.set(key, { u, score });
    }
  }
  const kept = new Set();
  for (const [key, { u }] of pick) kept.add(Math.floor(key / 4) * m + u);
  const nbr = Array.from({ length: m }, () => []);
  const ef = opt.edgeFilter ?? 'none';
  for (const k of support.keys()) {
    const a = Math.floor(k / m), b = k % m, ka = kept.has(a * m + b), kb = kept.has(b * m + a);
    if (ef === 'none' || (ef === 'either' ? ka || kb : ka && kb)) { nbr[a].push(b); nbr[b].push(a); }
  }
  // angular order around each vertex
  const ring = nbr.map((list, c) => {
    const nn = get(PN, c), q = get(PQ, c), t = cross(nn, q);
    return list.map(u => { const d = [P[u*3]-P[c*3], P[u*3+1]-P[c*3+1], P[u*3+2]-P[c*3+2]]; return [u, Math.atan2(d[0]*t[0]+d[1]*t[1]+d[2]*t[2], d[0]*q[0]+d[1]*q[1]+d[2]*q[2])]; })
      .sort((x, y) => x[1] - y[1]).map(x => x[0]);
  });
  const rpos = ring.map(r => new Map(r.map((u, k) => [u, k])));
  const used = new Set(); let polys = [];
  for (let u = 0; u < m; u++) for (const v of ring[u]) {
    if (used.has(u * m + v)) continue;
    const face = [u]; let a = u, b = v, closed = false;
    for (let steps = 0; steps < 12; steps++) {
      used.add(a * m + b); face.push(b);
      const r = ring[b], i = rpos[b].get(a);
      if (i === undefined || r.length < 2) break;
      const c = r[(i - 1 + r.length) % r.length];
      a = b; b = c;
      if (b === u) { used.add(a * m + b); closed = true; break; }
    }
    if (!closed || face.length < 3) continue;
    if (sym && face.every(x => onSeam[x])) continue;               // the open boundary along the seam
    polys.push(face);
  }
  // a triangle next to a pentagon is one lattice dislocation: their union, a hexagon, becomes two quads below
  if (opt.mergeOdd !== false) {
    const ek = (a, b) => a < b ? a * 1e7 + b : b * 1e7 + a, ef = new Map();
    polys.forEach((f, i) => { if (f.length === 3 || f.length === 5) f.forEach((v, k) => { const key = ek(v, f[(k + 1) % f.length]); (ef.get(key) || ef.set(key, []).get(key)).push(i); }); });
    const dead = new Set(), add = [];
    polys.forEach((f, i) => {
      if (f.length !== 5 || dead.has(i)) return;
      let best = null, bq = Infinity;
      for (let k = 0; k < 5; k++) {
        const a = f[k], b = f[(k + 1) % 5], l = ef.get(ek(a, b));
        if (!l || l.length !== 2) continue;
        const j = l[0] === i ? l[1] : l[0], T = polys[j];
        if (T.length !== 3 || dead.has(j)) continue;
        const ka = T.indexOf(a); if (T[(ka + 2) % 3] !== b) continue;   // T has b -> a: consistent winding
        const apex = T[(ka + 1) % 3]; if (f.includes(apex)) continue;
        const H = [];   // pentagon from b around to a, then the apex
        for (let t = 0; t < 5; t++) H.push(f[(k + 1 + t) % 5]);
        H.push(apex);
        for (let d = 0; d < 3; d++) {
          const q1 = [H[d], H[d+1], H[d+2], H[d+3]], q2 = [H[d+3], H[(d+4) % 6], H[(d+5) % 6], H[d]];
          const q = Math.max(quadQuality(P, q1), quadQuality(P, q2));
          if (q < bq) { bq = q; best = { j, q1, q2 }; }
        }
      }
      if (!best || bq > (opt.oddDev ?? 1.0)) return;
      dead.add(i); dead.add(best.j); add.push(best.q1, best.q2);
    });
    if (add.length) polys = polys.filter((_, i) => !dead.has(i)).concat(add);
  }
  // split n-gons: 5 -> quad + tri, 6 -> two quads (best corner angles), larger -> fan around a centre point
  const PP = Array.from(P), out = [];
  for (const f of polys) {
    const L = f.length;
    if (L <= 4) { out.push(f); continue; }
    if ((L === 5 || L === 6) && opt.splitNgons !== false) {
      let bk = 0, bd = Infinity;
      for (let k = 0; k < L; k++) {
        const d = L === 6 ? Math.max(quadQuality(P, [f[k], f[(k+1)%6], f[(k+2)%6], f[(k+3)%6]]), quadQuality(P, [f[(k+3)%6], f[(k+4)%6], f[(k+5)%6], f[k]])) : dist2(P, f[k], f[(k + 3) % L]);
        if (d < bd) { bd = d; bk = k; }
      }
      const r = Array.from({ length: L }, (_, i) => f[(bk + i) % L]);
      out.push([r[0], r[1], r[2], r[3]]);
      out.push(L === 5 ? [r[3], r[4], r[0]] : [r[3], r[4], r[5], r[0]]);
      continue;
    }
    const c = PP.length / 3; let cx = 0, cy = 0, cz = 0;
    for (const v of f) { cx += P[v*3]; cy += P[v*3+1]; cz += P[v*3+2]; }
    PP.push(cx / L, cy / L, cz / L);
    for (let k = 0; k < L; k++) out.push([f[k], f[(k + 1) % L], c]);
  }
  // merge neighbouring triangles into quads when the quad is reasonable
  for (let i = out.length - 1; i >= 0; i--) if (new Set(out[i]).size !== out[i].length) out.splice(i, 1);   // degenerate faces
  const Pm = new Float32Array(PP), triEdge = new Map(), dead = new Set();
  out.forEach((f, i) => { if (f.length === 3) for (let k = 0; k < 3; k++) { const a = f[k], b = f[(k + 1) % 3], key = a < b ? a * 1e7 + b : b * 1e7 + a; (triEdge.get(key) || triEdge.set(key, []).get(key)).push(i); } });
  const merged = [];
  for (const [key, list] of opt.mergeTris === false ? [] : triEdge) {
    if (list.length !== 2 || dead.has(list[0]) || dead.has(list[1])) continue;
    const [i, j] = list, A = out[i], B = out[j];
    const a = Math.floor(key / 1e7), b = key % 1e7;
    const ka = A.indexOf(a), kb = A.indexOf(b), other = B.find(x => x !== a && x !== b);
    if (other === undefined || A.includes(other)) continue;
    // quad in A's winding: insert B's apex between the shared edge's endpoints
    let quad;
    if ((kb - ka + 3) % 3 === 1) quad = [A[ka], other, A[kb], A[(kb + 1) % 3]]; else quad = [A[kb], other, A[ka], A[(ka + 1) % 3]];
    if (quadQuality(Pm, quad) > 0.75) continue;                     // > ~43 deg off a right angle
    dead.add(i); dead.add(j); merged.push(quad);
  }
  let faces = out.filter((_, i) => !dead.has(i)).concat(merged);
  // overlapping faces: drop duplicates, then keep at most two faces per edge (larger faces first)
  {
    const seenF = new Set();
    faces = faces.filter(f => { const k = [...f].sort((x, y) => x - y).join(','); if (seenF.has(k)) return false; seenF.add(k); return true; });
    faces.sort((x, y) => y.length - x.length);
    const use = new Map(), keep = [];
    for (const f of faces) {
      const keys = f.map((v, k) => { const w = f[(k + 1) % f.length]; return v < w ? v * 1e7 + w : w * 1e7 + v; });
      if (keys.some(k => (use.get(k) || 0) >= 2)) continue;
      for (const k of keys) use.set(k, (use.get(k) || 0) + 1);
      keep.push(f);
    }
    faces = keep;
    // close small holes: each boundary loop becomes one polygon (later split into quads)
    const half = new Map();   // directed edge a->b present
    for (const f of faces) for (let k = 0; k < f.length; k++) half.set(f[k] * 1e7 + f[(k + 1) % f.length], 1);
    const outB = new Map();   // boundary half-edges b->a (reverse of an unmatched a->b), possibly several per start
    for (const key of half.keys()) {
      const a = Math.floor(key / 1e7), b = key % 1e7;
      if (!half.has(b * 1e7 + a)) (outB.get(b) || outB.set(b, []).get(b)).push(a);
    }
    const usedB = new Set();
    for (const [st, list] of outB) for (const first of list) {
      if (usedB.has(st * 1e7 + first)) continue;
      const loop = [st]; let prev = st, v = first, ok = true;
      const marks = [st * 1e7 + first];
      usedB.add(st * 1e7 + first);
      while (v !== st) {
        if (loop.length > 16) { ok = false; break; }
        loop.push(v);
        const nx = (outB.get(v) || []).filter(w => !usedB.has(v * 1e7 + w));
        if (!nx.length) { ok = false; break; }
        // at a pinch vertex prefer closing the loop, else the first unused way out
        const w = nx.includes(st) ? st : nx[0];
        usedB.add(v * 1e7 + w); marks.push(v * 1e7 + w); prev = v; v = w;
      }
      // never fill the open seam of the symmetric half: it is closed by mirroring
      if (ok && loop.length >= 3 && !(sym && loop.filter(x => onSeam[x]).length >= loop.length * 0.8)) faces.push(loop);
      else for (const k of marks) usedB.delete(k);   // rejected: leave its edges for the seam pass below
    }
    // symmetric half: a hole touching the seam is a boundary path that leaves the seam and comes back;
    // close it with one polygon (its closing edge lies on the mirror plane and is shared with the mirror copy)
    if (sym) {
      for (const [st, list] of outB) {
        if (!onSeam[st]) continue;
        for (const first of list) {
          if (onSeam[first] || usedB.has(st * 1e7 + first)) continue;
          const path = [st]; let v = first, ok = false;
          const mark = [st * 1e7 + first];
          while (path.length <= 16) {
            path.push(v);
            if (onSeam[v]) { ok = true; break; }
            const nx = (outB.get(v) || []).filter(w => !usedB.has(v * 1e7 + w));
            if (!nx.length) break;
            mark.push(v * 1e7 + nx[0]); v = nx[0];
          }
          if (ok && path.length >= 3) { for (const k of mark) usedB.add(k); faces.push(path); }
        }
      }
    }
  }
  // face winding vs. the field normals (Newell normal of the polygon . corner normals)
  const orientOf = f => {
    let nx = 0, ny = 0, nz = 0, d = 0;
    for (let k = 0; k < f.length; k++) {
      const a = f[k] * 3, b = f[(k + 1) % f.length] * 3;
      nx += (Pm[a+1] - Pm[b+1]) * (Pm[a+2] + Pm[b+2]); ny += (Pm[a+2] - Pm[b+2]) * (Pm[a] + Pm[b]); nz += (Pm[a] - Pm[b]) * (Pm[a+1] + Pm[b+1]);
    }
    for (const v of f) if (v < m) d += nx * PN[v*3] + ny * PN[v*3+1] + nz * PN[v*3+2];
    return d;
  };
  faces = repairSurface(faces, v => sym && !!onSeam[v], pure, orientOf);
  if (opt.collapseRows !== false) faces = collapseRows(faces, Pm, opt.rowLen ?? 8, v => v >= m || kind[v] >= 2 || sym && !!onSeam[v], 1);
  // pure quads: relax the coarse polygons first (tangential umbrella smoothing, no snapping yet). The fine mesh
  // is twice as dense, so its own relaxation can only even out sizes locally; collapsed rows and dislocations
  // need the long-range smoothing done here. Creases, corners and the seam are left for the final pass.
  if (pure && (opt.coarseSmooth ?? Math.round((opt.smooth ?? 8) * 1.5)) > 0) {
    const nP = Pm.length / 3, nb = Array.from({ length: nP }, () => new Set());
    for (const f of faces) for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length]; nb[a].add(b); nb[b].add(a); }
    const free = new Uint8Array(nP);
    for (let v = 0; v < nP; v++) free[v] = nb[v].size > 0 && !(v < m && (kind[v] >= 2 || onSeam[v])) ? 1 : 0;
    for (let it = 0; it < (opt.coarseSmooth ?? Math.round((opt.smooth ?? 8) * 1.5)); it++) {
      const VN = new Float32Array(nP * 3), np = Pm.slice();
      for (const f of faces) {
        let nx = 0, ny = 0, nz = 0;
        for (let k = 0; k < f.length; k++) { const a = f[k] * 3, b = f[(k + 1) % f.length] * 3; nx += (Pm[a+1] - Pm[b+1]) * (Pm[a+2] + Pm[b+2]); ny += (Pm[a+2] - Pm[b+2]) * (Pm[a] + Pm[b]); nz += (Pm[a] - Pm[b]) * (Pm[a+1] + Pm[b+1]); }
        for (const v of f) { VN[v*3] += nx; VN[v*3+1] += ny; VN[v*3+2] += nz; }
      }
      for (let v = 0; v < nP; v++) {
        if (!free[v]) continue;
        let ax = 0, ay = 0, az = 0; for (const u of nb[v]) { ax += Pm[u*3]; ay += Pm[u*3+1]; az += Pm[u*3+2]; }
        const d = tangentOf([ax / nb[v].size - Pm[v*3], ay / nb[v].size - Pm[v*3+1], az / nb[v].size - Pm[v*3+2]], norm(get(VN, v)));
        np[v*3] += d[0] * 0.5; np[v*3+1] += d[1] * 0.5; np[v*3+2] += d[2] * 0.5;
      }
      Pm.set(np);
    }
  }
  // pure quads: every n-gon -> n quads (centre + edge midpoints); shared midpoints keep the mesh closed
  let Pfinal = Pm, kindF = kind, seamF = onSeam;
  if (pure) {
    const mid = new Map(), PX = Array.from(Pm), KX = Array.from({ length: Pm.length / 3 }, (_, v) => v < m ? kind[v] : 0), SX = Array.from({ length: Pm.length / 3 }, (_, v) => v < m ? onSeam[v] : 0);
    const add = (x, y, z, k, se) => { PX.push(x, y, z); KX.push(k); SX.push(se); return PX.length / 3 - 1; };
    const midOf = (a, b) => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a; let v = mid.get(key);
      if (v === undefined) { v = add((PX[a*3] + PX[b*3]) / 2, (PX[a*3+1] + PX[b*3+1]) / 2, (PX[a*3+2] + PX[b*3+2]) / 2, 0, SX[a] && SX[b] ? 1 : 0); mid.set(key, v); }
      return v;
    };
    const nf = [];
    for (const f of faces) {
      let cx = 0, cy = 0, cz = 0; for (const v of f) { cx += PX[v*3]; cy += PX[v*3+1]; cz += PX[v*3+2]; }
      const c = add(cx / f.length, cy / f.length, cz / f.length, 0, 0), L = f.length;
      for (let k = 0; k < L; k++) nf.push([f[k], midOf(f[k], f[(k + 1) % L]), c, midOf(f[(k - 1 + L) % L], f[k])]);
    }
    faces = nf; Pfinal = new Float32Array(PX); kindF = KX; seamF = SX;
  }

  // ---- compact, relax, snap
  const usedV = new Int32Array(Pfinal.length / 3).fill(-1); let nv = 0;
  for (const f of faces) for (const v of f) if (usedV[v] < 0) usedV[v] = nv++;
  let X = new Float32Array(nv * 3), SE = new Uint8Array(nv); const K = new Uint8Array(nv);
  for (let v = 0; v < usedV.length; v++) if (usedV[v] >= 0) { const t = usedV[v]; X[t*3] = Pfinal[v*3]; X[t*3+1] = Pfinal[v*3+1]; X[t*3+2] = Pfinal[v*3+2]; K[t] = kindF[v] || 0; SE[t] = seamF[v] || 0; }
  const FF = faces.map(f => f.map(v => usedV[v]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(sp, 3)); g.setIndex(new THREE.BufferAttribute(si.slice(), 1));
  const bvh = new MeshBVH(g), qv = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const cornerOf = new Map();
  // classify by distance to features at the final spacing; each corner goes to exactly one vertex (its nearest)
  const so = pure ? s / 2 : s;
  if (FI) {
    for (let v = 0; v < nv; v++) K[v] = FI.closestSeg(get(X, v), so * 0.35) ? 2 : 0;
    const C = F.corners;
    for (let c = 0; c < C.length / 3; c++) {
      let best = -1, bd = so * 0.75;
      for (let v = 0; v < nv; v++) { const d = Math.hypot(X[v*3] - C[c*3], X[v*3+1] - C[c*3+1], X[v*3+2] - C[c*3+2]); if (d < bd) { bd = d; best = v; } }
      if (best >= 0) { K[best] = 3; cornerOf.set(best, c); }
    }
  } else K.fill(0);
  const project1 = v => {
    const p = get(X, v);
    if (K[v] === 3) { const c = cornerOf.get(v); set3(X, v, [F.corners[c*3], F.corners[c*3+1], F.corners[c*3+2]]); return; }
    if (K[v] === 2) { const e = FI.closestSeg(p, s); if (e) { set3(X, v, e.point); return; } }
    qv.set(p[0], p[1], p[2]);
    if (bvh.closestPointToPoint(qv, hit, 0, s * 2)) set3(X, v, [hit.point.x, hit.point.y, hit.point.z]);
  };
  // seam vertices: alternate surface snapping and the mirror plane -> they settle on the cross-section curve
  const project = v => { if (!SE[v]) { project1(v); return; } for (let k = 0; k < 4; k++) { project1(v); X[v*3] = 0; } };
  const edgeN = Array.from({ length: nv }, () => new Set());
  for (const f of FF) for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length]; edgeN[a].add(b); edgeN[b].add(a); }
  // quads -> triangles along the shorter diagonal; `safe`: never along a diagonal that is already an edge
  const triOf = (FF, safe) => {
    const ek = (a, b) => a < b ? a * 1e7 + b : b * 1e7 + a, seen = safe ? new Set() : null;
    if (seen) for (const f of FF) for (let k = 0; k < f.length; k++) seen.add(ek(f[k], f[(k + 1) % f.length]));
    const t = [];
    for (const f of FF) {
      if (f.length === 3) { t.push(f[0], f[1], f[2]); continue; }
      let use02 = dist2(X, f[0], f[2]) <= dist2(X, f[1], f[3]);
      if (seen) { const k02 = ek(f[0], f[2]), k13 = ek(f[1], f[3]); if (seen.has(use02 ? k02 : k13) && !seen.has(use02 ? k13 : k02)) use02 = !use02; seen.add(use02 ? k02 : k13); }
      if (use02) t.push(f[0], f[1], f[2], f[0], f[2], f[3]); else t.push(f[0], f[1], f[3], f[1], f[2], f[3]);
    }
    return new Uint32Array(t);
  };
  for (let v = 0; v < nv; v++) { if (SE[v]) X[v*3] = 0; project(v); }
  for (let it = 0; it < (opt.smooth ?? 8); it++) {
    const Nn = vertexNormals(X, triOf(FF)), np = X.slice();
    for (let v = 0; v < nv; v++) {
      if (K[v] === 3) continue;                                     // corners stay put
      // seam / crease vertices only slide along their own line: average just their line neighbours
      const nb = SE[v] ? [...edgeN[v]].filter(u => SE[u]) : [...edgeN[v]].filter(u => K[v] === 0 || K[u] === K[v] || K[u] === 3);
      if (!nb.length) continue;
      let ax = 0, ay = 0, az = 0; for (const u of nb) { ax += X[u*3]; ay += X[u*3+1]; az += X[u*3+2]; }
      let d = [ax / nb.length - X[v*3], ay / nb.length - X[v*3+1], az / nb.length - X[v*3+2]];
      if (K[v] === 0 && !SE[v]) d = tangentOf(d, get(Nn, v));
      np[v*3] += d[0] * 0.5; np[v*3+1] += d[1] * 0.5; np[v*3+2] += d[2] * 0.5;
    }
    X.set(np);
    for (let v = 0; v < nv; v++) project(v);
  }
  g.dispose();

  // ---- safety: weld vertices that ended up on the same spot, drop faces that collapsed
  {
    const key = v => `${Math.round(X[v*3] * 1e5)},${Math.round(X[v*3+1] * 1e5)},${Math.round(X[v*3+2] * 1e5)}`, rep = new Map(), to = new Int32Array(nv);
    for (let v = 0; v < nv; v++) { const k = key(v); if (rep.has(k)) to[v] = rep.get(k); else { rep.set(k, v); to[v] = v; } }
    const kept = [];
    for (const f of FF) {
      const g2 = []; for (const v of f) { const t = to[v]; if (g2[g2.length - 1] !== t) g2.push(t); }
      if (g2.length > 1 && g2[0] === g2[g2.length - 1]) g2.pop();
      if (g2.length >= 3 && new Set(g2).size === g2.length) kept.push(g2);
    }
    FF.length = 0; for (const f of kept) FF.push(f);
  }
  // ---- doublets / folds: two faces that share both edges at a vertex fold the surface over (and make them
  //      pick the same diagonal); merge the pair into one quad / triangle
  const rot = (f, v) => { const k = f.indexOf(v); return f.map((_, i) => f[(k + i) % f.length]); };
  { // the same face twice: keep one; wound both ways it is a zero-volume fin: drop both
    const seenF = new Map(), kill = new Set();
    FF.forEach((f, i) => {
      const k = [...f].sort((x, y) => x - y).join(',');
      if (!seenF.has(k)) { seenF.set(k, i); return; }
      const j = seenF.get(k); kill.add(i);
      if (rot(FF[j], f[0])[1] !== f[1]) kill.add(j);
    });
    if (kill.size) { let w = 0; FF.forEach((f, i) => { if (!kill.has(i)) FF[w++] = f; }); FF.length = w; }
  }
  for (let pass = 0; pass < 4; pass++) {
    const vf = Array.from({ length: nv }, () => []);
    FF.forEach((f, i) => { for (const v of f) vf[v].push(i); });
    const dead = new Set(); let merged = 0;
    for (let v = 0; v < nv; v++) {
      const L = vf[v]; if (L.length < 2 || SE[v] || K[v] === 3) continue;
      for (let x = 0; x < L.length; x++) for (let y = x + 1; y < L.length; y++) {
        const i = L[x], j = L[y]; if (dead.has(i) || dead.has(j)) continue;
        const A = rot(FF[i], v), B = rot(FF[j], v);   // e.g. [v, a, x, b] and [v, b, y, a] (or triangles)
        if (B[1] !== A[A.length - 1] || B[B.length - 1] !== A[1]) continue;
        const q = A.slice(1).concat(B.slice(2, -1));
        if (q.length < 3 || q.length > 4 || new Set(q).size !== q.length) continue;
        FF[i] = q; FF[j] = null; dead.add(i); dead.add(j); merged++;
      }
    }
    if (!merged) break;
    let w = 0; for (const f of FF) if (f) FF[w++] = f; FF.length = w;
  }
  // drop vertices no face uses any more (welded or merged away)
  {
    const remap = new Int32Array(nv).fill(-1); let m2 = 0;
    for (const f of FF) for (const v of f) if (remap[v] < 0) remap[v] = m2++;
    if (m2 < nv) {
      const X2 = new Float32Array(m2 * 3), SE2 = new Uint8Array(m2);
      for (let v = 0; v < nv; v++) if (remap[v] >= 0) { const t = remap[v]; X2[t*3] = X[v*3]; X2[t*3+1] = X[v*3+1]; X2[t*3+2] = X[v*3+2]; SE2[t] = SE[v]; }
      for (const f of FF) for (let k = 0; k < f.length; k++) f[k] = remap[f[k]];
      X = X2; SE = SE2; nv = m2;
    }
  }

  // ---- mirror the half (symmetric mode)
  let polysOut = FF, Xo = X;
  if (sym) {
    const mirrorOf = new Int32Array(nv), extra = [];
    let next = nv;
    for (let v = 0; v < nv; v++) {
      if (SE[v] || X[v*3] <= 1e-7) { X[v*3] = 0; mirrorOf[v] = v; }
      else { mirrorOf[v] = next++; extra.push(-X[v*3], X[v*3+1], X[v*3+2]); }
    }
    Xo = new Float32Array(next * 3); Xo.set(X); Xo.set(extra, nv * 3);
    polysOut = FF.concat(FF.map(f => f.map(v => mirrorOf[v]).reverse()));
  }
  const tri = (() => { const save = X; X = Xo; const t = triOf(polysOut, true); X = save; return t; })();
  const start = new Uint32Array(polysOut.length + 1), pidx = [];
  polysOut.forEach((f, i) => { for (const v of f) pidx.push(v); start[i + 1] = pidx.length; });
  let quads = 0, tris = 0, ngons = 0; for (const f of polysOut) { if (f.length === 4) quads++; else if (f.length === 3) tris++; else ngons++; }
  return { pos: Xo, idx: tri, polys: { start, idx: Uint32Array.from(pidx) }, stats: { quads, tris, ngons, working: n, symmetric: sym, sharpSegments: F.segs.length / 6, curvAligned: +(curvCon / n).toFixed(3) } };
}
