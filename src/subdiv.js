// Catmull-Clark subdivision for the multires levels (the quad scheme of ZBrush, Blender, Maya).
//
// The lower level is a list of polygons { start, idx } (quads after the first step). Vertex numbering one level up:
//   [0, n)              the old vertices (moved by the vertex rule)
//   [n, n + nE)         one per edge          ev[e*4 .. e*4+3] = [a, b, left polygon, right polygon | -1]
//   [n + nE, + nFaces)  one per polygon (its centroid)
// Polygon p with corners c0..cm-1 becomes m quads, in order, [c_j, edge(c_j, c_j+1), face p, edge(c_j-1, c_j)], so
// child quad j of polygon p is number off[p] + j (and 4q + j above the first step). Each quad is drawn as the
// triangles [q0, q1, q2], [q0, q2, q3].
//
// Creases and borders: their edges subdivide to the midpoint; a vertex on exactly 2 of them follows that curve
// ((6v + a + b) / 8), a vertex on 3 or more stays where it is.

export function ccTopology(F, n) {
  const st = F.start, ix = F.idx, nP = st.length - 1, nS = ix.length;
  // edges numbered in first-seen order without a Map: each polygon side is bucketed under its smaller vertex
  const nxt = i => { const p = faceOfSide[i]; return i + 1 < st[p + 1] ? i + 1 : st[p]; };
  const faceOfSide = new Uint32Array(nS);
  for (let p = 0; p < nP; p++) for (let i = st[p]; i < st[p + 1]; i++) faceOfSide[i] = p;
  const bs = new Uint32Array(n + 1);
  for (let i = 0; i < nS; i++) { const a = ix[i], b = ix[nxt(i)]; bs[(a < b ? a : b) + 1]++; }
  for (let v = 0; v < n; v++) bs[v + 1] += bs[v];
  const other = new Uint32Array(nS), fill = bs.slice(0, n);
  for (let i = 0; i < nS; i++) { const a = ix[i], b = ix[nxt(i)]; if (a < b) other[fill[a]++] = b; else other[fill[b]++] = a; }
  const slotE = new Int32Array(nS).fill(-1), sideE = new Uint32Array(nS);
  let nE = 0;
  for (let i = 0; i < nS; i++) {
    const a = ix[i], b = ix[nxt(i)], lo = a < b ? a : b, hi = a < b ? b : a;
    let s = bs[lo]; while (other[s] !== hi) s++;
    if (slotE[s] < 0) slotE[s] = nE++;
    sideE[i] = slotE[s];
  }
  const ev = new Int32Array(nE * 4).fill(-1), seen = new Uint8Array(nE);
  for (let i = 0; i < nS; i++) {
    const e = sideE[i], p = faceOfSide[i];
    if (!seen[e]) { seen[e] = 1; ev[e*4] = ix[i]; ev[e*4+1] = ix[nxt(i)]; ev[e*4+2] = p; } else ev[e*4+3] = p;
  }
  const quads = new Uint32Array(nS * 4), tri = new Uint32Array(nS * 6);
  let q = 0;
  for (let p = 0; p < nP; p++) {
    const s0 = st[p], m = st[p + 1] - s0, fp = n + nE + p;
    for (let j = 0; j < m; j++, q++) {
      const v = ix[s0 + j], eN = n + sideE[s0 + j], eP = n + sideE[s0 + (j + m - 1) % m];
      quads[q*4] = v; quads[q*4+1] = eN; quads[q*4+2] = fp; quads[q*4+3] = eP;
      tri[q*6] = v; tri[q*6+1] = eN; tri[q*6+2] = fp; tri[q*6+3] = v; tri[q*6+4] = fp; tri[q*6+5] = eP;
    }
  }
  const edgeOf = (a, b) => { const lo = a < b ? a : b, hi = a < b ? b : a; for (let s = bs[lo]; s < bs[lo + 1]; s++) if (other[s] === hi) return slotE[s]; return -1; };
  return { idx: tri, quads, ev, nf: nP, edgeOf };
}

// positions one level up. P: lower positions, F: lower polygons, ev: from ccTopology, cs: Set of crease edge keys
// (a * n + b, a < b) or null
export function ccPositions(P, F, ev, cs) {
  const n = P.length / 3, nE = ev.length / 4, st = F.start, ix = F.idx, nP = st.length - 1;
  const out = new Float32Array((n + nE + nP) * 3), fo = (n + nE) * 3;
  for (let p = 0; p < nP; p++) {
    let x = 0, y = 0, z = 0; const m = st[p + 1] - st[p];
    for (let i = st[p]; i < st[p + 1]; i++) { const v = ix[i] * 3; x += P[v]; y += P[v+1]; z += P[v+2]; }
    out[fo + p*3] = x / m; out[fo + p*3+1] = y / m; out[fo + p*3+2] = z / m;
  }
  // per vertex: sum of face points, sum of edge midpoints, edge count; sharp edges: count and sum of the far ends
  const Fs = new Float32Array(n * 3), Rs = new Float32Array(n * 3), fc = new Uint32Array(n), ec = new Uint32Array(n);
  const sc = new Uint8Array(n), Ss = new Float32Array(n * 3);
  for (let p = 0; p < nP; p++) for (let i = st[p]; i < st[p + 1]; i++) { const v = ix[i]; fc[v]++; Fs[v*3] += out[fo + p*3]; Fs[v*3+1] += out[fo + p*3+1]; Fs[v*3+2] += out[fo + p*3+2]; }
  for (let e = 0; e < nE; e++) {
    const a = ev[e*4], b = ev[e*4+1], A = a * 3, B = b * 3, o = (n + e) * 3;
    const mx = (P[A] + P[B]) / 2, my = (P[A+1] + P[B+1]) / 2, mz = (P[A+2] + P[B+2]) / 2;
    const sharp = ev[e*4+3] < 0 || (cs && cs.has(a < b ? a * n + b : b * n + a));
    if (sharp) {
      out[o] = mx; out[o+1] = my; out[o+2] = mz;
      if (sc[a] < 255) sc[a]++; if (sc[b] < 255) sc[b]++;
      Ss[A] += P[B]; Ss[A+1] += P[B+1]; Ss[A+2] += P[B+2]; Ss[B] += P[A]; Ss[B+1] += P[A+1]; Ss[B+2] += P[A+2];
    } else {
      const f = fo + ev[e*4+2] * 3, g = fo + ev[e*4+3] * 3;
      out[o] = (P[A] + P[B] + out[f] + out[g]) / 4; out[o+1] = (P[A+1] + P[B+1] + out[f+1] + out[g+1]) / 4; out[o+2] = (P[A+2] + P[B+2] + out[f+2] + out[g+2]) / 4;
    }
    ec[a]++; ec[b]++;
    Rs[A] += mx; Rs[A+1] += my; Rs[A+2] += mz; Rs[B] += mx; Rs[B+1] += my; Rs[B+2] += mz;
  }
  for (let v = 0; v < n; v++) {
    const i = v * 3, k = ec[v];
    if (sc[v] >= 3 || !k || !fc[v]) { out[i] = P[i]; out[i+1] = P[i+1]; out[i+2] = P[i+2]; continue; }
    if (sc[v] === 2) { for (let c = 0; c < 3; c++) out[i+c] = (6 * P[i+c] + Ss[i+c]) / 8; continue; }
    for (let c = 0; c < 3; c++) out[i+c] = (Fs[i+c] / fc[v] + 2 * Rs[i+c] / k + (k - 3) * P[i+c]) / k;
  }
  return out;
}

// per-vertex attribute (c components) one level up: edges take their midpoint, faces their corners' average
export function ccAttr(a, F, ev, c) {
  const n = a.length / c, nE = ev.length / 4, st = F.start, ix = F.idx, nP = st.length - 1;
  const out = new Float32Array((n + nE + nP) * c); out.set(a);
  for (let e = 0; e < nE; e++) { const x = ev[e*4] * c, y = ev[e*4+1] * c, o = (n + e) * c; for (let k = 0; k < c; k++) out[o + k] = (a[x + k] + a[y + k]) / 2; }
  for (let p = 0; p < nP; p++) {
    const o = (n + nE + p) * c, m = st[p + 1] - st[p];
    for (let i = st[p]; i < st[p + 1]; i++) for (let k = 0; k < c; k++) out[o + k] += a[ix[i] * c + k];
    for (let k = 0; k < c; k++) out[o + k] /= m;
  }
  return out;
}

// mirror pairs one level up (null when the lower level's topology isn't symmetric enough)
export function ccMirror(mir, F, ev, n, edgeOf) {
  if (!mir || mir.length !== n) return null;
  const nE = ev.length / 4, st = F.start, ix = F.idx, nP = st.length - 1, out = new Int32Array(n + nE + nP).fill(-1);
  out.set(mir);
  let want = 0, miss = 0;
  for (let e = 0; e < nE; e++) {
    const ma = mir[ev[e*4]], mb = mir[ev[e*4+1]]; if (ma < 0 || mb < 0) continue;
    want++; const f = edgeOf(ma, mb); if (f < 0) miss++; else out[n + e] = n + f;
  }
  for (let p = 0; p < nP; p++) {
    const s0 = st[p], m = st[p + 1] - s0, a = mir[ix[s0]], b = mir[ix[s0 + 1]]; if (a < 0 || b < 0) continue;
    want++;
    const e = edgeOf(a, b); if (e < 0) { miss++; continue; }
    // the mirrored polygon is the one on that edge whose corners are all mirrors of p's
    let hit = -1;
    for (const q of [ev[e*4+2], ev[e*4+3]]) {
      if (q < 0 || st[q + 1] - st[q] !== m) continue;
      let ok = true;
      for (let i = s0; i < s0 + m && ok; i++) { const w = mir[ix[i]]; let f = false; for (let j = st[q]; j < st[q + 1]; j++) if (ix[j] === w) { f = true; break; } ok = f; }
      if (ok) { hit = q; break; }
    }
    if (hit < 0) miss++; else out[n + nE + p] = n + nE + hit;
  }
  return want && miss > want * 0.01 ? null : out;
}

// polygroups (per vertex): new vertices take the group of an end / first corner
export function ccGroups(g, F, ev) {
  const n = g.length, nE = ev.length / 4, st = F.start, ix = F.idx, nP = st.length - 1, out = new Int32Array(n + nE + nP);
  out.set(g);
  for (let e = 0; e < nE; e++) out[n + e] = g[ev[e*4]];
  for (let p = 0; p < nP; p++) out[n + nE + p] = g[ix[st[p]]];
  return out;
}

// quads of a Catmull-Clark level as polygons { start, idx }
export function quadFaces(quads) {
  const nQ = quads.length / 4, start = new Uint32Array(nQ + 1);
  for (let q = 0; q <= nQ; q++) start[q] = q * 4;
  return { start, idx: quads };
}
