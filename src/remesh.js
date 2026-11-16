// Voxel remesh (DynaMesh-style): rebuild a mesh as an evenly tessellated closed surface.
//  1. inside/outside on a regular grid by ray winding numbers along X, Y and Z (majority vote),
//     so overlapping closed parts become one solid and small holes are tolerated
//  2. Surface Nets: one vertex per boundary cell, one quad per sign-changing grid edge
//  3. optional: snap vertices back onto the source surface + tangential relaxation (keeps detail)
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

// Grid sampling for a given resolution (cells along the longest side).
// symX: lay the grid out mirror-symmetrically about x = 0 (so symmetric input gives a symmetric result)
export function remeshGrid(pos, res, symX = false) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i+1], z = pos[i+2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const h = Math.max(mxx - mnx, mxy - mny, mxz - mnz, 1e-6) / res;
  const pad = 2;
  const o = [mnx - pad * h, mny - pad * h, mnz - pad * h];
  const n = [Math.ceil((mxx - mnx) / h) + 2 * pad + 1, Math.ceil((mxy - mny) / h) + 2 * pad + 1, Math.ceil((mxz - mnz) / h) + 2 * pad + 1];
  if (symX) { const half = Math.ceil(Math.max(Math.abs(mnx), Math.abs(mxx)) / h) + pad; n[0] = 2 * half + 1; o[0] = -half * h; }
  return { h, o, n, voxels: n[0] * n[1] * n[2] };
}

// inside[] for grid points, by winding number along one axis (adds 1 to votes where inside)
function windingAlongAxis(pos, idx, G, a, votes) {
  const u = (a + 1) % 3, v = (a + 2) % 3, [nu, nv, na] = [G.n[u], G.n[v], G.n[a]];
  const h = G.h, ou = G.o[u], ov = G.o[v], oa = G.o[a];
  // tiny irrational offsets keep rays off vertices/edges (no double counting)
  const ju = 0.000137, jv = 0.000291;
  const cols = nu * nv, count = new Uint32Array(cols + 1);
  const nF = idx.length / 3;
  const forEachHit = (cb) => {
    for (let f = 0; f < nF; f++) {
      const A = idx[f*3]*3, B = idx[f*3+1]*3, C = idx[f*3+2]*3;
      const au = pos[A+u], av = pos[A+v], bu = pos[B+u], bv = pos[B+v], cu = pos[C+u], cv = pos[C+v];
      const det = (bu - au) * (cv - av) - (cu - au) * (bv - av);
      if (det === 0) continue;
      const i0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - ou) / h - ju)), i1 = Math.min(nu - 1, Math.floor((Math.max(au, bu, cu) - ou) / h - ju));
      const j0 = Math.max(0, Math.ceil((Math.min(av, bv, cv) - ov) / h - jv)), j1 = Math.min(nv - 1, Math.floor((Math.max(av, bv, cv) - ov) / h - jv));
      if (i0 > i1 || j0 > j1) continue;
      const s = det > 0 ? 1 : -1; // facing +a or -a
      for (let j = j0; j <= j1; j++) {
        const pv = ov + (j + jv) * h;
        for (let i = i0; i <= i1; i++) {
          const pu = ou + (i + ju) * h;
          const w1 = ((pu - au) * (cv - av) - (cu - au) * (pv - av)) / det;
          const w2 = ((bu - au) * (pv - av) - (pu - au) * (bv - av)) / det;
          if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
          cb(i + nu * j, pos[A+a] + (pos[B+a] - pos[A+a]) * w1 + (pos[C+a] - pos[A+a]) * w2, s);
        }
      }
    }
  };
  forEachHit(c => { count[c + 1]++; });
  for (let c = 0; c < cols; c++) count[c + 1] += count[c];
  const depth = new Float32Array(count[cols]), sign = new Int8Array(count[cols]), fill = count.slice(0, cols);
  forEachHit((c, t, s) => { const k = fill[c]++; depth[k] = t; sign[k] = s; });
  const strideA = a === 0 ? 1 : a === 1 ? G.n[0] : G.n[0] * G.n[1];
  const strideU = u === 0 ? 1 : u === 1 ? G.n[0] : G.n[0] * G.n[1];
  const strideV = v === 0 ? 1 : v === 1 ? G.n[0] : G.n[0] * G.n[1];
  const tmpD = [], tmpS = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const c = i + nu * j, s0 = count[c], s1 = count[c + 1];
    if (s0 === s1) continue;
    tmpD.length = tmpS.length = 0;
    for (let k = s0; k < s1; k++) { tmpD.push(depth[k]); tmpS.push(sign[k]); }
    const order = tmpD.map((_, k) => k).sort((p, q) => tmpD[p] - tmpD[q]);
    let w = 0, m = 0, base = i * strideU + j * strideV;
    for (let k = 0; k < na; k++) {
      const t = oa + k * h;
      while (m < order.length && tmpD[order[m]] < t) { w += tmpS[order[m]]; m++; }
      if (w !== 0) votes[base + k * strideA]++;
    }
  }
}

export function voxelize(pos, idx, G) {
  const votes = new Uint8Array(G.voxels);
  for (let a = 0; a < 3; a++) windingAlongAxis(pos, idx, G, a, votes);
  for (let i = 0; i < votes.length; i++) votes[i] = votes[i] >= 2 ? 1 : 0;
  return votes;
}

// Surface Nets over the inside[] grid -> indexed triangle mesh
export function surfaceNets(inside, G) {
  const [nx, ny, nz] = G.n, h = G.h, [ox, oy, oz] = G.o;
  const sx = 1, sy = nx, sz = nx * ny;
  const cellV = new Int32Array(G.voxels).fill(-1);
  const P = [];
  const corner = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const edges = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  const val = new Uint8Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const g = i + j * sy + k * sz;
    let m = 0;
    for (let c = 0; c < 8; c++) { val[c] = inside[g + corner[c][0] * sx + corner[c][1] * sy + corner[c][2] * sz]; m |= val[c] << c; }
    if (m === 0 || m === 255) continue;
    let px = 0, py = 0, pz = 0, cnt = 0;
    for (const [e0, e1] of edges) if (val[e0] !== val[e1]) {
      px += (corner[e0][0] + corner[e1][0]) / 2; py += (corner[e0][1] + corner[e1][1]) / 2; pz += (corner[e0][2] + corner[e1][2]) / 2; cnt++;
    }
    cellV[g] = P.length / 3;
    P.push(ox + (i + px / cnt) * h, oy + (j + py / cnt) * h, oz + (k + pz / cnt) * h);
  }
  const I = [], Q = [];
  const quad = (a, b, c, d) => {
    Q.push(a, b, c, d);
    // split along the shorter diagonal
    const dac = (P[a*3]-P[c*3])**2 + (P[a*3+1]-P[c*3+1])**2 + (P[a*3+2]-P[c*3+2])**2;
    const dbd = (P[b*3]-P[d*3])**2 + (P[b*3+1]-P[d*3+1])**2 + (P[b*3+2]-P[d*3+2])**2;
    if (dac <= dbd) I.push(a, b, c, a, c, d); else I.push(a, b, d, b, c, d);
  };
  const S = [sx, sy, sz];
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const g = i + j * sy + k * sz, here = inside[g];
    for (let d = 0; d < 3; d++) {
      if (here === inside[g + S[d]]) continue;
      const du = S[(d + 1) % 3], dv = S[(d + 2) % 3];
      const c0 = cellV[g - du - dv], c1 = cellV[g - dv], c2 = cellV[g], c3 = cellV[g - du];
      if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) continue;
      if (here) quad(c0, c1, c2, c3); else quad(c0, c3, c2, c1);
    }
  }
  return { pos: new Float32Array(P), idx: new Uint32Array(I), quads: new Uint32Array(Q) };
}

function neighbors(nV, idx) {
  const start = new Uint32Array(nV + 1), seen = new Int32Array(nV).fill(-1);
  for (let f = 0; f < idx.length; f += 3) for (let k = 0; k < 3; k++) { start[idx[f+k] + 1] += 2; }
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const raw = new Uint32Array(start[nV]), fill = start.slice(0, nV);
  for (let f = 0; f < idx.length; f += 3) for (let k = 0; k < 3; k++) {
    const a = idx[f+k], b = idx[f+(k+1)%3], c = idx[f+(k+2)%3];
    raw[fill[a]++] = b; raw[fill[a]++] = c;
  }
  // dedupe per vertex
  const outStart = new Uint32Array(nV + 1), out = [];
  for (let v = 0; v < nV; v++) {
    outStart[v] = out.length;
    for (let j = start[v]; j < start[v + 1]; j++) { const u = raw[j]; if (seen[u] !== v) { seen[u] = v; out.push(u); } }
  }
  outStart[nV] = out.length;
  return { start: outStart, list: Uint32Array.from(out) };
}

/**
 * Remesh a triangle mesh.
 * @param src { pos: Float32Array, idx: Uint32Array, mask?: Float32Array }
 * @param opt { res: cells along the longest side, project: snap to the source surface, smooth: relax passes }
 * @returns { pos, idx, mask, info }
 */
export function remesh(src, opt) {
  const G = remeshGrid(src.pos, opt.res, !!opt.symX);
  return surfaceFromField(voxelize(src.pos, src.idx, G), G, src, opt, false);
}

/**
 * Voxel boolean of two closed meshes: 'union' | 'subtract' (a minus b) | 'intersect'.
 * Same pipeline as remesh; vertices snap only to source faces that lie on the result's boundary,
 * which recovers the sharp edges where the two surfaces cross.
 */
export function booleanMesh(a, b, op, opt) {
  const nA = a.pos.length / 3, nB = b.pos.length / 3;
  const pos = new Float32Array((nA + nB) * 3); pos.set(a.pos); pos.set(b.pos, nA * 3);
  const idx = new Uint32Array(a.idx.length + b.idx.length); idx.set(a.idx);
  for (let i = 0; i < b.idx.length; i++) idx[a.idx.length + i] = b.idx[i] + nA;
  const mask = new Float32Array(nA + nB); if (a.mask) mask.set(a.mask); if (b.mask) mask.set(b.mask, nA);
  let paint = null;
  if (a.paint || b.paint) {
    const base = opt.base || [0.7, 0.55, 0.4], fill = n => { const t = new Float32Array(n * 3); for (let i = 0; i < t.length; i += 3) { t[i] = base[0]; t[i+1] = base[1]; t[i+2] = base[2]; } return t; };
    paint = new Float32Array(pos.length); paint.set(a.paint || fill(nA)); paint.set(b.paint || fill(nB), nA * 3);
  }
  // voxel size from the selected part (a); grid only over the region the result can occupy
  const bb = p => { const m = [Infinity, Infinity, Infinity], M = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i+k] < m[k]) m[k] = p[i+k]; if (p[i+k] > M[k]) M[k] = p[i+k]; } return [m, M]; };
  const [am, aM] = bb(a.pos), [bm, bM] = bb(b.pos);
  const h = Math.max(aM[0] - am[0], aM[1] - am[1], aM[2] - am[2], 1e-6) / opt.res;
  let lo = am, hi = aM;
  if (op === 'union') { lo = am.map((v, k) => Math.min(v, bm[k])); hi = aM.map((v, k) => Math.max(v, bM[k])); }
  if (op === 'intersect') { lo = am.map((v, k) => Math.max(v, bm[k])); hi = aM.map((v, k) => Math.min(v, bM[k])); if (lo.some((v, k) => v >= hi[k])) return null; }
  const pad = 2, o = lo.map(v => v - pad * h), n = lo.map((v, k) => Math.ceil((hi[k] - v) / h) + 2 * pad + 1);
  const G = { h, o, n, voxels: n[0] * n[1] * n[2] };
  if (G.voxels > (opt.voxelLimit || 4e7)) return null;
  const ia = voxelize(a.pos, a.idx, G), ib = voxelize(b.pos, b.idx, G), inside = new Uint8Array(G.voxels);
  let any = 0;
  for (let i = 0; i < inside.length; i++) any |= inside[i] = op === 'union' ? ia[i] | ib[i] : op === 'subtract' ? ia[i] & (1 - ib[i]) : ia[i] & ib[i];
  if (!any) return null;
  return surfaceFromField(inside, G, { pos, idx, mask, paint }, opt, true);
}

// Extract the surface of an inside/outside grid and fit it to the source mesh.
// strict: source faces count as boundary only if exactly one side is inside (booleans);
//         otherwise only faces buried on both sides are excluded (remesh / fuse keeps thin sheets).
function surfaceFromField(inside, G, src, opt, strict) {
  const out = surfaceNets(inside, G);
  const nV = out.pos.length / 3;
  if (!nV || !out.idx.length) return null;

  // source BVH for closest-point queries (snapping and mask transfer)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(src.pos, 3));
  g.setIndex(new THREE.BufferAttribute(src.idx.slice(), 1));
  const bvh = new MeshBVH(g);
  const sIdx = g.index.array;
  const P = out.pos, nb = neighbors(nV, out.idx);
  const q = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const maxSnap = G.h * 1.5;
  // inside test at an arbitrary point (nearest grid sample)
  const [gx, gy, gz] = G.n;
  const insideAt = (x, y, z) => {
    const i = Math.round((x - G.o[0]) / G.h), j = Math.round((y - G.o[1]) / G.h), k = Math.round((z - G.o[2]) / G.h);
    if (i < 0 || j < 0 || k < 0 || i >= gx || j >= gy || k >= gz) return false;
    return inside[i + gx * (j + gy * k)] === 1;
  };
  // Source faces that ended up buried inside the solid (where overlapping parts were fused) must not attract vertices:
  // a point just outside such a face along its normal is still inside the solid.
  const buried = new Uint8Array(sIdx.length / 3);
  for (let f = 0; f < buried.length; f++) {
    const a = sIdx[f*3]*3, b = sIdx[f*3+1]*3, c = sIdx[f*3+2]*3, sp = src.pos;
    const ux = sp[b]-sp[a], uy = sp[b+1]-sp[a+1], uz = sp[b+2]-sp[a+2], wx = sp[c]-sp[a], wy = sp[c+1]-sp[a+1], wz = sp[c+2]-sp[a+2];
    let nx = uy*wz - uz*wy, ny = uz*wx - ux*wz, nz = ux*wy - uy*wx; const l = Math.hypot(nx, ny, nz); if (!l) continue;
    nx /= l; ny /= l; nz /= l;
    const cx = (sp[a] + sp[b] + sp[c]) / 3, cy = (sp[a+1] + sp[b+1] + sp[c+1]) / 3, cz = (sp[a+2] + sp[b+2] + sp[c+2]) / 3, d = G.h * 1.5;
    const o = insideAt(cx + nx * d, cy + ny * d, cz + nz * d), i = insideAt(cx - nx * d, cy - ny * d, cz - nz * d);
    if ((o && i) || (strict && !o && !i)) buried[f] = 1;
  }
  const snap = () => {
    for (let v = 0; v < nV; v++) {
      q.set(P[v*3], P[v*3+1], P[v*3+2]);
      if (bvh.closestPointToPoint(q, hit, 0, maxSnap) && !buried[hit.faceIndex]) { P[v*3] = hit.point.x; P[v*3+1] = hit.point.y; P[v*3+2] = hit.point.z; }
    }
  };
  const relax = () => {
    const nrm = new Float32Array(P.length), I = out.idx;
    for (let f = 0; f < I.length; f += 3) {
      const a = I[f]*3, b = I[f+1]*3, c = I[f+2]*3;
      const ux = P[b]-P[a], uy = P[b+1]-P[a+1], uz = P[b+2]-P[a+2], wx = P[c]-P[a], wy = P[c+1]-P[a+1], wz = P[c+2]-P[a+2];
      const x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx;
      for (const t of [a, b, c]) { nrm[t] += x; nrm[t+1] += y; nrm[t+2] += z; }
    }
    const np = P.slice();
    for (let v = 0; v < nV; v++) {
      const s0 = nb.start[v], s1 = nb.start[v + 1]; if (s1 === s0) continue;
      let ax = 0, ay = 0, az = 0;
      for (let j = s0; j < s1; j++) { const u = nb.list[j] * 3; ax += P[u]; ay += P[u+1]; az += P[u+2]; }
      const c = s1 - s0, i = v * 3;
      let dx = ax / c - P[i], dy = ay / c - P[i+1], dz = az / c - P[i+2];
      if (opt.project) { // keep only the tangential part so the shape doesn't shrink
        const l = Math.hypot(nrm[i], nrm[i+1], nrm[i+2]) || 1, nx = nrm[i] / l, ny = nrm[i+1] / l, nz = nrm[i+2] / l, d = dx*nx + dy*ny + dz*nz;
        dx -= nx * d; dy -= ny * d; dz -= nz * d;
      }
      np[i] = P[i] + dx * 0.6; np[i+1] = P[i+1] + dy * 0.6; np[i+2] = P[i+2] + dz * 0.6;
    }
    P.set(np);
  };
  if (opt.project) snap();
  for (let it = 0; it < opt.smooth; it++) { relax(); if (opt.project) snap(); }

  // mask / paint: barycentric from the closest non-buried source triangle
  const mask = new Float32Array(nV), hasMask = src.mask && src.mask.some(m => m > 0), sp = src.paint || null;
  const paint = sp ? new Float32Array(nV * 3) : null;
  if (hasMask || sp) {
    const tri = new THREE.Triangle(), bc = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let v = 0; v < nV; v++) {
      q.set(P[v*3], P[v*3+1], P[v*3+2]);
      if (!bvh.closestPointToPoint(q, hit)) continue;
      const f = hit.faceIndex * 3, ia = sIdx[f], ib = sIdx[f+1], ic = sIdx[f+2];
      if (!Number.isFinite(f)) continue;
      A.fromArray(src.pos, ia * 3); B.fromArray(src.pos, ib * 3); C.fromArray(src.pos, ic * 3);
      tri.set(A, B, C).getBarycoord(hit.point, bc);
      if (hasMask) mask[v] = Math.min(1, Math.max(0, src.mask[ia] * bc.x + src.mask[ib] * bc.y + src.mask[ic] * bc.z));
      if (sp) for (let k = 0; k < 3; k++) paint[v*3+k] = sp[ia*3+k] * bc.x + sp[ib*3+k] * bc.y + sp[ic*3+k] * bc.z;
    }
  }
  g.dispose();
  return { pos: P, idx: out.idx, mask, paint, info: { h: G.h, grid: G.n } };
}

// Quad retopology: about `target` quads, evenly sized, snapped to the source surface.
// The quads follow the voxel grid (no feature-aligned edge flow).
export function quadRemesh(src, opt) {
  let area = 0;
  const p0 = src.pos, i0 = src.idx;
  for (let f = 0; f < i0.length; f += 3) {
    const A = i0[f]*3, B = i0[f+1]*3, C = i0[f+2]*3;
    const ux = p0[B]-p0[A], uy = p0[B+1]-p0[A+1], uz = p0[B+2]-p0[A+2], wx = p0[C]-p0[A], wy = p0[C+1]-p0[A+1], wz = p0[C+2]-p0[A+2];
    area += Math.hypot(uy*wz - uz*wy, uz*wx - ux*wz, ux*wy - uy*wx) / 2;
  }
  const h0 = Math.sqrt(1.5 * area / Math.max(50, opt.target));
  const G0 = remeshGrid(p0, 1, opt.sym);
  const res = Math.max(4, Math.round(G0.h / h0));
  const G = remeshGrid(p0, res, opt.sym);
  if (G.voxels > (opt.voxelLimit || 4e7)) return null;
  const inside = voxelize(p0, i0, G);
  const out = surfaceNets(inside, G);
  const nV = out.pos.length / 3;
  if (!nV) return null;
  const P = out.pos, Q = out.quads;

  // neighbors along quad edges only (no diagonals) -> relaxation makes quads square-ish
  const nb = (() => {
    const start = new Uint32Array(nV + 1);
    for (let q = 0; q < Q.length; q += 4) for (let k = 0; k < 4; k++) start[Q[q+k] + 1] += 2;
    for (let v = 0; v < nV; v++) start[v + 1] += start[v];
    const raw = new Uint32Array(start[nV]), fill = start.slice(0, nV);
    for (let q = 0; q < Q.length; q += 4) for (let k = 0; k < 4; k++) { const a = Q[q+k]; raw[fill[a]++] = Q[q+(k+1)%4]; raw[fill[a]++] = Q[q+(k+3)%4]; }
    const seen = new Int32Array(nV).fill(-1), os = new Uint32Array(nV + 1), list = []; 
    for (let v = 0; v < nV; v++) { os[v] = list.length; for (let j = start[v]; j < start[v + 1]; j++) { const u = raw[j]; if (seen[u] !== v) { seen[u] = v; list.push(u); } } }
    os[nV] = list.length;
    return { start: os, list: Uint32Array.from(list) };
  })();

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p0, 3));
  g.setIndex(new THREE.BufferAttribute(i0.slice(), 1));
  const bvh = new MeshBVH(g);
  const q = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const snap = () => { for (let v = 0; v < nV; v++) { q.fromArray(P, v * 3); if (bvh.closestPointToPoint(q, hit, 0, G.h * 3)) hit.point.toArray(P, v * 3); } };

  // mirror pairs (symmetric grid => symmetric vertices)
  let mir = null;
  if (opt.sym) {
    const key = (x, y, z) => `${Math.round(x / G.h * 4)},${Math.round(y / G.h * 4)},${Math.round(z / G.h * 4)}`;
    const map = new Map();
    for (let v = 0; v < nV; v++) map.set(key(P[v*3], P[v*3+1], P[v*3+2]), v);
    mir = new Int32Array(nV).fill(-1);
    for (let v = 0; v < nV; v++) { const m = map.get(key(-P[v*3], P[v*3+1], P[v*3+2])); if (m !== undefined) mir[v] = m; }
  }
  const symmetrize = () => {
    if (!mir) return;
    for (let v = 0; v < nV; v++) {
      const m = mir[v]; if (m < 0 || m < v) continue;
      if (m === v) { P[v*3] = 0; continue; }
      const x = (P[v*3] - P[m*3]) / 2, y = (P[v*3+1] + P[m*3+1]) / 2, z = (P[v*3+2] + P[m*3+2]) / 2;
      P[v*3] = x; P[v*3+1] = y; P[v*3+2] = z; P[m*3] = -x; P[m*3+1] = y; P[m*3+2] = z;
    }
  };
  const normals = () => {
    const N = new Float32Array(P.length);
    for (let k = 0; k < Q.length; k += 4) {
      const a = Q[k]*3, b = Q[k+1]*3, c = Q[k+2]*3, d = Q[k+3]*3;
      // quad normal from its diagonals
      const ux = P[c]-P[a], uy = P[c+1]-P[a+1], uz = P[c+2]-P[a+2], wx = P[d]-P[b], wy = P[d+1]-P[b+1], wz = P[d+2]-P[b+2];
      const x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx;
      for (const t of [a, b, c, d]) { N[t] += x; N[t+1] += y; N[t+2] += z; }
    }
    return N;
  };
  snap(); symmetrize();
  for (let it = 0; it < opt.smooth; it++) {
    const N = normals(), np = P.slice();
    for (let v = 0; v < nV; v++) {
      const s0 = nb.start[v], s1 = nb.start[v + 1]; if (s1 === s0) continue;
      let ax = 0, ay = 0, az = 0;
      for (let j = s0; j < s1; j++) { const u = nb.list[j] * 3; ax += P[u]; ay += P[u+1]; az += P[u+2]; }
      const c = s1 - s0, i = v * 3, l = Math.hypot(N[i], N[i+1], N[i+2]) || 1, nx = N[i] / l, ny = N[i+1] / l, nz = N[i+2] / l;
      let dx = ax / c - P[i], dy = ay / c - P[i+1], dz = az / c - P[i+2];
      const d = dx*nx + dy*ny + dz*nz; dx -= nx * d; dy -= ny * d; dz -= nz * d;
      np[i] += dx * 0.5; np[i+1] += dy * 0.5; np[i+2] += dz * 0.5;
    }
    P.set(np); snap(); symmetrize();
  }
  g.dispose();
  return { pos: P, idx: out.idx, quads: Q, info: { h: G.h } };
}
