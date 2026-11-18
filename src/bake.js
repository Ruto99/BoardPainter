// Bake a high-resolution surface onto a UV-mapped low-resolution mesh:
//  * normal map (tangent space, OpenGL / glTF convention: +Y up in the texture)
//  * color map from the high mesh's vertex colors (polypaint), if it has any
//  * height (displacement) map: signed distance from the low surface to the high one along the normal
// For every texel covered by a low-poly triangle in UV space we take the point and smooth normal on the
// low mesh, cast a ray from just outside it back along -normal, and read the high mesh where it hits.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { tryAccel } from './remesh.js';

const lin2srgb = x => x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

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

/**
 * @param low  { pos, uvIdx, uv }            low mesh (faces = uvIdx, per-corner uv)
 * @param high { pos, idx, paint? }          high mesh (may be the same object as low at a higher level, or another subtool)
 * @param opt  { size, maxDist }             texture size (px); search distance (world units)
 * @returns { normal: Uint8ClampedArray, color: Uint8ClampedArray|null, hits, misses }
 */
export function bakeMaps(low, high, opt) {
  const S = opt.size, maxD = opt.maxDist;
  const f32 = a => a instanceof Float32Array ? a : Float32Array.from(a), u32 = a => a instanceof Uint32Array ? a : Uint32Array.from(a);
  const nat = tryAccel('bake', [f32(low.pos), u32(low.uvIdx), f32(low.uv), f32(high.pos), u32(high.idx), high.paint ? f32(high.paint) : null, S, maxD, opt.dilate ?? 8]);
  if (nat) return nat;   // desktop: C++ on all cores
  const lp = low.pos, li = low.uvIdx, uv = low.uv, nF = li.length / 3;
  const ln = vertexNormals(lp, li);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(high.pos, 3));
  g.setIndex(new THREE.BufferAttribute(high.idx.slice(), 1));
  const bvh = new MeshBVH(g), hi = g.index.array, hn = vertexNormals(high.pos, hi), hp = high.paint || null;
  const nrm = new Uint8ClampedArray(S * S * 4), col = hp ? new Uint8ClampedArray(S * S * 4) : null;
  const filled = new Uint8Array(S * S), hgt = new Float32Array(S * S);
  const ray = new THREE.Ray(), P = new THREE.Vector3(), N = new THREE.Vector3(), T = new THREE.Vector3(), B = new THREE.Vector3();
  const tri = new THREE.Triangle(), bc = new THREE.Vector3(), A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3();
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  let hits = 0, misses = 0;
  for (let f = 0; f < nF; f++) {
    const ia = li[f*3], ib = li[f*3+1], ic = li[f*3+2];
    const u0 = uv[f*6] * S, v0 = uv[f*6+1] * S, u1 = uv[f*6+2] * S, v1 = uv[f*6+3] * S, u2 = uv[f*6+4] * S, v2 = uv[f*6+5] * S;
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(det) < 1e-12) continue;
    // face tangent frame from UV derivatives: dP/du, dP/dv
    const e1x = lp[ib*3]-lp[ia*3], e1y = lp[ib*3+1]-lp[ia*3+1], e1z = lp[ib*3+2]-lp[ia*3+2];
    const e2x = lp[ic*3]-lp[ia*3], e2y = lp[ic*3+1]-lp[ia*3+1], e2z = lp[ic*3+2]-lp[ia*3+2];
    const du1 = (u1 - u0) / S, dv1 = (v1 - v0) / S, du2 = (u2 - u0) / S, dv2 = (v2 - v0) / S, r = 1 / (du1 * dv2 - du2 * dv1);
    const Tx = (e1x * dv2 - e2x * dv1) * r, Ty = (e1y * dv2 - e2y * dv1) * r, Tz = (e1z * dv2 - e2z * dv1) * r;
    const Bx = (e2x * du1 - e1x * du2) * r, By = (e2y * du1 - e1y * du2) * r, Bz = (e2z * du1 - e1z * du2) * r;
    const x0 = Math.max(0, Math.floor(Math.min(u0, u1, u2))), x1 = Math.min(S - 1, Math.ceil(Math.max(u0, u1, u2)));
    const y0 = Math.max(0, Math.floor(Math.min(v0, v1, v2))), y1 = Math.min(S - 1, Math.ceil(Math.max(v0, v1, v2)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w1 = ((px - u0) * (v2 - v0) - (u2 - u0) * (py - v0)) / det, w2 = ((u1 - u0) * (py - v0) - (px - u0) * (v1 - v0)) / det, w0 = 1 - w1 - w2;
      const eps = -0.5 / Math.sqrt(Math.abs(det));   // half a texel of slack so edges are covered
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      const k = (S - 1 - y) * S + x;                  // image rows are top-down, v is bottom-up
      if (filled[k]) continue;
      P.set(lp[ia*3]*w0 + lp[ib*3]*w1 + lp[ic*3]*w2, lp[ia*3+1]*w0 + lp[ib*3+1]*w1 + lp[ic*3+1]*w2, lp[ia*3+2]*w0 + lp[ib*3+2]*w1 + lp[ic*3+2]*w2);
      N.set(ln[ia*3]*w0 + ln[ib*3]*w1 + ln[ic*3]*w2, ln[ia*3+1]*w0 + ln[ib*3+1]*w1 + ln[ic*3+1]*w2, ln[ia*3+2]*w0 + ln[ib*3+2]*w1 + ln[ic*3+2]*w2).normalize();
      T.set(Tx, Ty, Tz).addScaledVector(N, -N.dot(T.set(Tx, Ty, Tz))).normalize();
      B.set(Bx, By, Bz); const handed = B.dot(new THREE.Vector3().crossVectors(N, T)) < 0 ? -1 : 1;
      B.crossVectors(N, T).multiplyScalar(handed);
      // find the high surface along the normal (from outside in), else the closest point
      ray.origin.copy(P).addScaledVector(N, maxD); ray.direction.copy(N).negate();
      let h = bvh.raycastFirst(ray, THREE.DoubleSide), face, point;
      if (h && h.distance <= 2 * maxD) { face = h.faceIndex; point = h.point; }
      else if (bvh.closestPointToPoint(P, hit, 0, maxD * 2)) { face = hit.faceIndex; point = hit.point; }
      else { misses++; continue; }
      hits++;
      const a = hi[face*3], b = hi[face*3+1], c = hi[face*3+2];
      tri.set(A.fromArray(high.pos, a*3), Bv.fromArray(high.pos, b*3), C.fromArray(high.pos, c*3)).getBarycoord(point, bc);
      const hx = hn[a*3]*bc.x + hn[b*3]*bc.y + hn[c*3]*bc.z, hy = hn[a*3+1]*bc.x + hn[b*3+1]*bc.y + hn[c*3+1]*bc.z, hz = hn[a*3+2]*bc.x + hn[b*3+2]*bc.y + hn[c*3+2]*bc.z;
      const hl = Math.hypot(hx, hy, hz) || 1;
      const tn = [(hx*T.x + hy*T.y + hz*T.z) / hl, (hx*B.x + hy*B.y + hz*B.z) / hl, (hx*N.x + hy*N.y + hz*N.z) / hl];
      nrm[k*4] = (tn[0] * 0.5 + 0.5) * 255; nrm[k*4+1] = (tn[1] * 0.5 + 0.5) * 255; nrm[k*4+2] = (tn[2] * 0.5 + 0.5) * 255; nrm[k*4+3] = 255;
      if (col) for (let q = 0; q < 3; q++) col[k*4+q] = lin2srgb(hp[a*3+q]*bc.x + hp[b*3+q]*bc.y + hp[c*3+q]*bc.z) * 255;
      if (col) col[k*4+3] = 255;
      hgt[k] = (point.x - P.x) * N.x + (point.y - P.y) * N.y + (point.z - P.z) * N.z;
      filled[k] = 1;
    }
  }
  g.dispose();
  // dilate: grow chart borders outward so mip-mapping/filtering doesn't pull in the background
  for (let it = 0; it < (opt.dilate ?? 8); it++) {
    const add = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = y * S + x; if (filled[k]) continue;
      let n = 0, s0 = 0, s1 = 0, s2 = 0, c0 = 0, c1 = 0, c2 = 0, hh = 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
        const q = yy * S + xx; if (!filled[q]) continue;
        n++; s0 += nrm[q*4]; s1 += nrm[q*4+1]; s2 += nrm[q*4+2]; hh += hgt[q];
        if (col) { c0 += col[q*4]; c1 += col[q*4+1]; c2 += col[q*4+2]; }
      }
      if (n) add.push(k, s0 / n, s1 / n, s2 / n, c0 / n, c1 / n, c2 / n, hh / n);
    }
    if (!add.length) break;
    for (let i = 0; i < add.length; i += 8) {
      const k = add[i]; filled[k] = 1; hgt[k] = add[i+7]; nrm[k*4] = add[i+1]; nrm[k*4+1] = add[i+2]; nrm[k*4+2] = add[i+3]; nrm[k*4+3] = 255;
      if (col) { col[k*4] = add[i+4]; col[k*4+1] = add[i+5]; col[k*4+2] = add[i+6]; col[k*4+3] = 255; }
    }
  }
  // empty texels: flat normal / neutral color
  for (let k = 0; k < S * S; k++) if (!filled[k]) { nrm[k*4] = 128; nrm[k*4+1] = 128; nrm[k*4+2] = 255; nrm[k*4+3] = 255; if (col) { col[k*4] = col[k*4+1] = col[k*4+2] = 128; col[k*4+3] = 255; } }
  // height as 8-bit grey: 128 = on the low surface, 0 / 255 = -range / +range
  let range = 0; for (let k = 0; k < S * S; k++) if (filled[k]) range = Math.max(range, Math.abs(hgt[k]));
  const height = new Uint8ClampedArray(S * S * 4);
  for (let k = 0; k < S * S; k++) { const g = range > 0 && filled[k] ? 128 + hgt[k] / range * 127 : 128; height[k*4] = height[k*4+1] = height[k*4+2] = g; height[k*4+3] = 255; }
  return { normal: nrm, color: col, height, heightRange: range, hits, misses };
}
