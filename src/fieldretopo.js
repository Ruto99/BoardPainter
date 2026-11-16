// Field-aligned quad retopology, following the approach of Instant Field-Aligned Meshes
// (Jakob, Tarini, Panozzo, Sorkine-Hornung, SIGGRAPH Asia 2015), simplified:
//  1. uniform working mesh (voxel remesh) a few times denser than the target
//  2. 4-RoSy orientation field, smoothed on a multigrid hierarchy (extrinsic metric)
//  3. position field: a lattice of spacing `scale` aligned with the orientation field
//  4. extraction: vertices sharing a lattice point are merged; lattice neighbours become edges;
//     faces are traced by walking around each vertex in angular order (holes are fan-filled)
//  5. tangential relaxation + snapping onto the source surface
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { remesh } from './remesh.js';

// ---- small vector helpers on Float32Array triples
const dot = (a, i, b, j) => a[i]*b[j] + a[i+1]*b[j+1] + a[i+2]*b[j+2];

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

// ---- multigrid hierarchy by greedy edge matching
function buildHierarchy(V, N, adj) {
  const levels = [{ V, N, adj, parent: null }];
  for (let depth = 0; depth < 20; depth++) {
    const L = levels[levels.length - 1], n = L.V.length / 3;
    if (n < 80) break;
    const parent = new Int32Array(n).fill(-1);
    let m = 0;
    for (let v = 0; v < n; v++) {
      if (parent[v] >= 0) continue;
      let best = -1, bs = -Infinity;
      for (let j = L.adj.start[v]; j < L.adj.start[v + 1]; j++) {
        const u = L.adj.list[j]; if (parent[u] >= 0) continue;
        const s = dot(L.N, v*3, L.N, u*3); if (s > bs) { bs = s; best = u; }
      }
      parent[v] = m; if (best >= 0) parent[best] = m; m++;
    }
    if (m > n * 0.85) break;
    const cV = new Float32Array(m * 3), cN = new Float32Array(m * 3), cnt = new Float32Array(m);
    for (let v = 0; v < n; v++) { const p = parent[v]; cnt[p]++; for (let k = 0; k < 3; k++) { cV[p*3+k] += L.V[v*3+k]; cN[p*3+k] += L.N[v*3+k]; } }
    for (let p = 0; p < m; p++) { for (let k = 0; k < 3; k++) cV[p*3+k] /= cnt[p]; const l = Math.hypot(cN[p*3], cN[p*3+1], cN[p*3+2]) || 1; cN[p*3] /= l; cN[p*3+1] /= l; cN[p*3+2] /= l; }
    const sets = Array.from({ length: m }, () => new Set());
    for (let v = 0; v < n; v++) for (let j = L.adj.start[v]; j < L.adj.start[v + 1]; j++) { const a = parent[v], b = parent[L.adj.list[j]]; if (a !== b) sets[a].add(b); }
    const st = new Uint32Array(m + 1), list = [];
    for (let p = 0; p < m; p++) { st[p] = list.length; for (const b of sets[p]) list.push(b); }
    st[m] = list.length;
    L.parent = parent;
    levels.push({ V: cV, N: cN, adj: { start: st, list: Uint32Array.from(list) }, parent: null });
  }
  return levels;
}

// ---- orientation field (4-RoSy, extrinsic)
function compatOrient(q0, n0, q1, n1, out) {
  // representatives {q, n×q} for both; pick the pair with the largest |dot|
  const A = [q0, cross(n0, q0)], B = [q1, cross(n1, q1)];
  let best = -1, bi = 0, bj = 0, sgn = 1;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const d = A[i][0]*B[j][0] + A[i][1]*B[j][1] + A[i][2]*B[j][2];
    if (Math.abs(d) > best) { best = Math.abs(d); bi = i; bj = j; sgn = d < 0 ? -1 : 1; }
  }
  out[0] = A[bi]; out[1] = [B[bj][0]*sgn, B[bj][1]*sgn, B[bj][2]*sgn];
}
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const get = (A, i) => [A[i*3], A[i*3+1], A[i*3+2]];
function smoothOrientations(L, Q, iters) {
  const n = L.V.length / 3, pair = [null, null];
  for (let it = 0; it < iters; it++) for (let i = 0; i < n; i++) {
    const ni = get(L.N, i); let q = get(Q, i), ws = 0;
    for (let j = L.adj.start[i]; j < L.adj.start[i + 1]; j++) {
      const u = L.adj.list[j];
      compatOrient(q, ni, get(Q, u), get(L.N, u), pair);
      const a = pair[0], b = pair[1];
      q = [a[0]*ws + b[0], a[1]*ws + b[1], a[2]*ws + b[2]];
      const d = q[0]*ni[0] + q[1]*ni[1] + q[2]*ni[2];
      q = [q[0] - ni[0]*d, q[1] - ni[1]*d, q[2] - ni[2]*d];
      const l = Math.hypot(q[0], q[1], q[2]) || 1; q = [q[0]/l, q[1]/l, q[2]/l];
      ws += 1;
    }
    Q[i*3] = q[0]; Q[i*3+1] = q[1]; Q[i*3+2] = q[2];
  }
}

// ---- position field
function floor4(o, q, n, p, s, round) {
  const t = cross(n, q), d = [p[0]-o[0], p[1]-o[1], p[2]-o[2]];
  const f = round ? Math.round : Math.floor;
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
  const a0 = floor4(o0, q0, n0, m, s, false), a1 = floor4(o1, q1, n1, m, s, false);
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
function smoothPositions(L, Q, O, s, iters) {
  const n = L.V.length / 3;
  for (let it = 0; it < iters; it++) for (let i = 0; i < n; i++) {
    const vi = get(L.V, i), ni = get(L.N, i), qi = get(Q, i);
    let o = get(O, i), ws = 0;
    for (let j = L.adj.start[i]; j < L.adj.start[i + 1]; j++) {
      const u = L.adj.list[j];
      const [a, b] = compatPos(vi, ni, qi, o, get(L.V, u), get(L.N, u), get(Q, u), get(O, u), s);
      o = [(a[0]*ws + b[0]) / (ws + 1), (a[1]*ws + b[1]) / (ws + 1), (a[2]*ws + b[2]) / (ws + 1)];
      ws += 1;
      const d = (o[0]-vi[0])*ni[0] + (o[1]-vi[1])*ni[1] + (o[2]-vi[2])*ni[2];
      o = [o[0] - ni[0]*d, o[1] - ni[1]*d, o[2] - ni[2]*d];
    }
    o = floor4(o, qi, ni, vi, s, true);
    O[i*3] = o[0]; O[i*3+1] = o[1]; O[i*3+2] = o[2];
  }
}

/**
 * @param src { pos, idx }  @param opt { target: quads, smooth: relax passes }
 * @returns { pos, idx (triangles), polys: { start, idx } (quads/tris/n-gons), stats }
 */
export function fieldRetopo(src, opt) {
  // target edge length from area
  let area = 0; const sp = src.pos, si = src.idx;
  for (let f = 0; f < si.length; f += 3) {
    const a = si[f]*3, b = si[f+1]*3, c = si[f+2]*3;
    const ux = sp[b]-sp[a], uy = sp[b+1]-sp[a+1], uz = sp[b+2]-sp[a+2], wx = sp[c]-sp[a], wy = sp[c+1]-sp[a+1], wz = sp[c+2]-sp[a+2];
    area += Math.hypot(uy*wz - uz*wy, uz*wx - ux*wz, ux*wy - uy*wx) / 2;
  }
  const s = Math.sqrt(area / Math.max(50, opt.target));
  // uniform working mesh, ~2.5 samples per lattice spacing
  let mx = [Infinity, Infinity, Infinity], MX = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < sp.length; i += 3) for (let k = 0; k < 3; k++) { mx[k] = Math.min(mx[k], sp[i+k]); MX[k] = Math.max(MX[k], sp[i+k]); }
  const ext = Math.max(MX[0]-mx[0], MX[1]-mx[1], MX[2]-mx[2]);
  const res = Math.min(300, Math.max(24, Math.round(ext / (s / 2.5))));
  const W = remesh({ pos: sp, idx: si }, { res, project: true, smooth: 2 });
  if (!W) return null;
  const V = W.pos, N = vertexNormals(V, W.idx), adj = buildNeighbors(V.length / 3, W.idx);
  const levels = buildHierarchy(V, N, adj);

  // orientation field: random init at the coarsest level, smooth, prolong
  let rnd = 12345; const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  let Q = null;
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l], n = L.V.length / 3, q = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = Q ? get(Q, L.parent[i]) : [rand(), rand(), rand()];
      const ni = get(L.N, i), d = v[0]*ni[0] + v[1]*ni[1] + v[2]*ni[2];
      let w = [v[0] - ni[0]*d, v[1] - ni[1]*d, v[2] - ni[2]*d], len = Math.hypot(w[0], w[1], w[2]);
      if (len < 1e-8) { w = Math.abs(ni[0]) < 0.9 ? [0, -ni[2], ni[1]] : [ni[2], 0, -ni[0]]; len = Math.hypot(w[0], w[1], w[2]); }
      q[i*3] = w[0]/len; q[i*3+1] = w[1]/len; q[i*3+2] = w[2]/len;
    }
    smoothOrientations(L, q, l === 0 ? 24 : 12);
    Q = q;
  }
  // position field with the same hierarchy
  let O = null; const Qs = [];
  { let q = Q; Qs[0] = q; for (let l = 1; l < levels.length; l++) { const L = levels[l - 1], n = levels[l].V.length / 3, cq = new Float32Array(n * 3);
      for (let i = 0; i < L.V.length / 3; i++) { const p = L.parent[i]; if (!cq[p*3] && !cq[p*3+1] && !cq[p*3+2]) { cq[p*3] = q[i*3]; cq[p*3+1] = q[i*3+1]; cq[p*3+2] = q[i*3+2]; } }
      q = cq; Qs[l] = q; } }
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l], n = L.V.length / 3, o = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const vi = get(L.V, i), ni = get(L.N, i), qi = get(Qs[l], i);
      let src0 = O ? get(O, L.parent[i]) : vi;
      const d = (src0[0]-vi[0])*ni[0] + (src0[1]-vi[1])*ni[1] + (src0[2]-vi[2])*ni[2];
      src0 = [src0[0] - ni[0]*d, src0[1] - ni[1]*d, src0[2] - ni[2]*d];
      const r = floor4(src0, qi, ni, vi, s, true);
      o[i*3] = r[0]; o[i*3+1] = r[1]; o[i*3+2] = r[2];
    }
    smoothPositions(L, Qs[l], o, s, l === 0 ? 24 : 12);
    O = o;
  }

  // ---- extraction
  const n = V.length / 3, uf = new Int32Array(n).map((_, i) => i);
  const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  const edgesUV = [];
  for (let i = 0; i < n; i++) for (let j = adj.start[i]; j < adj.start[i + 1]; j++) {
    const u = adj.list[j]; if (u < i) continue;
    const vi = get(V, i), ni = get(N, i), qi = get(Q, i), oi = get(O, i), vu = get(V, u), nu = get(N, u), qu = get(Q, u), ou = get(O, u);
    const [a, b] = compatPos(vi, ni, qi, oi, vu, nu, qu, ou, s);
    // lattice offset between the two vertices' lattice points, expressed in i's frame
    const D = [(a[0]-oi[0]) - (b[0]-ou[0]), (a[1]-oi[1]) - (b[1]-ou[1]), (a[2]-oi[2]) - (b[2]-ou[2])];
    const ti = cross(ni, qi);
    const du = Math.round((D[0]*qi[0] + D[1]*qi[1] + D[2]*qi[2]) / s), dv = Math.round((D[0]*ti[0] + D[1]*ti[1] + D[2]*ti[2]) / s);
    if (du === 0 && dv === 0) { const x = find(i), y = find(u); if (x !== y) uf[x] = y; }
    else if (Math.abs(du) + Math.abs(dv) === 1) edgesUV.push(i, u);
  }
  const cid = new Int32Array(n).fill(-1); let m = 0;
  for (let i = 0; i < n; i++) { const r = find(i); if (cid[r] < 0) cid[r] = m++; cid[i] = cid[r]; }
  const P = new Float32Array(m * 3), PN = new Float32Array(m * 3), cnt = new Float32Array(m);
  for (let i = 0; i < n; i++) { const c = cid[i]; cnt[c]++; for (let k = 0; k < 3; k++) { P[c*3+k] += O[i*3+k]; PN[c*3+k] += N[i*3+k]; } }
  for (let c = 0; c < m; c++) { for (let k = 0; k < 3; k++) P[c*3+k] /= cnt[c]; const l = Math.hypot(PN[c*3], PN[c*3+1], PN[c*3+2]) || 1; PN[c*3] /= l; PN[c*3+1] /= l; PN[c*3+2] /= l; }
  const nbr = Array.from({ length: m }, () => new Set());
  for (let e = 0; e < edgesUV.length; e += 2) { const a = cid[edgesUV[e]], b = cid[edgesUV[e+1]]; if (a !== b) { nbr[a].add(b); nbr[b].add(a); } }
  // angular order of neighbours around each vertex (counter-clockwise about its normal)
  const ring = nbr.map((set, c) => {
    const nn = get(PN, c), t = Math.abs(nn[0]) < 0.9 ? cross(nn, [1, 0, 0]) : cross(nn, [0, 1, 0]);
    const tl = Math.hypot(...t), tx = [t[0]/tl, t[1]/tl, t[2]/tl], ty = cross(nn, tx);
    return [...set].map(u => { const d = [P[u*3]-P[c*3], P[u*3+1]-P[c*3+1], P[u*3+2]-P[c*3+2]]; return [u, Math.atan2(d[0]*ty[0]+d[1]*ty[1]+d[2]*ty[2], d[0]*tx[0]+d[1]*tx[1]+d[2]*tx[2])]; })
      .sort((p, q) => p[1] - q[1]).map(x => x[0]);
  });
  const pos = ring.map(r => new Map(r.map((u, k) => [u, k])));
  // trace faces: from half-edge (u -> v) continue to the neighbour of v that precedes u counter-clockwise
  const used = new Set(), polys = [];
  for (let u = 0; u < m; u++) for (const v of ring[u]) {
    const k0 = u * m + v; if (used.has(k0)) continue;
    const face = [u]; let a = u, b = v, closed = false;
    for (let steps = 0; steps < 12; steps++) {
      used.add(a * m + b); face.push(b);
      const r = ring[b], i = pos[b].get(a);
      if (i === undefined || r.length < 2) break;
      const c = r[(i - 1 + r.length) % r.length];
      a = b; b = c;
      if (b === u) { used.add(a * m + b); closed = true; break; }
    }
    if (closed && face.length >= 3) polys.push(face);
  }
  // triangulate: quads by the shorter diagonal, others as a fan (n-gons > 4 get a center vertex)
  const outP = Array.from(P), tri = [], polyStart = [0], polyIdx = [];
  for (const f of polys) {
    if (f.length <= 4) { for (const v of f) polyIdx.push(v); polyStart.push(polyIdx.length); }
    if (f.length === 3) tri.push(f[0], f[1], f[2]);
    else if (f.length === 4) {
      const d02 = (P[f[0]*3]-P[f[2]*3])**2 + (P[f[0]*3+1]-P[f[2]*3+1])**2 + (P[f[0]*3+2]-P[f[2]*3+2])**2;
      const d13 = (P[f[1]*3]-P[f[3]*3])**2 + (P[f[1]*3+1]-P[f[3]*3+1])**2 + (P[f[1]*3+2]-P[f[3]*3+2])**2;
      if (d02 <= d13) tri.push(f[0], f[1], f[2], f[0], f[2], f[3]); else tri.push(f[0], f[1], f[3], f[1], f[2], f[3]);
    } else {
      const c = outP.length / 3; let cx = 0, cy = 0, cz = 0;
      for (const v of f) { cx += P[v*3]; cy += P[v*3+1]; cz += P[v*3+2]; }
      outP.push(cx / f.length, cy / f.length, cz / f.length);
      for (let k = 0; k < f.length; k++) { tri.push(f[k], f[(k+1) % f.length], c); polyIdx.push(f[k], f[(k+1) % f.length], c); polyStart.push(polyIdx.length); }
    }
  }
  let Pout = new Float32Array(outP), I = new Uint32Array(tri);
  // drop unreferenced vertices
  const usedV = new Int32Array(Pout.length / 3).fill(-1); let nv = 0;
  for (const v of I) if (usedV[v] < 0) usedV[v] = nv++;
  const P2 = new Float32Array(nv * 3);
  for (let v = 0; v < usedV.length; v++) if (usedV[v] >= 0) { P2[usedV[v]*3] = Pout[v*3]; P2[usedV[v]*3+1] = Pout[v*3+1]; P2[usedV[v]*3+2] = Pout[v*3+2]; }
  I = I.map(v => usedV[v]); const PI = Uint32Array.from(polyIdx, v => usedV[v]);
  // relax along polygon edges and snap to the source surface
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(sp, 3)); g.setIndex(new THREE.BufferAttribute(si.slice(), 1));
  const bvh = new MeshBVH(g), q = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const edgeN = Array.from({ length: nv }, () => new Set());
  const PS = Uint32Array.from(polyStart);
  for (let f = 0; f + 1 < PS.length; f++) { const a = PS[f], b = PS[f + 1]; for (let k = a; k < b; k++) { const x = PI[k], y = PI[k + 1 < b ? k + 1 : a]; edgeN[x].add(y); edgeN[y].add(x); } }
  const snap = () => { for (let v = 0; v < nv; v++) { q.fromArray(P2, v * 3); if (bvh.closestPointToPoint(q, hit, 0, s * 2)) hit.point.toArray(P2, v * 3); } };
  snap();
  for (let it = 0; it < (opt.smooth ?? 6); it++) {
    const Nn = vertexNormals(P2, I), np = P2.slice();
    for (let v = 0; v < nv; v++) {
      const set = edgeN[v]; if (!set.size) continue;
      let ax = 0, ay = 0, az = 0; for (const u of set) { ax += P2[u*3]; ay += P2[u*3+1]; az += P2[u*3+2]; }
      let dx = ax / set.size - P2[v*3], dy = ay / set.size - P2[v*3+1], dz = az / set.size - P2[v*3+2];
      const d = dx*Nn[v*3] + dy*Nn[v*3+1] + dz*Nn[v*3+2]; dx -= Nn[v*3]*d; dy -= Nn[v*3+1]*d; dz -= Nn[v*3+2]*d;
      np[v*3] += dx * 0.5; np[v*3+1] += dy * 0.5; np[v*3+2] += dz * 0.5;
    }
    P2.set(np); snap();
  }
  g.dispose();
  let quads = 0, tris = 0, ngons = 0; for (const f of polys) { if (f.length === 4) quads++; else if (f.length === 3) tris++; else ngons++; }
  return { pos: P2, idx: I, polys: { start: PS, idx: PI }, stats: { quads, tris, ngons, working: n } };
}
