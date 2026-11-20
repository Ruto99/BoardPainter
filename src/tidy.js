// Tidy the badly shaped triangles a mesh boolean leaves along its cut (long slivers, tiny fans), so the result can be
// sculpted right away. Only the bad triangles and a few rings around them are rebuilt; the rest of the mesh (and
// its sculpted detail) is kept exactly. Inside that region an isotropic remesh (Botsch & Kobbelt 2004) brings edges
// to the length of the surrounding mesh: split long edges, collapse short ones, flip edges toward valence 6, relax
// along the surface and project back onto the original surface. Sharp edges (dihedral > `sharp` degrees) are kept:
// they are split and collapsed only along themselves, never flipped, and their vertices slide along them only.
// The region's border is locked, so it still meets the untouched part exactly.
//
// tidyMesh(pos, idx, { mask, paint, sharp, rings }) -> { pos, idx, mask, paint, region (faces rebuilt), L } | null
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const K = 67108864;   // edge key base (vertex ids < 2^26)
const ekey = (a, b) => a < b ? a * K + b : b * K + a;

export function tidyMesh(P0, I0, opt = {}) {
  const nV0 = P0.length / 3, nF0 = I0.length / 3;
  const len = (a, b) => Math.hypot(P0[a*3] - P0[b*3], P0[a*3+1] - P0[b*3+1], P0[a*3+2] - P0[b*3+2]);
  // face quality: smallest angle; target length = median edge of the well-shaped faces
  const minAng = new Float32Array(nF0), good = [];
  for (let f = 0; f < nF0; f++) {
    const a = I0[f*3], b = I0[f*3+1], c = I0[f*3+2], A = len(b, c), B = len(a, c), C = len(a, b);
    const ang = (x, y, z) => Math.acos(Math.max(-1, Math.min(1, (y*y + z*z - x*x) / (2 * y * z || 1e-30))));
    minAng[f] = Math.min(ang(A, B, C), ang(B, A, C), ang(C, A, B)) * 180 / Math.PI;
    if (minAng[f] >= 30 && good.length < 200000) good.push((A + B + C) / 3);
  }
  let L = opt.length;
  if (!L) {
    if (good.length) { good.sort((x, y) => x - y); L = good[good.length >> 1]; }
    else { let s = 0; for (let f = 0; f < nF0; f++) s += len(I0[f*3], I0[f*3+1]); L = s / nF0; }
  }
  if (!(L > 0)) return null;
  const bad = new Uint8Array(nF0);
  let nBad = 0;
  for (let f = 0; f < nF0; f++) {
    const a = I0[f*3], b = I0[f*3+1], c = I0[f*3+2], mx = Math.max(len(a, b), len(b, c), len(c, a));
    if (minAng[f] < (opt.minAngle ?? 20) || mx > L * 2.2) { bad[f] = 1; nBad++; }
  }
  if (!nBad) return null;
  // region = bad faces + `rings` rings of neighbours
  const vfS = new Uint32Array(nV0 + 1); for (let i = 0; i < I0.length; i++) vfS[I0[i] + 1]++;
  for (let v = 0; v < nV0; v++) vfS[v + 1] += vfS[v];
  const vfL = new Uint32Array(I0.length), fill = vfS.slice(0, nV0);
  for (let i = 0; i < I0.length; i++) vfL[fill[I0[i]]++] = (i / 3) | 0;
  const inR = bad.slice();
  for (let r = 0; r < (opt.rings ?? 2); r++) {
    const add = [];
    for (let f = 0; f < nF0; f++) if (inR[f]) for (let k = 0; k < 3; k++) { const v = I0[f*3+k]; for (let j = vfS[v]; j < vfS[v + 1]; j++) if (!inR[vfL[j]]) add.push(vfL[j]); }
    for (const f of add) inR[f] = 1;
  }
  // ---- working copy of the region
  const X = Array.from(P0), M = opt.mask ? Array.from(opt.mask) : null, C = opt.paint ? Array.from(opt.paint) : null;
  const F = [], vf = new Map(), locked = new Set();
  const addVF = (v, f) => { let s = vf.get(v); if (!s) vf.set(v, s = new Set()); s.add(f); };
  for (let f = 0; f < nF0; f++) if (inR[f]) { const t = [I0[f*3], I0[f*3+1], I0[f*3+2]]; F.push(t); for (const v of t) addVF(v, F.length - 1); }
  for (const v of vf.keys()) for (let j = vfS[v]; j < vfS[v + 1]; j++) if (!inR[vfL[j]]) { locked.add(v); break; }
  // neighbours a locked vertex has only through untouched faces (for its true valence)
  const extra = new Map();
  for (const v of locked) {
    const all = new Set(), reg = new Set();
    for (let j = vfS[v]; j < vfS[v + 1]; j++) { const f = vfL[j]; for (let k = 0; k < 3; k++) { const u = I0[f*3+k]; if (u === v) continue; all.add(u); if (inR[f]) reg.add(u); } }
    let n = 0; for (const u of all) if (!reg.has(u)) n++; extra.set(v, n);
  }
  // original surface (for projection) and sharp edges
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P0), 3)); g.setIndex(new THREE.BufferAttribute(new Uint32Array(I0), 1));
  const bvh = new MeshBVH(g), q = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const fN = f => { const [a, b, c] = F[f], ux = X[b*3]-X[a*3], uy = X[b*3+1]-X[a*3+1], uz = X[b*3+2]-X[a*3+2], wx = X[c*3]-X[a*3], wy = X[c*3+1]-X[a*3+1], wz = X[c*3+2]-X[a*3+2]; return [uy*wz - uz*wy, uz*wx - ux*wz, ux*wy - uy*wx]; };
  const unit = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
  const cosS = Math.cos((opt.sharp ?? 35) * Math.PI / 180), feat = new Set(), segs = [];
  {
    const seen = new Map();
    F.forEach((t, f) => { for (let k = 0; k < 3; k++) { const key = ekey(t[k], t[(k + 1) % 3]), o = seen.get(key); if (o === undefined) seen.set(key, f); else { const n1 = unit(fN(f)), n2 = unit(fN(o)); if (n1[0]*n2[0] + n1[1]*n2[1] + n1[2]*n2[2] < cosS) { feat.add(key); segs.push(t[k], t[(k + 1) % 3]); } } } });
  }
  const segP = Float64Array.from(segs.flatMap(v => [X[v*3], X[v*3+1], X[v*3+2]]));
  const featCount = v => { let n = 0; for (const u of nbrs(v)) if (feat.has(ekey(v, u))) n++; return n; };
  function nbrs(v) { const s = new Set(); for (const f of vf.get(v) || []) for (const u of F[f]) if (u !== v) s.add(u); return s; }
  const edgeFaces = (a, b) => { const out = []; for (const f of vf.get(a) || []) if (F[f] && F[f].includes(b)) out.push(f); return out; };
  const newV = (x, y, z, from) => { const v = X.length / 3; X.push(x, y, z); if (M) M.push(M[from[0]] * 0.5 + M[from[1]] * 0.5); if (C) for (let k = 0; k < 3; k++) C.push((C[from[0]*3+k] + C[from[1]*3+k]) / 2); return v; };
  const dist = (a, b) => Math.hypot(X[a*3] - X[b*3], X[a*3+1] - X[b*3+1], X[a*3+2] - X[b*3+2]);
  const hi = L * 4 / 3, lo = L * 4 / 5;
  const edges = () => { const s = new Map(); F.forEach(t => { if (t) for (let k = 0; k < 3; k++) s.set(ekey(t[k], t[(k + 1) % 3]), [t[k], t[(k + 1) % 3]]); }); return [...s.values()]; };

  function split(a, b) {
    const fs = edgeFaces(a, b); if (fs.length !== 2) return false;
    const m = newV((X[a*3] + X[b*3]) / 2, (X[a*3+1] + X[b*3+1]) / 2, (X[a*3+2] + X[b*3+2]) / 2, [a, b]);
    for (const f of fs) {
      const t = F[f], i = t.indexOf(a), j = t.indexOf(b), c = t[3 - i - j];
      const x = t[(i + 1) % 3] === b ? a : b, y = x === a ? b : a;   // the face runs x -> y -> c
      F[f] = [x, m, c]; const nf = F.length; F.push([m, y, c]);
      vf.get(y).delete(f); addVF(y, nf); addVF(c, nf); addVF(m, f); addVF(m, nf);
    }
    const k = ekey(a, b); if (feat.has(k)) { feat.delete(k); feat.add(ekey(a, m)); feat.add(ekey(m, b)); }
    return true;
  }
  function collapse(a, b) {   // remove a, keep b
    if (locked.has(a)) return false;
    const fs = edgeFaces(a, b); if (fs.length !== 2) return false;
    const fa = featCount(a), isF = feat.has(ekey(a, b));
    if (fa && !(fa === 2 && isF)) return false;   // a on a sharp edge goes only along it; corners stay
    // link condition: a and b share exactly the two opposite vertices
    const na = nbrs(a), nb = nbrs(b); let common = 0; for (const u of na) if (nb.has(u)) common++;
    if (common !== 2) return false;
    let px = X[b*3], py = X[b*3+1], pz = X[b*3+2];
    if (!locked.has(b) && !featCount(b) && !fa) { px = (X[a*3] + px) / 2; py = (X[a*3+1] + py) / 2; pz = (X[a*3+2] + pz) / 2; }
    for (const u of na) if (u !== b && Math.hypot(X[u*3] - px, X[u*3+1] - py, X[u*3+2] - pz) > hi) return false;
    // no face may flip
    const old = [X[a*3], X[a*3+1], X[a*3+2]], oldB = [X[b*3], X[b*3+1], X[b*3+2]];
    const ok = (() => {
      const before = new Map(); for (const f of vf.get(a)) if (!fs.includes(f)) before.set(f, unit(fN(f)));
      for (const f of vf.get(b)) if (!fs.includes(f)) before.set(f, unit(fN(f)));
      X[a*3] = px; X[a*3+1] = py; X[a*3+2] = pz; X[b*3] = px; X[b*3+1] = py; X[b*3+2] = pz;
      for (const [f, n0] of before) { const n = fN(f), l = Math.hypot(...n); if (l < 1e-20 || (n[0]*n0[0] + n[1]*n0[1] + n[2]*n0[2]) / l < 0.3) return false; }
      return true;
    })();
    if (!ok) { X[a*3] = old[0]; X[a*3+1] = old[1]; X[a*3+2] = old[2]; X[b*3] = oldB[0]; X[b*3+1] = oldB[1]; X[b*3+2] = oldB[2]; return false; }
    X[a*3] = old[0]; X[a*3+1] = old[1]; X[a*3+2] = old[2];   // a is gone; keep its slot harmless
    if (M) M[b] = (M[a] + M[b]) / 2;
    for (const f of fs) { for (const v of F[f]) vf.get(v).delete(f); F[f] = null; }
    for (const f of [...vf.get(a)]) { const t = F[f]; t[t.indexOf(a)] = b; addVF(b, f); }
    vf.delete(a);
    for (const u of na) { const k = ekey(a, u); if (feat.has(k)) { feat.delete(k); if (u !== b) feat.add(ekey(b, u)); } }
    return true;
  }
  const val = v => nbrs(v).size + (extra.get(v) || 0);
  function flip(a, b) {
    if (feat.has(ekey(a, b))) return false;
    const fs = edgeFaces(a, b); if (fs.length !== 2) return false;
    let f1 = fs[0], f2 = fs[1]; const t1 = F[f1];
    if (t1[(t1.indexOf(a) + 1) % 3] !== b) { const t = f1; f1 = f2; f2 = t; }   // f1 runs a -> b
    const c = F[f1].find(v => v !== a && v !== b), d = F[f2].find(v => v !== a && v !== b);
    if (c === d || nbrs(c).has(d)) return false;
    const dev = (v, t) => Math.abs(val(v) - t);
    const before = dev(a, 6) + dev(b, 6) + dev(c, 6) + dev(d, 6);
    const after = Math.abs(val(a) - 1 - 6) + Math.abs(val(b) - 1 - 6) + Math.abs(val(c) + 1 - 6) + Math.abs(val(d) + 1 - 6);
    if (after >= before) return false;
    const n0 = unit([fN(f1), fN(f2)].reduce((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]], [0, 0, 0]));
    const o1 = F[f1], o2 = F[f2];
    F[f1] = [c, a, d]; F[f2] = [d, b, c];
    for (const f of [f1, f2]) { const n = unit(fN(f)); if (n[0]*n0[0] + n[1]*n0[1] + n[2]*n0[2] < 0.5) { F[f1] = o1; F[f2] = o2; return false; } }
    vf.get(a).delete(f2); vf.get(b).delete(f1); addVF(c, f2); addVF(d, f1);
    return true;
  }
  // Delaunay flip: the two angles opposite the edge add up to more than 180 degrees
  function dflip(a, b) {
    if (feat.has(ekey(a, b))) return false;
    const fs = edgeFaces(a, b); if (fs.length !== 2) return false;
    let f1 = fs[0], f2 = fs[1]; const t1 = F[f1];
    if (t1[(t1.indexOf(a) + 1) % 3] !== b) { const t = f1; f1 = f2; f2 = t; }
    const c = F[f1].find(v => v !== a && v !== b), d = F[f2].find(v => v !== a && v !== b);
    if (c === d || nbrs(c).has(d)) return false;
    const angAt = (o, u, w) => { const ux = X[u*3]-X[o*3], uy = X[u*3+1]-X[o*3+1], uz = X[u*3+2]-X[o*3+2], wx = X[w*3]-X[o*3], wy = X[w*3+1]-X[o*3+1], wz = X[w*3+2]-X[o*3+2];
      return Math.acos(Math.max(-1, Math.min(1, (ux*wx + uy*wy + uz*wz) / (Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz) || 1e-30)))); };
    if (angAt(c, a, b) + angAt(d, a, b) <= Math.PI + 1e-6) return false;
    const n0 = unit([fN(f1), fN(f2)].reduce((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]], [0, 0, 0]));
    const o1 = F[f1], o2 = F[f2];
    F[f1] = [c, a, d]; F[f2] = [d, b, c];
    for (const f of [f1, f2]) { const n = unit(fN(f)); if (n[0]*n0[0] + n[1]*n0[1] + n[2]*n0[2] < 0.7) { F[f1] = o1; F[f2] = o2; return false; } }
    vf.get(a).delete(f2); vf.get(b).delete(f1); addVF(c, f2); addVF(d, f1);
    return true;
  }
  const delaunay = () => { for (let r = 0; r < 4; r++) { let n = 0; for (const [a, b] of edges()) if (vf.has(a) && vf.has(b) && dflip(a, b)) n++; if (!n) break; } };
  const projSurface = v => { q.set(X[v*3], X[v*3+1], X[v*3+2]); if (bvh.closestPointToPoint(q, hit)) { X[v*3] = hit.point.x; X[v*3+1] = hit.point.y; X[v*3+2] = hit.point.z; } };
  // sharp-edge segments in a grid of cells about 2L wide (a vertex moves less than that per relax step)
  const cell = L * 2, sg = new Map(), ck = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < segP.length; i += 6) {
    const n = Math.max(1, Math.ceil(Math.hypot(segP[i+3] - segP[i], segP[i+4] - segP[i+1], segP[i+5] - segP[i+2]) / cell)), seen = new Set();
    for (let j = 0; j <= n; j++) { const t = j / n, k = ck(segP[i] + (segP[i+3] - segP[i]) * t, segP[i+1] + (segP[i+4] - segP[i+1]) * t, segP[i+2] + (segP[i+5] - segP[i+2]) * t); if (seen.has(k)) continue; seen.add(k); (sg.get(k) || sg.set(k, []).get(k)).push(i); }
  }
  const projFeature = v => {
    let best = Infinity, bx = 0, by = 0, bz = 0; const x = X[v*3], y = X[v*3+1], z = X[v*3+2];
    const cx0 = Math.floor(x / cell), cy0 = Math.floor(y / cell), cz0 = Math.floor(z / cell), done = new Set();
    for (let dx0 = -1; dx0 <= 1; dx0++) for (let dy0 = -1; dy0 <= 1; dy0++) for (let dz0 = -1; dz0 <= 1; dz0++) for (const i of sg.get(`${cx0+dx0},${cy0+dy0},${cz0+dz0}`) || []) {
      if (done.has(i)) continue; done.add(i);
      const dx = segP[i+3] - segP[i], dy = segP[i+4] - segP[i+1], dz = segP[i+5] - segP[i+2], l2 = dx*dx + dy*dy + dz*dz || 1e-30;
      const t = Math.max(0, Math.min(1, ((x - segP[i]) * dx + (y - segP[i+1]) * dy + (z - segP[i+2]) * dz) / l2));
      const cx = segP[i] + dx * t, cy = segP[i+1] + dy * t, cz = segP[i+2] + dz * t, d = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
      if (d < best) { best = d; bx = cx; by = cy; bz = cz; }
    }
    if (best < Infinity) { X[v*3] = bx; X[v*3+1] = by; X[v*3+2] = bz; }
  };
  function relax() {
    const moves = [];
    for (const v of vf.keys()) {
      if (locked.has(v)) continue;
      const fc = featCount(v); if (fc && fc !== 2) continue;
      let cx = 0, cy = 0, cz = 0, n = 0;
      for (const u of nbrs(v)) { if (fc && !feat.has(ekey(v, u))) continue; cx += X[u*3]; cy += X[u*3+1]; cz += X[u*3+2]; n++; }
      if (!n) continue;
      cx /= n; cy /= n; cz /= n;
      if (!fc) {   // tangential only
        let nx = 0, ny = 0, nz = 0; for (const f of vf.get(v)) { const m = fN(f); nx += m[0]; ny += m[1]; nz += m[2]; }
        const nn = unit([nx, ny, nz]), d = (cx - X[v*3]) * nn[0] + (cy - X[v*3+1]) * nn[1] + (cz - X[v*3+2]) * nn[2];
        cx -= nn[0] * d; cy -= nn[1] * d; cz -= nn[2] * d;
      }
      moves.push(v, cx, cy, cz, fc);
    }
    for (let i = 0; i < moves.length; i += 5) { const v = moves[i]; X[v*3] = moves[i+1]; X[v*3+1] = moves[i+2]; X[v*3+2] = moves[i+3]; if (moves[i+4]) projFeature(v); else projSurface(v); }
  }
  for (let it = 0; it < (opt.iters ?? 6); it++) {
    for (const [a, b] of edges()) if (F.length < 8 * nF0 && dist(a, b) > hi && !(locked.has(a) && locked.has(b) && edgeFaces(a, b).length < 2)) split(a, b);
    for (const [a, b] of edges()) { if (!vf.has(a) || !vf.has(b) || dist(a, b) >= lo) continue; if (!collapse(a, b)) collapse(b, a); }
    for (const [a, b] of edges()) if (vf.has(a) && vf.has(b)) flip(a, b);
    relax(); delaunay();
  }
  for (let r = 0; r < 3; r++) { relax(); delaunay(); }
  // ---- assemble: untouched faces + rebuilt region, unused vertices dropped
  const out = [];
  for (let f = 0; f < nF0; f++) if (!inR[f]) out.push(I0[f*3], I0[f*3+1], I0[f*3+2]);
  let region = 0; for (const t of F) if (t) { out.push(t[0], t[1], t[2]); region++; }
  const n = X.length / 3, map = new Int32Array(n).fill(-1); let k = 0;
  for (const v of out) if (map[v] < 0) map[v] = k++;
  const pos = new Float32Array(k * 3), mask = M ? new Float32Array(k) : null, paint = C ? new Float32Array(k * 3) : null;
  for (let v = 0; v < n; v++) { const m = map[v]; if (m < 0) continue; pos[m*3] = X[v*3]; pos[m*3+1] = X[v*3+1]; pos[m*3+2] = X[v*3+2]; if (mask) mask[m] = M[v]; if (paint) for (let c = 0; c < 3; c++) paint[m*3+c] = C[v*3+c]; }
  return { pos, idx: Uint32Array.from(out, v => map[v]), mask, paint, region, L, bad: nBad };
}

// smallest-angle statistics (tests and the message after tidying)
export function angleStats(P, I) {
  let worst = 180, below = 0; const n = I.length / 3;
  for (let f = 0; f < n; f++) {
    const a = I[f*3]*3, b = I[f*3+1]*3, c = I[f*3+2]*3;
    const l = (u, v) => Math.hypot(P[u] - P[v], P[u+1] - P[v+1], P[u+2] - P[v+2]), A = l(b, c), B = l(a, c), Cc = l(a, b);
    const ang = (x, y, z) => Math.acos(Math.max(-1, Math.min(1, (y*y + z*z - x*x) / (2 * y * z || 1e-30)))) * 180 / Math.PI;
    const m = Math.min(ang(A, B, Cc), ang(B, A, Cc), ang(Cc, A, B)); worst = Math.min(worst, m); if (m < 20) below++;
  }
  return { worst, below, faces: n };
}
