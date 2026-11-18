// ZSphere-style base mesh: spheres joined to their parent by tapered links (round cones),
// blended with a smooth union, then turned into a closed mesh.
//  1. signed distance field of all spheres + links on a regular grid (each primitive only touches its own box)
//  2. Surface Nets on the inside/outside grid (same mesher as the voxel remesh)
//  3. vertices are pulled exactly onto the zero level of the field and lightly relaxed, so the result is smooth
import { remeshGrid, surfaceNets } from './remesh.js';

// round cone between spheres (a, r1) and (b, r2) — exact distance (Inigo Quilez)
function roundCone(a, b, r1, r2) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  if (a2 <= 1e-12) return null;   // one sphere contains the other: the spheres alone cover it
  return (x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2];
    const yy = px * bx + py * by + pz * bz, zz = yy - l2;
    const qx = px * l2 - bx * yy, qy = py * l2 - by * yy, qz = pz * l2 - bz * yy;
    const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}
const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

/**
 * @param nodes [{ p:[x,y,z], r, parent }]  (parent -1 for the root)
 * @param opt { res: grid cells along the longest side, blend: 0..1 smoothness of the joints, symX }
 * @returns { pos: Float32Array, idx: Uint32Array } or null
 */
export function zsphereMesh(nodes, opt = {}) {
  if (!nodes.length) return null;
  const res = opt.res || 128, prims = [];
  let rMin = Infinity;
  for (const n of nodes) {
    rMin = Math.min(rMin, n.r);
    const c = n.p, r = n.r;
    prims.push({ f: (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r, lo: c.map(v => v - r), hi: c.map(v => v + r) });
  }
  for (const n of nodes) {
    if (n.parent < 0) continue;
    const q = nodes[n.parent], f = roundCone(q.p, n.p, q.r, n.r);
    if (f) prims.push({ f, lo: [0, 1, 2].map(k => Math.min(q.p[k] - q.r, n.p[k] - n.r)), hi: [0, 1, 2].map(k => Math.max(q.p[k] + q.r, n.p[k] + n.r)) });
  }
  const K = (opt.blend ?? 0.3) * rMin;
  const sdf = (x, y, z) => { let d = Infinity; for (const p of prims) d = smin(d, p.f(x, y, z), K); return d; };

  // grid over everything (+ blend margin)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.lo[k] - K); hi[k] = Math.max(hi[k], p.hi[k] + K); }
  const G = remeshGrid(new Float32Array([...lo, ...hi]), res, !!opt.symX);
  const [nx, ny, nz] = G.n, h = G.h, [ox, oy, oz] = G.o;
  const field = new Float32Array(G.voxels).fill(1e9);
  for (const p of prims) {
    const i0 = Math.max(0, Math.floor((p.lo[0] - K - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((p.hi[0] + K - ox) / h));
    const j0 = Math.max(0, Math.floor((p.lo[1] - K - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((p.hi[1] + K - oy) / h));
    const k0 = Math.max(0, Math.floor((p.lo[2] - K - oz) / h)), k1 = Math.min(nz - 1, Math.ceil((p.hi[2] + K - oz) / h));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const g = i + nx * (j + ny * k);
      field[g] = smin(field[g], p.f(ox + i * h, oy + j * h, oz + k * h), K);
    }
  }
  const inside = new Uint8Array(G.voxels);
  for (let g = 0; g < inside.length; g++) inside[g] = field[g] < 0 ? 1 : 0;
  const out = surfaceNets(inside, G);
  const P = out.pos, nV = P.length / 3;
  if (!nV) return null;

  // pull every vertex onto the zero level (Newton steps along the numerical gradient)
  const e = h * 0.25;
  const project = () => {
    for (let v = 0; v < nV; v++) {
      let x = P[v*3], y = P[v*3+1], z = P[v*3+2];
      for (let it = 0; it < 4; it++) {
        const d = sdf(x, y, z); if (Math.abs(d) < h * 1e-3) break;
        const gx = (sdf(x + e, y, z) - sdf(x - e, y, z)) / (2 * e), gy = (sdf(x, y + e, z) - sdf(x, y - e, z)) / (2 * e), gz = (sdf(x, y, z + e) - sdf(x, y, z - e)) / (2 * e);
        const g2 = gx * gx + gy * gy + gz * gz; if (g2 < 1e-12) break;
        const s = Math.max(-h, Math.min(h, d / g2));
        x -= gx * s; y -= gy * s; z -= gz * s;
      }
      P[v*3] = x; P[v*3+1] = y; P[v*3+2] = z;
    }
  };
  project();
  // light relaxation for even triangles, then back onto the surface
  const ix = out.idx, nbS = new Uint32Array(nV + 1);
  for (let f = 0; f < ix.length; f++) nbS[ix[f] + 1] += 2;
  for (let v = 0; v < nV; v++) nbS[v + 1] += nbS[v];
  const nb = new Uint32Array(nbS[nV]), fill = nbS.slice(0, nV);
  for (let f = 0; f < ix.length; f += 3) for (let k = 0; k < 3; k++) { const a = ix[f+k]; nb[fill[a]++] = ix[f+(k+1)%3]; nb[fill[a]++] = ix[f+(k+2)%3]; }
  for (let pass = 0; pass < 2; pass++) {
    const T = new Float32Array(P.length);
    for (let v = 0; v < nV; v++) {
      const s0 = nbS[v], s1 = nbS[v + 1]; let x = 0, y = 0, z = 0;
      for (let j = s0; j < s1; j++) { const u = nb[j] * 3; x += P[u]; y += P[u+1]; z += P[u+2]; }
      const c = s1 - s0 || 1; T[v*3] = P[v*3] * 0.5 + x / c * 0.5; T[v*3+1] = P[v*3+1] * 0.5 + y / c * 0.5; T[v*3+2] = P[v*3+2] * 0.5 + z / c * 0.5;
    }
    P.set(T); project();
  }
  return { pos: P, idx: ix };
}
