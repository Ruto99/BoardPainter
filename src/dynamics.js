// Dynamics (ZBrush-like): position-based simulation of a triangle mesh - cloth draping over other parts, gravity
// sag, inflate / deflate. XPBD (Gauss-Seidel) with per-constraint compliance, Verlet integration, substeps.
//
//   createSim(pos, idx, opt) -> { pos, prev, step(n), reset(), frame, moved, setPin(arr), closed, nEdges, nBends }
//
// Constraints are built once: stretch along every (deduplicated) edge, bend as a distance between the two opposite
// vertices of each interior edge, a global volume constraint for pressure, and long-range tethers (each free vertex
// may not get farther from its nearest pinned vertex than its edge-graph distance) so hanging cloth does not stretch
// at high resolution where a few Gauss-Seidel sweeps cannot carry the load. Gravity is in mesh-size units per s^2
// (scaled by the bounding-box diagonal). Nothing is allocated inside step().

const comp = s => s >= 1 ? 0 : ((1 - s) / Math.max(s, 1e-3)) ** 2 * 0.05;   // slider 0..1 -> XPBD compliance / h^2

export function createSim(pos0, idx, opt = {}) {
  const nV = pos0.length / 3 | 0, nT = idx.length / 3 | 0;
  const P = new Float32Array(pos0), Q = new Float32Array(pos0), S = new Float32Array(pos0), F = new Float32Array(nV * 3);
  const W = new Float32Array(nV).fill(1);                      // inverse mass (0 = pinned)
  const pin = new Float32Array(nV);
  const grav = opt.gravity || [0, -1, 0], stiff = opt.stiffness ?? 0.9, bend = opt.bend ?? 0.1;
  const pressure = opt.pressure ?? 0, damping = opt.damping ?? 0.02, iters = Math.max(1, opt.iterations ?? 8);
  const dt = opt.dt ?? 1 / 60, subs = Math.max(1, opt.substeps ?? 2), collide = opt.collide || null, selfCol = !!opt.selfCollide;

  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < nV; i++) {
    const x = S[i*3], y = S[i*3+1], z = S[i*3+2]; cx += x; cy += y; cz += z;
    if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1; cx /= nV || 1; cy /= nV || 1; cz /= nV || 1;

  // ---- edges: half-edges bucketed by their lower vertex, deduplicated by a short scan (vertex degree is small)
  const cnt = new Int32Array(nV + 1);
  for (let t = 0; t < nT * 3; t += 3) for (let k = 0; k < 3; k++) { const a = idx[t+k], b = idx[t+(k+1)%3]; cnt[(a < b ? a : b) + 1]++; }
  for (let i = 0; i < nV; i++) cnt[i+1] += cnt[i];
  const cur = cnt.slice(0, nV), hb = new Uint32Array(nT * 3), ho = new Uint32Array(nT * 3), eid = new Int32Array(nT * 3);
  for (let t = 0; t < nT * 3; t += 3) for (let k = 0; k < 3; k++) {
    const a = idx[t+k], b = idx[t+(k+1)%3], c = idx[t+(k+2)%3], o = cur[a < b ? a : b]++;
    hb[o] = a < b ? b : a; ho[o] = c;
  }
  const ea = new Uint32Array(nT * 3 * 2), o1 = new Uint32Array(nT * 3), o2 = new Uint32Array(nT * 3), ec = new Uint8Array(nT * 3);
  let nE = 0;
  for (let v = 0; v < nV; v++) for (let i = cnt[v]; i < cnt[v+1]; i++) {
    let j = cnt[v]; while (j < i && hb[j] !== hb[i]) j++;
    if (j === i) { eid[i] = nE; ea[nE*2] = v; ea[nE*2+1] = hb[i]; o1[nE] = ho[i]; ec[nE] = 1; nE++; }
    else { const e = eid[i] = eid[j]; if (ec[e] === 1) o2[e] = ho[i]; if (ec[e] < 255) ec[e]++; }
  }
  const dist = (A, a, b) => Math.hypot(A[a*3] - A[b*3], A[a*3+1] - A[b*3+1], A[a*3+2] - A[b*3+2]);
  let border = 0, nB = 0, sumL = 0;
  for (let e = 0; e < nE; e++) { if (ec[e] === 1) border++; else if (ec[e] === 2 && o1[e] !== o2[e]) nB++; }
  const EA = ea.slice(0, nE * 2), ER = new Float32Array(nE), EL = new Float32Array(nE);
  for (let e = 0; e < nE; e++) { ER[e] = dist(S, EA[e*2], EA[e*2+1]); sumL += ER[e]; }
  const BA = new Uint32Array(nB * 2), BR = new Float32Array(nB), BL = new Float32Array(nB);
  for (let e = 0, b = 0; e < nE; e++) if (ec[e] === 2 && o1[e] !== o2[e]) { BA[b*2] = o1[e]; BA[b*2+1] = o2[e]; BR[b] = dist(S, o1[e], o2[e]); b++; }
  const avgL = nE ? sumL / nE : diag * 0.01, closed = border === 0 && nT > 0;

  // vertex adjacency (CSR) for the tether Dijkstra
  const ad = new Int32Array(nV + 1);
  for (let e = 0; e < nE; e++) { ad[EA[e*2]+1]++; ad[EA[e*2+1]+1]++; }
  for (let i = 0; i < nV; i++) ad[i+1] += ad[i];
  const an = new Uint32Array(nE * 2), ae = new Uint32Array(nE * 2), ac = ad.slice(0, nV);
  for (let e = 0; e < nE; e++) { const a = EA[e*2], b = EA[e*2+1]; an[ac[a]] = b; ae[ac[a]++] = e; an[ac[b]] = a; ae[ac[b]++] = e; }

  // ---- tethers to the nearest pinned vertex (multi-source Dijkstra over rest edge lengths)
  const TA = new Int32Array(nV).fill(-1), TD = new Float32Array(nV);
  function buildTethers() {
    TA.fill(-1); const D = TD.fill(Infinity), heap = [], hd = [];
    const push = (v, d) => { let i = heap.length; heap.push(v); hd.push(d); while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; heap[i] = heap[p]; hd[i] = hd[p]; i = p; } heap[i] = v; hd[i] = d; };
    const pop = () => {
      const v = heap[0], lv = heap.pop(), ld = hd.pop(), n = heap.length; if (!n) return v;
      let i = 0; for (;;) { let c = i * 2 + 1; if (c >= n) break; if (c + 1 < n && hd[c+1] < hd[c]) c++; if (hd[c] >= ld) break; heap[i] = heap[c]; hd[i] = hd[c]; i = c; }
      heap[i] = lv; hd[i] = ld; return v;
    };
    for (let i = 0; i < nV; i++) if (W[i] === 0) { D[i] = 0; TA[i] = i; push(i, 0); }
    while (heap.length) {
      const d0 = hd[0], v = pop(); if (d0 > D[v]) continue;
      for (let k = ad[v]; k < ad[v+1]; k++) { const u = an[k], d = d0 + ER[ae[k]]; if (d < D[u]) { D[u] = d; TA[u] = TA[v]; push(u, d); } }
    }
    for (let i = 0; i < nV; i++) if (TA[i] === i || !isFinite(D[i])) TA[i] = -1;
  }
  let hasTether = false;
  function setPin(arr) {
    pin.fill(0); if (arr) pin.set(arr.subarray ? arr.subarray(0, nV) : arr.slice(0, nV));
    let any = false;
    for (let i = 0; i < nV; i++) {
      const p = pin[i];
      if (p >= 0.5) { W[i] = 0; Q[i*3] = P[i*3]; Q[i*3+1] = P[i*3+1]; Q[i*3+2] = P[i*3+2]; any = true; }
      else W[i] = p > 0 ? Math.max(0.05, 1 - 2 * p) : 1;   // softly held vertices are heavier, and pulled home below
    }
    hasTether = any; if (any) buildTethers();
  }

  // ---- self collision: spatial hash with cell = radius
  const rad = avgL * 0.5, T = selfCol ? 1 << Math.ceil(Math.log2(Math.max(2, nV * 2))) : 0;
  const hc = selfCol ? new Int32Array(T + 1) : null, he = selfCol ? new Int32Array(nV) : null, hv = selfCol ? new Int32Array(nV) : null;
  const hash = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (T - 1);
  function selfCollide() {
    const inv = 1 / rad, r2 = rad * rad; hc.fill(0);
    for (let i = 0; i < nV; i++) { const h = hash(Math.floor(P[i*3] * inv), Math.floor(P[i*3+1] * inv), Math.floor(P[i*3+2] * inv)); hv[i] = h; hc[h]++; }
    for (let i = 1; i < T; i++) hc[i] += hc[i-1]; hc[T] = nV;   // hc[h] = end of bucket h
    for (let i = 0; i < nV; i++) he[--hc[hv[i]]] = i;            // now hc[h] = start, bucket h = [hc[h], hc[h+1])
    for (let i = 0; i < nV; i++) {
      const wi = W[i], ix = Math.floor(P[i*3] * inv), iy = Math.floor(P[i*3+1] * inv), iz = Math.floor(P[i*3+2] * inv);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const h = hash(ix + dx, iy + dy, iz + dz);
        for (let k = hc[h], ke = hc[h+1]; k < ke; k++) {
          const j = he[k]; if (j <= i) continue; const w = wi + W[j]; if (w === 0) continue;
          const x = P[i*3] - P[j*3], y = P[i*3+1] - P[j*3+1], z = P[i*3+2] - P[j*3+2], d2 = x*x + y*y + z*z;
          if (d2 >= r2 || d2 < 1e-24) continue;
          const sx = S[i*3] - S[j*3], sy = S[i*3+1] - S[j*3+1], sz = S[i*3+2] - S[j*3+2];
          if (sx*sx + sy*sy + sz*sz < r2) continue;          // already this close at rest (neighbours)
          const d = Math.sqrt(d2), s = (rad - d) / (d * w);
          P[i*3] += x * s * wi; P[i*3+1] += y * s * wi; P[i*3+2] += z * s * wi;
          P[j*3] -= x * s * W[j]; P[j*3+1] -= y * s * W[j]; P[j*3+2] -= z * s * W[j];
        }
      }
    }
  }

  // ---- XPBD distance constraints (Gauss-Seidel, in build order)
  function project(A, R, L, n, al) {
    for (let c = 0; c < n; c++) {
      const a = A[c*2], b = A[c*2+1], wa = W[a], wb = W[b], w = wa + wb; if (w === 0) continue;
      const a3 = a * 3, b3 = b * 3, x = P[a3] - P[b3], y = P[a3+1] - P[b3+1], z = P[a3+2] - P[b3+2];
      const d = Math.sqrt(x*x + y*y + z*z); if (d < 1e-20) continue;
      const dl = (R[c] - d - al * L[c]) / (w + al); L[c] += dl;
      const s = dl / d;
      P[a3] += x * s * wa; P[a3+1] += y * s * wa; P[a3+2] += z * s * wa;
      P[b3] -= x * s * wb; P[b3+1] -= y * s * wb; P[b3+2] -= z * s * wb;
    }
  }

  // ---- volume (relative to the rest centroid, so open meshes get a sensible value too)
  const G = pressure ? new Float32Array(nV * 3) : null;
  const volume = A => {
    let v = 0;
    for (let t = 0; t < nT * 3; t += 3) {
      const a = idx[t]*3, b = idx[t+1]*3, c = idx[t+2]*3;
      const ax = A[a]-cx, ay = A[a+1]-cy, az = A[a+2]-cz, bx = A[b]-cx, by = A[b+1]-cy, bz = A[b+2]-cz, qx = A[c]-cx, qy = A[c+1]-cy, qz = A[c+2]-cz;
      v += ax * (by*qz - bz*qy) + ay * (bz*qx - bx*qz) + az * (bx*qy - by*qx);
    }
    return v / 6;
  };
  const V0 = volume(S), Vt = V0 * (1 + pressure);
  function projectVolume() {
    G.fill(0); let v = 0;
    for (let t = 0; t < nT * 3; t += 3) {
      const a = idx[t]*3, b = idx[t+1]*3, c = idx[t+2]*3;
      const ax = P[a]-cx, ay = P[a+1]-cy, az = P[a+2]-cz, bx = P[b]-cx, by = P[b+1]-cy, bz = P[b+2]-cz, qx = P[c]-cx, qy = P[c+1]-cy, qz = P[c+2]-cz;
      const x0 = by*qz - bz*qy, y0 = bz*qx - bx*qz, z0 = bx*qy - by*qx;   // b x c  -> grad a
      v += ax * x0 + ay * y0 + az * z0;
      G[a] += x0; G[a+1] += y0; G[a+2] += z0;
      G[b] += qy*az - qz*ay; G[b+1] += qz*ax - qx*az; G[b+2] += qx*ay - qy*ax;   // c x a
      G[c] += ay*bz - az*by; G[c+1] += az*bx - ax*bz; G[c+2] += ax*by - ay*bx;   // a x b
    }
    let den = 0; for (let i = 0; i < nV; i++) den += W[i] * (G[i*3]*G[i*3] + G[i*3+1]*G[i*3+1] + G[i*3+2]*G[i*3+2]);
    if (den < 1e-30) return;
    const s = -(v - Vt * 6) / den;   // gradients and volume both carry the factor 6
    for (let i = 0; i < nV; i++) { const k = s * W[i]; P[i*3] += G[i*3] * k; P[i*3+1] += G[i*3+1] * k; P[i*3+2] += G[i*3+2] * k; }
  }

  function tethers() {
    for (let i = 0; i < nV; i++) {
      const a = TA[i]; if (a < 0 || W[i] === 0) continue;
      const x = P[i*3] - P[a*3], y = P[i*3+1] - P[a*3+1], z = P[i*3+2] - P[a*3+2], d2 = x*x + y*y + z*z, L = TD[i];
      if (d2 <= L * L) continue;
      const s = L / Math.sqrt(d2);
      P[i*3] = P[a*3] + x * s; P[i*3+1] = P[a*3+1] + y * s; P[i*3+2] = P[a*3+2] + z * s;
    }
  }

  const aS = comp(stiff), aB = comp(bend), useBend = bend > 0 && nB > 0, useVol = pressure !== 0 && Math.abs(V0) > 1e-30 * diag;
  const sim = { pos: P, prev: Q, closed, nEdges: nE, nBends: nB, moved: 0, setPin, reset, step, restVolume: V0, volume: () => volume(P) };
  let frame = 0;
  Object.defineProperty(sim, 'frame', { get: () => frame });

  function substep(h) {
    const damp = Math.pow(1 - Math.min(1, Math.max(0, damping)), 1 / subs);
    const gx = grav[0] * diag * h * h, gy = grav[1] * diag * h * h, gz = grav[2] * diag * h * h;
    for (let i = 0; i < nV; i++) {
      if (W[i] === 0) continue; const k = i * 3;
      for (let c = 0; c < 3; c++) { const p = P[k+c], v = (p - Q[k+c]) * damp; Q[k+c] = p; P[k+c] = p + v + (c === 0 ? gx : c === 1 ? gy : gz); }
    }
    EL.fill(0); if (useBend) BL.fill(0);
    for (let it = 0; it < iters; it++) {
      if (hasTether) tethers();
      project(EA, ER, EL, nE, aS);
      if (useBend) project(BA, BR, BL, nB, aB);
      if (useVol) projectVolume();
    }
    if (selfCol) selfCollide();
    if (collide) collide(P, Q, nV);
    for (let i = 0; i < nV; i++) {
      const p = pin[i]; if (p <= 0) continue; const k = i * 3;
      if (p >= 0.5) { P[k] = Q[k]; P[k+1] = Q[k+1]; P[k+2] = Q[k+2]; continue; }   // pinned: Q holds its position
      const s = 2 * p * p;   // soft hold toward the start position (0..0.5 per substep)
      P[k] += (S[k] - P[k]) * s; P[k+1] += (S[k+1] - P[k+1]) * s; P[k+2] += (S[k+2] - P[k+2]) * s;
    }
  }

  function step(n = 1) {
    const h = dt / subs;
    for (let f = 0; f < n; f++) {
      F.set(P);
      for (let s = 0; s < subs; s++) substep(h);
      let m = 0;
      for (let i = 0; i < nV * 3; i += 3) { const x = P[i] - F[i], y = P[i+1] - F[i+1], z = P[i+2] - F[i+2], d = x*x + y*y + z*z; if (d > m) m = d; }
      sim.moved = Math.sqrt(m); frame++;
    }
    return sim;
  }

  function reset() { P.set(S); Q.set(S); frame = 0; sim.moved = 0; setPin(pin.slice()); }

  setPin(opt.pin || null);
  return sim;
}
