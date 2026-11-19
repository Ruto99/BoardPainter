// Displacement and vector displacement maps from subdivision levels (no ray casting).
//
// Every vertex of a higher level is a known point of the base level's faces (Loop subdivision keeps each child face
// inside its parent), so each top-level face gets its base face and barycentric corners exactly. Its corners'
// UVs follow from the base face's UVs, and the map stores, per texel, how far the sculpted top level is from the
// reference surface: the smooth subdivided base (as the levels store details) or the flat base faces.
//
//   low    { pos, idx, uv }      base level: positions, triangles, per-corner uv (6 floats per triangle)
//   chain  [{ idx, ev }, ...]    the levels above it, bottom to top (ev: [a, b, opp1, opp2] per new edge vertex)
//   high   Float32Array          top-level positions (sculpted)
//   ref    Float32Array | null   top-level reference positions (smooth surface); null = flat base faces
// Returns { disp: Float32Array(S*S), vec: Float32Array(S*S*3) tangent space (x = U tangent, y = V tangent, z = normal), range }
export function levelDisplacement(low, chain, high, ref, S, opt = {}) {
  let F = low.idx, nVlo = low.pos.length / 3, nF = F.length / 3;
  let base = new Uint32Array(nF), bary = new Float32Array(nF * 9);
  for (let f = 0; f < nF; f++) { base[f] = f; bary[f*9] = bary[f*9+4] = bary[f*9+8] = 1; }
  for (const hi of chain) {
    const ev = hi.ev, ix = hi.idx, nC = ix.length / 3;
    // vertex -> faces of the current level
    const st = new Uint32Array(nVlo + 1); for (let i = 0; i < F.length; i++) st[F[i] + 1]++;
    for (let v = 0; v < nVlo; v++) st[v + 1] += st[v];
    const fl = new Uint32Array(F.length), fill = st.slice(0, nVlo);
    for (let i = 0; i < F.length; i++) fl[fill[F[i]]++] = (i / 3) | 0;
    const findFace = (a, b, c) => { for (let j = st[a]; j < st[a + 1]; j++) { const f = fl[j], x = F[f*3], y = F[f*3+1], z = F[f*3+2]; if ((x === b || y === b || z === b) && (x === c || y === c || z === c)) return f; } return -1; };
    const nb = new Uint32Array(nC), nbar = new Float32Array(nC * 9), tri = [0, 0, 0];
    for (let c = 0; c < nC; c++) {
      // the parent triangle: corner vertices of this level plus the ends of the edge vertices
      let n = 0;
      const add = v => { for (let j = 0; j < n; j++) if (tri[j] === v) return; if (n < 3) tri[n++] = v; };
      for (let k = 0; k < 3; k++) { const v = ix[c*3+k]; if (v < nVlo) add(v); else { const e = v - nVlo; add(ev[e*4]); add(ev[e*4+1]); } }
      if (n < 3) return null;
      const f = findFace(tri[0], tri[1], tri[2]); if (f < 0) return null;
      nb[c] = base[f];
      const corner = v => { for (let k = 0; k < 3; k++) if (F[f*3+k] === v) return f*9 + k*3; return -1; };
      for (let k = 0; k < 3; k++) {
        const v = ix[c*3+k], o = c*9 + k*3;
        if (v < nVlo) { const p = corner(v); nbar[o] = bary[p]; nbar[o+1] = bary[p+1]; nbar[o+2] = bary[p+2]; }
        else { const e = v - nVlo, p = corner(ev[e*4]), q = corner(ev[e*4+1]); for (let j = 0; j < 3; j++) nbar[o+j] = (bary[p+j] + bary[q+j]) / 2; }
      }
    }
    F = ix; nVlo += ev.length / 4; base = nb; bary = nbar; nF = nC;
  }
  // reference normals per top vertex (smooth), or base vertex normals (flat)
  const normalsOf = (P, ix) => {
    const n = new Float32Array(P.length);
    for (let f = 0; f < ix.length; f += 3) {
      const a = ix[f]*3, b = ix[f+1]*3, c = ix[f+2]*3, ux = P[b]-P[a], uy = P[b+1]-P[a+1], uz = P[b+2]-P[a+2], wx = P[c]-P[a], wy = P[c+1]-P[a+1], wz = P[c+2]-P[a+2];
      const x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx; for (const t of [a, b, c]) { n[t] += x; n[t+1] += y; n[t+2] += z; }
    }
    for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i+1], n[i+2]) || 1; n[i] /= l; n[i+1] /= l; n[i+2] /= l; }
    return n;
  };
  const LP = low.pos, LI = low.idx, UV = low.uv;
  const refN = ref ? normalsOf(ref, F) : null, baseN = normalsOf(LP, LI);
  const disp = new Float32Array(S * S), vec = new Float32Array(S * S * 3), filled = new Uint8Array(S * S);
  const cu = [0, 0, 0], cv = [0, 0, 0], cd = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let range = 0;
  for (let c = 0; c < nF; c++) {
    const b = base[c], ia = LI[b*3], ib = LI[b*3+1], ic = LI[b*3+2];
    // base face tangent frame from its UVs
    const u0 = UV[b*6], v0 = UV[b*6+1], u1 = UV[b*6+2], v1 = UV[b*6+3], u2 = UV[b*6+4], v2 = UV[b*6+5];
    const e1x = LP[ib*3]-LP[ia*3], e1y = LP[ib*3+1]-LP[ia*3+1], e1z = LP[ib*3+2]-LP[ia*3+2], e2x = LP[ic*3]-LP[ia*3], e2y = LP[ic*3+1]-LP[ia*3+1], e2z = LP[ic*3+2]-LP[ia*3+2];
    const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0, dt = du1 * dv2 - du2 * dv1;
    if (Math.abs(dt) < 1e-14) continue;
    const r = 1 / dt, Tx = (e1x*dv2 - e2x*dv1) * r, Ty = (e1y*dv2 - e2y*dv1) * r, Tz = (e1z*dv2 - e2z*dv1) * r;
    const Bx = (e2x*du1 - e1x*du2) * r, By = (e2y*du1 - e1y*du2) * r, Bz = (e2z*du1 - e1z*du2) * r;
    for (let k = 0; k < 3; k++) {
      const o = c*9 + k*3, w0 = bary[o], w1 = bary[o+1], w2 = bary[o+2], v = F[c*3+k];
      cu[k] = u0*w0 + u1*w1 + u2*w2; cv[k] = v0*w0 + v1*w1 + v2*w2;
      let rx, ry, rz, nx, ny, nz;
      if (ref) { rx = ref[v*3]; ry = ref[v*3+1]; rz = ref[v*3+2]; nx = refN[v*3]; ny = refN[v*3+1]; nz = refN[v*3+2]; }
      else {
        rx = LP[ia*3]*w0 + LP[ib*3]*w1 + LP[ic*3]*w2; ry = LP[ia*3+1]*w0 + LP[ib*3+1]*w1 + LP[ic*3+1]*w2; rz = LP[ia*3+2]*w0 + LP[ib*3+2]*w1 + LP[ic*3+2]*w2;
        nx = baseN[ia*3]*w0 + baseN[ib*3]*w1 + baseN[ic*3]*w2; ny = baseN[ia*3+1]*w0 + baseN[ib*3+1]*w1 + baseN[ic*3+1]*w2; nz = baseN[ia*3+2]*w0 + baseN[ib*3+2]*w1 + baseN[ic*3+2]*w2;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      }
      // orthonormal tangent frame (Gram-Schmidt against the normal), bitangent keeps the UV handedness
      let tx = Tx - nx * (Tx*nx + Ty*ny + Tz*nz), ty = Ty - ny * (Tx*nx + Ty*ny + Tz*nz), tz = Tz - nz * (Tx*nx + Ty*ny + Tz*nz);
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      let bx = ny*tz - nz*ty, by = nz*tx - nx*tz, bz = nx*ty - ny*tx;
      if (bx*Bx + by*By + bz*Bz < 0) { bx = -bx; by = -by; bz = -bz; }
      const dx = high[v*3] - rx, dy = high[v*3+1] - ry, dz = high[v*3+2] - rz;
      cd[k][0] = dx*tx + dy*ty + dz*tz; cd[k][1] = dx*bx + dy*by + dz*bz; cd[k][2] = dx*nx + dy*ny + dz*nz;
    }
    // rasterize the child triangle in UV space (texel centers), rows top-down
    const U0 = cu[0]*S, V0 = cv[0]*S, U1 = cu[1]*S, V1 = cv[1]*S, U2 = cu[2]*S, V2 = cv[2]*S;
    const det = (U1 - U0) * (V2 - V0) - (U2 - U0) * (V1 - V0); if (Math.abs(det) < 1e-12) continue;
    const eps = -0.5 / Math.sqrt(Math.abs(det));
    const x0 = Math.max(0, Math.floor(Math.min(U0, U1, U2))), x1 = Math.min(S - 1, Math.ceil(Math.max(U0, U1, U2)));
    const y0 = Math.max(0, Math.floor(Math.min(V0, V1, V2))), y1 = Math.min(S - 1, Math.ceil(Math.max(V0, V1, V2)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w1 = ((px - U0) * (V2 - V0) - (U2 - U0) * (py - V0)) / det, w2 = ((U1 - U0) * (py - V0) - (px - U0) * (V1 - V0)) / det, w0 = 1 - w1 - w2;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      const k = (S - 1 - y) * S + x; if (filled[k] && Math.min(w0, w1, w2) < 0) continue;
      for (let j = 0; j < 3; j++) vec[k*3+j] = cd[0][j]*w0 + cd[1][j]*w1 + cd[2][j]*w2;
      disp[k] = vec[k*3+2]; filled[k] = 1; range = Math.max(range, Math.abs(disp[k]));
    }
  }
  // dilate chart borders so filtering doesn't pull in the empty background
  for (let it = 0; it < (opt.dilate ?? 8); it++) {
    const add = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = y * S + x; if (filled[k]) continue;
      let n = 0, a = 0, b = 0, c = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
        const q = yy * S + xx; if (!filled[q]) continue; n++; a += vec[q*3]; b += vec[q*3+1]; c += vec[q*3+2];
      }
      if (n) add.push(k, a / n, b / n, c / n);
    }
    if (!add.length) break;
    for (let i = 0; i < add.length; i += 4) { const k = add[i]; filled[k] = 1; vec[k*3] = add[i+1]; vec[k*3+1] = add[i+2]; vec[k*3+2] = add[i+3]; disp[k] = add[i+3]; }
  }
  let covered = 0; for (let k = 0; k < S * S; k++) covered += filled[k];
  return { disp, vec, range, coverage: covered / (S * S) };
}
