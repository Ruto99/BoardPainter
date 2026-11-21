// NanoMesh / MicroPoly (ZBrush-like) on a polygon mesh { start: Uint32Array(nPoly+1), idx: Uint32Array } with
// faces wound counter-clockwise seen from outside (outward normal by Newell's method).
//
//   nanoMesh(P, polys, inst, opt)   one copy of a triangle mesh inst = { p, ix } on every (selected) polygon
//   microPoly(P, polys, tile, opt)  every quad replaced by a tile defined in unit space (x = u, z = v, y = height)
//   MICRO_TILES / microTile(id)     built-in tiles for microPoly
//
// Both return plain triangle soups { pos: Float32Array, idx: Uint32Array, ... } that the caller can add as a mesh.

const cross = (u, v) => [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
const dot = (u, v) => u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
const len = v => Math.hypot(v[0], v[1], v[2]);

// Newell normal, not normalised: its length is twice the polygon's area
function newell(P, idx, s, e) {
  let x = 0, y = 0, z = 0;
  for (let k = s; k < e; k++) {
    const a = idx[k] * 3, b = idx[k + 1 < e ? k + 1 : s] * 3;
    x += (P[a+1] - P[b+1]) * (P[a+2] + P[b+2]); y += (P[a+2] - P[b+2]) * (P[a] + P[b]); z += (P[a] - P[b]) * (P[a+1] + P[b+1]);
  }
  return [x, y, z];
}

function mulberry32(a) {
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---- NanoMesh ------------------------------------------------------------------------------------------------
// opt: fit 'face' | 'uniform', scale, height, offset, rotate (deg), randScale, randRot, seed, sel (Uint8Array), flip,
//      mix 'random' | 'group' (with several instances: inst may be an array), group (per-face id for 'group'),
//      over { [face]: { d: delete, s: scale factor, r: extra rotation (deg), o: extra lift } } per-instance edits
export function nanoMesh(P, polys, inst, opt = {}) {
  const { start, idx } = polys, nF = start.length - 1;
  const fit = opt.fit ?? 'face', scale = opt.scale ?? 1, height = opt.height ?? 1, offset = opt.offset ?? 0;
  const rot0 = (opt.rotate ?? 0) * Math.PI / 180, rS = opt.randScale ?? 0, rR = opt.randRot ?? 0, sel = opt.sel, flip = !!opt.flip;
  const rnd = mulberry32(opt.seed | 0), rndK = mulberry32((opt.seed | 0) + 7919), over = opt.over || null, grp = opt.group;
  // instance -> local frame: footprint (x, z) in [-0.5, 0.5] by the larger extent, y from 0, one scale factor
  const IN = (Array.isArray(inst) ? inst : [inst]).map(({ p: ip, ix }) => {
    const nIV = ip.length / 3, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nIV; i++) for (let k = 0; k < 3; k++) { const c = ip[i*3+k]; if (c < mn[k]) mn[k] = c; if (c > mx[k]) mx[k] = c; }
    const ext = Math.max(mx[0] - mn[0], mx[2] - mn[2]) || (mx[1] - mn[1]) || 1, s0 = 1 / ext;
    const cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2, L = new Float32Array(nIV * 3);
    for (let i = 0; i < nIV; i++) { L[i*3] = (ip[i*3] - cx) * s0; L[i*3+1] = (ip[i*3+1] - mn[1]) * s0; L[i*3+2] = (ip[i*3+2] - cz) * s0; }
    return { L, ix, nIV, nIT: ix.length / 3 };
  }), nIn = IN.length;

  // per face frame (computed first so the output can be sized); random numbers drawn for every face -> stable
  const fr = [];
  for (let f = 0; f < nF; f++) {
    const u1 = rnd(), u2 = rnd(), u3 = rndK(), s = start[f], e = start[f + 1];
    if (sel && !sel[f] || e - s < 3) continue;
    const ov = over && over[f];
    if (ov && ov.d) continue;
    const ki = nIn < 2 ? 0 : opt.mix === 'group' && grp ? ((grp[f] % nIn) + nIn) % nIn : Math.min(nIn - 1, Math.floor(u3 * nIn));
    const N = newell(P, idx, s, e), nl = len(N);
    if (nl < 1e-20) continue;
    const n = [N[0] / nl, N[1] / nl, N[2] / nl], sq = Math.sqrt(nl / 2);
    const a = idx[s] * 3, b = idx[s + 1] * 3, E = [P[b] - P[a], P[b+1] - P[a+1], P[b+2] - P[a+2]], d = dot(E, n);
    let t = [E[0] - n[0]*d, E[1] - n[1]*d, E[2] - n[2]*d]; const tl = len(t);
    if (tl < 1e-20) continue;
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    const bt = cross(n, t);
    let c = [0, 0, 0]; for (let k = s; k < e; k++) { const v = idx[k] * 3; c[0] += P[v]; c[1] += P[v+1]; c[2] += P[v+2]; }
    c = c.map(x => x / (e - s));
    let sx, sy, sz;
    const m = scale * (1 + rS * (2 * u1 - 1)) * (ov && ov.s > 0 ? ov.s : 1);
    if (fit === 'uniform') { sx = sz = sq * m; sy = sq * m * height; }
    else {   // stretch the footprint over the face's extent along t and b (centred on that extent)
      let t0 = Infinity, t1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let k = s; k < e; k++) {
        const v = idx[k] * 3, D = [P[v] - c[0], P[v+1] - c[1], P[v+2] - c[2]], pt = dot(D, t), pb = dot(D, bt);
        if (pt < t0) t0 = pt; if (pt > t1) t1 = pt; if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
      }
      const mt = (t0 + t1) / 2, mb = (b0 + b1) / 2;
      c = [c[0] + t[0]*mt + bt[0]*mb, c[1] + t[1]*mt + bt[1]*mb, c[2] + t[2]*mt + bt[2]*mb];
      sx = (t1 - t0) * m; sz = (b1 - b0) * m; sy = sq * m * height;
    }
    const up = flip ? [-n[0], -n[1], -n[2]] : n, B = cross(up, t);   // b = n x t (with the used normal)
    const off = (offset + (ov && ov.o || 0)) * sq;
    c = [c[0] + up[0]*off, c[1] + up[1]*off, c[2] + up[2]*off];
    const ang = rot0 + rR * 2 * Math.PI * u2 + (ov && ov.r || 0) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    // rotated tangent axes in the face plane
    const T = [t[0]*ca + B[0]*sa, t[1]*ca + B[1]*sa, t[2]*ca + B[2]*sa], Bb = [B[0]*ca - t[0]*sa, B[1]*ca - t[1]*sa, B[2]*ca - t[2]*sa];
    const X = T.map(x => x * sx), Y = up.map(x => x * sy), Z = Bb.map(x => x * sz);
    fr.push({ f, c, X, Y, Z, neg: dot(X, cross(Y, Z)) < 0, k: ki });
  }

  let TV = 0, TT = 0; for (const q of fr) { TV += IN[q.k].nIV; TT += IN[q.k].nIT; }
  const cnt = fr.length, pos = new Float32Array(TV * 3), out = new Uint32Array(TT * 3), face = new Uint32Array(TV);
  let vo = 0, to = 0;
  fr.forEach(({ f, c, X, Y, Z, neg, k: ki }) => {
    const { L, ix, nIV, nIT } = IN[ki];
    for (let i = 0; i < nIV; i++) {
      const x = L[i*3], y = L[i*3+1], z = L[i*3+2], o = (vo + i) * 3;
      pos[o] = c[0] + X[0]*x + Y[0]*y + Z[0]*z; pos[o+1] = c[1] + X[1]*x + Y[1]*y + Z[1]*z; pos[o+2] = c[2] + X[2]*x + Y[2]*y + Z[2]*z;
      face[vo + i] = f;
    }
    for (let k = 0; k < nIT; k++) {
      const a = ix[k*3] + vo, b = ix[k*3+1] + vo, d = ix[k*3+2] + vo;
      out[to + k*3] = a; out[to + k*3 + 1] = neg ? d : b; out[to + k*3 + 2] = neg ? b : d;
    }
    vo += nIV; to += nIT * 3;
  });
  return { pos, idx: out, face, count: cnt };
}

// ---- MicroPoly -----------------------------------------------------------------------------------------------
// opt: thickness (x the quad's average edge length), weld (default true), tris (triangles as quads c0 c1 c2 c2)
export function microPoly(P, polys, tile, opt = {}) {
  const { start, idx } = polys, nF = start.length - 1, nV = P.length / 3;
  const th = opt.thickness ?? 1, weld = opt.weld !== false, tris = !!opt.tris;
  // host vertex normals: sum of incident Newell normals (area weighted), normalised
  const VN = new Float64Array(nV * 3);
  for (let f = 0; f < nF; f++) {
    const s = start[f], e = start[f + 1]; if (e - s < 3) continue;
    const N = newell(P, idx, s, e);
    for (let k = s; k < e; k++) { const v = idx[k] * 3; VN[v] += N[0]; VN[v+1] += N[1]; VN[v+2] += N[2]; }
  }
  for (let v = 0; v < nV * 3; v += 3) { const l = Math.hypot(VN[v], VN[v+1], VN[v+2]) || 1; VN[v] /= l; VN[v+1] /= l; VN[v+2] /= l; }
  const dist = (a, b) => Math.hypot(P[a*3] - P[b*3], P[a*3+1] - P[b*3+1], P[a*3+2] - P[b*3+2]);
  const Q = [], QL = []; let Ls = 0;
  for (let f = 0; f < nF; f++) {
    const s = start[f], n = start[f + 1] - s;
    let c;
    if (n === 4) c = [idx[s], idx[s+1], idx[s+2], idx[s+3]];
    else if (n === 3 && tris) c = [idx[s], idx[s+1], idx[s+2], idx[s+2]];
    else continue;
    const m = n === 4 ? (dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3]) + dist(c[3], c[0])) / 4
                      : (dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[0])) / 3;
    Q.push(c); QL.push(m); Ls += m;
  }
  const nQ = Q.length, tp = tile.p, tix = tile.ix, nTV = tp.length / 3, nTT = tix.length / 3;
  let pos = new Float32Array(nQ * nTV * 3), out = new Uint32Array(nQ * nTT * 3);
  for (let q = 0; q < nQ; q++) {
    const c = Q[q], hs = th * QL[q], vo = q * nTV;
    for (let i = 0; i < nTV; i++) {
      const u = tp[i*3], h = tp[i*3+1], v = tp[i*3+2];
      const w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < 4; k++) {
        const a = c[k] * 3; px += w[k] * P[a]; py += w[k] * P[a+1]; pz += w[k] * P[a+2];
        nx += w[k] * VN[a]; ny += w[k] * VN[a+1]; nz += w[k] * VN[a+2];
      }
      const nl = Math.hypot(nx, ny, nz) || 1, k = h * hs / nl, o = (vo + i) * 3;
      pos[o] = px + nx * k; pos[o+1] = py + ny * k; pos[o+2] = pz + nz * k;
    }
    // (u, v) -> (c0->c1, c0->c3) with the normal up mirrors the tile's (x, z, y) frame: reverse the winding
    const to = q * nTT * 3;
    for (let t = 0; t < nTT; t++) { out[to + t*3] = tix[t*3] + vo; out[to + t*3 + 1] = tix[t*3+2] + vo; out[to + t*3 + 2] = tix[t*3+1] + vo; }
  }
  if (weld && nQ) {
    const tol = 1e-5 * (Ls / nQ) || 1e-9, tol2 = tol * tol, n = pos.length / 3;
    const remap = new Uint32Array(n), np = new Float32Array(n * 3), heads = new Map(), next = [];
    const key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2], gx = Math.floor(x / tol), gy = Math.floor(y / tol), gz = Math.floor(z / tol);
      let hit = -1;
      for (let dx = -1; dx <= 1 && hit < 0; dx++) for (let dy = -1; dy <= 1 && hit < 0; dy++) for (let dz = -1; dz <= 1 && hit < 0; dz++) {
        for (let j = heads.get(key(gx + dx, gy + dy, gz + dz)) ?? -1; j >= 0; j = next[j]) {
          const ex = np[j*3] - x, ey = np[j*3+1] - y, ez = np[j*3+2] - z;
          if (ex*ex + ey*ey + ez*ez <= tol2) { hit = j; break; }
        }
      }
      if (hit < 0) {
        hit = m++; np[hit*3] = x; np[hit*3+1] = y; np[hit*3+2] = z;
        const k = key(gx, gy, gz); next[hit] = heads.get(k) ?? -1; heads.set(k, hit);
      }
      remap[i] = hit;
    }
    const kept = [];
    for (let t = 0; t < out.length; t += 3) {   // drop triangles the weld collapsed
      const a = remap[out[t]], b = remap[out[t+1]], c = remap[out[t+2]];
      if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    pos = np.slice(0, m * 3); out = new Uint32Array(kept);
  }
  return { pos, idx: out, count: nQ };
}

// ---- tiles -----------------------------------------------------------------------------------------------------
// Unit space: x = u, z = v in [0, 1], y = height; closed (or open only where the neighbouring tile continues
// the shape, so welded tiles join into closed solids), wound counter-clockwise seen from outside.
export const MICRO_TILES = [
  { id: 'grid', name: '格子' }, { id: 'weave', name: '織り目' }, { id: 'chain', name: '鎖かたびら' },
  { id: 'studs', name: '鋲' }, { id: 'scales', name: 'ウロコ' }, { id: 'bricks', name: 'レンガ' },
];

function builder() {
  const P = [], I = [], map = new Map();
  const V = p => {
    const k = Math.round(p[0] * 1e5) + ',' + Math.round(p[1] * 1e5) + ',' + Math.round(p[2] * 1e5);
    let i = map.get(k); if (i === undefined) { i = P.length / 3; P.push(p[0], p[1], p[2]); map.set(k, i); } return i;
  };
  const tri = (a, b, c) => { a = V(a); b = V(b); c = V(c); if (a !== b && b !== c && a !== c) I.push(a, b, c); };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  // quad turned so its normal agrees with hint
  const quadH = (a, b, c, d, hint) => {
    const n = cross([c[0] - a[0], c[1] - a[1], c[2] - a[2]], [d[0] - b[0], d[1] - b[1], d[2] - b[2]]);
    dot(n, hint) >= 0 ? quad(a, b, c, d) : quad(d, c, b, a);
  };
  // two rings (same count, angle increasing from +x towards +z): following a revolved profile from the bottom
  // centre outwards, up and in to the top centre, every band faces outwards; a ring may be one repeated point
  const band = (A, B) => { const n = A.length; for (let i = 0; i < n; i++) { const j = (i + 1) % n; quad(A[i], B[i], B[j], A[j]); } };
  // box; skip lists faces left open: 'x-', 'x+', 'y-', 'y+', 'z-', 'z+'
  const box = (x0, x1, y0, y1, z0, z1, skip = '') => {
    const c = i => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    const F = { 'x-': [0, 4, 6, 2], 'x+': [1, 3, 7, 5], 'y-': [0, 1, 5, 4], 'y+': [2, 6, 7, 3], 'z-': [0, 2, 3, 1], 'z+': [4, 5, 7, 6] };
    for (const k in F) if (!skip.includes(k)) quad(...F[k].map(c));
  };
  return { tri, quad, quadH, band, box, done: () => ({ p: new Float32Array(P), ix: new Uint32Array(I) }) };
}

const ring = (n, f) => { const r = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; r.push(f(Math.cos(a), Math.sin(a))); } return r; };

export function microTile(id) {
  const T = builder();
  if (id === 'grid') {
    // beams 0.12 wide centred on the cell borders: each tile holds half of each (a square annulus between the
    // border and [0.06, 0.94]), open at the border so neighbours weld into one closed beam; height 0.12
    const g = [0, 0.06, 0.94, 1], H = 0.12;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      const x0 = g[i], x1 = g[i + 1], z0 = g[j], z1 = g[j + 1];
      T.quadH([x0, H, z0], [x1, H, z0], [x1, H, z1], [x0, H, z1], [0, 1, 0]);
      T.quadH([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], [0, -1, 0]);
    }
    const a = 0.06, b = 0.94, sq = [[a, a], [b, a], [b, b], [a, b]];
    for (let k = 0; k < 4; k++) {
      const p = sq[k], q = sq[(k + 1) % 4], hint = [0.5 - (p[0] + q[0]) / 2, 0, 0.5 - (p[1] + q[1]) / 2];
      T.quadH([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], H, q[1]], [p[0], H, p[1]], hint);
    }
  } else if (id === 'weave') {
    // 2 x 2 crossings: strips along u at v = 0.25 / 0.75 and along v at u = 0.25 / 0.75, their heights a cosine
    // so over / under alternates like plain weave; strip ends are open at the border (they continue in the next tile)
    const seg = 16, hw = 0.16, ht = 0.015;
    const strip = (alongU, w, sign) => {
      const pt = (s, ww, y) => alongU ? [s, y, ww] : [ww, y, s], side = alongU ? [0, 0, 1] : [1, 0, 0];
      for (let i = 0; i < seg; i++) {
        const s0 = i / seg, s1 = (i + 1) / seg, c = s => 0.055 + sign * 0.035 * Math.cos(2 * Math.PI * (s - 0.25));
        const a0 = c(s0), a1 = c(s1), w0 = w - hw, w1 = w + hw;
        T.quadH(pt(s0, w0, a0 + ht), pt(s1, w0, a1 + ht), pt(s1, w1, a1 + ht), pt(s0, w1, a0 + ht), [0, 1, 0]);
        T.quadH(pt(s0, w0, a0 - ht), pt(s1, w0, a1 - ht), pt(s1, w1, a1 - ht), pt(s0, w1, a0 - ht), [0, -1, 0]);
        T.quadH(pt(s0, w0, a0 - ht), pt(s1, w0, a1 - ht), pt(s1, w0, a1 + ht), pt(s0, w0, a0 + ht), side.map(x => -x));
        T.quadH(pt(s0, w1, a0 - ht), pt(s1, w1, a1 - ht), pt(s1, w1, a1 + ht), pt(s0, w1, a0 + ht), side);
      }
    };
    strip(true, 0.25, -1); strip(true, 0.75, 1); strip(false, 0.25, 1); strip(false, 0.75, -1);
  } else if (id === 'chain') {
    // one torus ring (R 0.42, r 0.07), centred in the cell and tilted 10 degrees about x
    const R = 0.42, r = 0.07, na = 24, nb = 8, tl = 10 * Math.PI / 180, ct = Math.cos(tl), st = Math.sin(tl), cy = 0.16;
    const p = (i, j) => {
      const a = i / na * Math.PI * 2, b = j / nb * Math.PI * 2, rr = R + r * Math.cos(b);
      const x = rr * Math.cos(a), y = r * Math.sin(b), z = rr * Math.sin(a);
      return [0.5 + x, cy + y * ct - z * st, 0.5 + y * st + z * ct];
    };
    for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) T.quad(p(i, j), p(i, j + 1), p(i + 1, j + 1), p(i + 1, j));
  } else if (id === 'studs') {
    // base plate 0.05 thick (open at the border, its 16 border points are symmetric so any rotation welds),
    // a cylinder stud r 0.22 up to 0.14 and a dome up to 0.24
    const n = 16, pb = 0.05, rs = 0.22, yc = 0.14, dh = 0.1;
    const sqr = y => ring(n, (c, s) => { const m = Math.max(Math.abs(c), Math.abs(s)); return [0.5 + 0.5 * c / m, y, 0.5 + 0.5 * s / m]; });
    const circ = (r, y) => ring(n, (c, s) => [0.5 + r * c, y, 0.5 + r * s]);
    const rings = [ring(n, () => [0.5, 0, 0.5]), sqr(0)];
    T.band(rings[0], rings[1]);
    let prev = sqr(pb);   // (no band between sqr(0) and sqr(pb): open side)
    const prof = [circ(rs, pb), circ(rs, yc)];
    for (let k = 1; k < 5; k++) { const f = k / 5 * Math.PI / 2; prof.push(circ(rs * Math.cos(f), yc + dh * Math.sin(f))); }
    prof.push(ring(n, () => [0.5, yc + dh, 0.5]));
    for (const r of prof) { T.band(prev, r); prev = r; }
  } else if (id === 'scales') {
    // a rounded, domed scale (outline an ellipse reaching v -0.25..1.35) tilted up towards +v so its tip lies over
    // the root of the next tile's scale; closed shell (overlapping, does not weld)
    const n = 24, cu = 0.5, cv = 0.55, ru = 0.52, rv = 0.8, edge = 0.008, dome = 0.06;
    const base = v => 0.17 * Math.min(1, Math.max(0, (v + 0.25) / 1.6));
    const er = (rho, top) => ring(n, (c, s) => {
      const u = cu + ru * rho * c, v = cv + rv * rho * s;
      return [u, base(v) + (top ? edge + dome * Math.sqrt(Math.max(0, 1 - rho * rho)) : 0), v];
    });
    const rh = [0, 0.2, 0.4, 0.6, 0.8, 1], prof = [];
    for (const r of rh) prof.push(er(r, false));
    for (let k = rh.length - 1; k >= 0; k--) prof.push(er(rh[k], true));
    for (let k = 1; k < prof.length; k++) T.band(prof[k - 1], prof[k]);
  } else if (id === 'bricks') {
    // mortar plate (0.04, open at the border) and running-bond bricks with 0.04 joints: one whole brick in the
    // lower row, two halves in the upper row whose ends at u = 0 / 1 are open so they join the neighbours' halves
    const y0 = 0.03, y1 = 0.13;
    T.box(0, 1, 0, 0.04, 0, 1, 'x-x+z-z+');
    T.box(0.02, 0.98, y0, y1, 0.02, 0.48);
    T.box(0, 0.48, y0, y1, 0.52, 0.98, 'x-');
    T.box(0.52, 1, y0, y1, 0.52, 0.98, 'x+');
  } else return null;
  return T.done();
}
