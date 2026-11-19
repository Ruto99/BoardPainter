// Hard-surface helpers on triangle meshes.
//
//   slicePlane  cut every triangle the plane crosses, so an exact edge loop runs along the cut; reports which side
//               each vertex is on (cut vertices are on the plane)
//   panelLoops  every polygroup becomes a separate closed panel: the surface, a copy pushed inward by `thickness`
//               and a wall along its border; the border is pulled back by `gap` so neighbouring panels part

// plane: n (unit) and c, signed distance d = n . p + c. Returns { pos, idx, src: [a, b, t] per vertex
// (t = 0 for the old vertices: a = b), side: Int8Array (+1, -1, 0 on the plane) }.
export function slicePlane(P, ix, n, c, eps = 1e-7) {
  const nV = P.length / 3, d = new Float64Array(nV);
  let scale = 0; for (let i = 0; i < P.length; i++) scale = Math.max(scale, Math.abs(P[i]));
  const tol = eps * Math.max(1, scale);
  for (let v = 0; v < nV; v++) { const x = n[0] * P[v*3] + n[1] * P[v*3+1] + n[2] * P[v*3+2] + c; d[v] = Math.abs(x) < tol ? 0 : x; }
  const extra = [], src = [], cut = new Map();
  const mid = (a, b) => {
    const k = a < b ? a * nV + b : b * nV + a; let m = cut.get(k); if (m !== undefined) return m;
    const t = d[a] / (d[a] - d[b]);
    m = nV + extra.length / 3; cut.set(k, m);
    extra.push(P[a*3] + (P[b*3] - P[a*3]) * t, P[a*3+1] + (P[b*3+1] - P[a*3+1]) * t, P[a*3+2] + (P[b*3+2] - P[a*3+2]) * t);
    src.push(a, b, t);
    return m;
  };
  const out = [];
  const fan = poly => { for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]); };
  for (let f = 0; f < ix.length; f += 3) {
    const t = [ix[f], ix[f+1], ix[f+2]], s = t.map(v => Math.sign(d[v]));
    if (!(s.includes(1) && s.includes(-1))) { out.push(t[0], t[1], t[2]); continue; }   // not crossed
    const pp = [], pm = [];
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], sa = s[k], sb = s[(k + 1) % 3];
      if (sa >= 0) pp.push(a); if (sa <= 0) pm.push(a);
      if (sa * sb < 0) { const m = mid(a, b); pp.push(m); pm.push(m); }
    }
    if (pp.length >= 3) fan(pp); if (pm.length >= 3) fan(pm);
  }
  const pos = new Float32Array(P.length + extra.length); pos.set(P); pos.set(extra, P.length);
  const n2 = pos.length / 3, side = new Int8Array(n2), S = new Float32Array(n2 * 3);
  for (let v = 0; v < nV; v++) { side[v] = Math.sign(d[v]); S[v*3] = v; S[v*3+1] = v; S[v*3+2] = 0; }
  for (let i = 0; i < src.length / 3; i++) { const v = nV + i; side[v] = 0; S[v*3] = src[i*3]; S[v*3+1] = src[i*3+1]; S[v*3+2] = src[i*3+2]; }
  return { pos, idx: Uint32Array.from(out), src: S, side, cuts: cut.size };
}

// faceGroup: Int32Array per triangle. Returns { pos, idx, group (per vertex), src (per vertex: the old vertex), panels }.
export function panelLoops(P, ix, faceGroup, thickness, gap) {
  const nF = ix.length / 3, byG = new Map();
  for (let f = 0; f < nF; f++) { const g = faceGroup[f]; (byG.get(g) || byG.set(g, []).get(g)).push(f); }
  const outP = [], outI = [], outG = [], outS = [];
  for (const [g, faces] of byG) {
    // local vertices = fans of face corners around each old vertex (a vertex where the group only touches
    // itself at a point gets one copy per fan, so every panel stays manifold)
    const nc = faces.length * 3, uf = new Int32Array(nc).map((_, i) => i);
    const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
    const key = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;
    const edges = new Map();
    faces.forEach((f, j) => { for (let k = 0; k < 3; k++) { const q = key(ix[f*3+k], ix[f*3+(k+1)%3]); (edges.get(q) || edges.set(q, []).get(q)).push(j * 3 + k); } });
    for (const list of edges.values()) {
      if (list.length !== 2) continue;
      const [c1, c2] = list, j1 = (c1 / 3) | 0, k1 = c1 % 3, j2 = (c2 / 3) | 0, k2 = c2 % 3;
      const f1 = faces[j1], f2 = faces[j2], a1 = ix[f1*3+k1], b1 = ix[f1*3+(k1+1)%3];
      // corner of f2 at the same old vertex: f2 holds the edge reversed (b1 -> a1), starting at corner k2
      const cA2 = ix[f2*3+k2] === a1 ? j2*3 + k2 : j2*3 + (k2 + 1) % 3, cB2 = ix[f2*3+k2] === b1 ? j2*3 + k2 : j2*3 + (k2 + 1) % 3;
      const u = (x, y) => { x = find(x); y = find(y); if (x !== y) uf[x] = y; };
      u(j1*3 + k1, cA2); u(j1*3 + (k1 + 1) % 3, cB2);
    }
    const map = new Map(), loc = [], corner = new Int32Array(nc);
    for (let c = 0; c < nc; c++) { const r = find(c); if (!map.has(r)) { map.set(r, loc.length); loc.push(ix[faces[(c / 3) | 0] * 3 + c % 3]); } corner[c] = map.get(r); }
    const n = loc.length, nrm = new Float64Array(n * 3);
    faces.forEach((f, j) => {
      const a = ix[f*3], b = ix[f*3+1], c = ix[f*3+2];
      const ux = P[b*3]-P[a*3], uy = P[b*3+1]-P[a*3+1], uz = P[b*3+2]-P[a*3+2], wx = P[c*3]-P[a*3], wy = P[c*3+1]-P[a*3+1], wz = P[c*3+2]-P[a*3+2];
      const x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx;
      for (let k = 0; k < 3; k++) { const i = corner[j*3+k] * 3; nrm[i] += x; nrm[i+1] += y; nrm[i+2] += z; }
    });
    for (let i = 0; i < n * 3; i += 3) { const l = Math.hypot(nrm[i], nrm[i+1], nrm[i+2]) || 1; nrm[i] /= l; nrm[i+1] /= l; nrm[i+2] /= l; }
    // border edges (local vertex pairs, in face order): edges used once inside the panel
    const dirE = [];
    for (const list of edges.values()) if (list.length === 1) { const c = list[0], j = (c / 3) | 0, k = c % 3; dirE.push(corner[j*3+k], corner[j*3+(k+1)%3]); }
    // pull the border inward (into the panel, along the surface) by `gap`
    const inward = new Float64Array(n * 3), isB = new Uint8Array(n);
    for (let e = 0; e < dirE.length; e += 2) {
      const la = dirE[e], lb = dirE[e + 1], a = loc[la], b = loc[lb];
      const ex = P[b*3]-P[a*3], ey = P[b*3+1]-P[a*3+1], ez = P[b*3+2]-P[a*3+2];
      for (const l of [la, lb]) {
        const nx = nrm[l*3], ny = nrm[l*3+1], nz = nrm[l*3+2];
        // interior is on the left of a border edge walked in face order: n x e
        inward[l*3] += ny*ez - nz*ey; inward[l*3+1] += nz*ex - nx*ez; inward[l*3+2] += nx*ey - ny*ex; isB[l] = 1;
      }
    }
    const base = outP.length / 3;
    for (let l = 0; l < n; l++) {
      const v = loc[l]; let x = P[v*3], y = P[v*3+1], z = P[v*3+2];
      if (isB[l] && gap > 0) {
        const L = Math.hypot(inward[l*3], inward[l*3+1], inward[l*3+2]);
        if (L > 1e-12) { x += inward[l*3] / L * gap; y += inward[l*3+1] / L * gap; z += inward[l*3+2] / L * gap; }
      }
      outP.push(x, y, z); outG.push(g); outS.push(v);
    }
    for (let l = 0; l < n; l++) {   // inner copy
      const o = (base + l) * 3;
      outP.push(outP[o] - nrm[l*3] * thickness, outP[o+1] - nrm[l*3+1] * thickness, outP[o+2] - nrm[l*3+2] * thickness); outG.push(g); outS.push(loc[l]);
    }
    faces.forEach((f, j) => {
      const a = base + corner[j*3], b = base + corner[j*3+1], c = base + corner[j*3+2];
      outI.push(a, b, c, c + n, b + n, a + n);   // outside, and the inside facing the other way
    });
    for (let e = 0; e < dirE.length; e += 2) {   // wall: outer edge b -> a, inner a -> b
      const a = base + dirE[e], b = base + dirE[e + 1];
      outI.push(b, a, a + n, b, a + n, b + n);
    }
  }
  return { pos: new Float32Array(outP), idx: new Uint32Array(outI), group: Int32Array.from(outG), src: Int32Array.from(outS), panels: byG.size };
}
