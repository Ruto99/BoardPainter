// Manual retopology from strokes drawn on a surface (like ZBrush's Topology brush): where strokes cross becomes a
// vertex, the stroke pieces between crossings become edges, and every cell closed by 3 to 6 edges becomes a face.
// Dangling ends (before the first / after the last crossing of a stroke) are dropped.
//
// strokes: [{ p: Float32Array (xyz per point), n: Float32Array (surface normal per point) }]
// Returns { pos: Float32Array, polys: number[][], nodes, edges } (faces wound counter-clockwise seen from outside)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };

// resample a polyline to a fixed step (keeps both ends), normals interpolated
function resample(s, h) {
  const P = s.p, N = s.n, n = P.length / 3, op = [P[0], P[1], P[2]], on = [N[0], N[1], N[2]];
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const a = [P[i*3-3], P[i*3-2], P[i*3-1]], b = [P[i*3], P[i*3+1], P[i*3+2]], L = Math.hypot(...sub(b, a));
    let t = h - carry;
    while (t <= L) {
      const u = t / L;
      op.push(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
      on.push(N[i*3-3] + (N[i*3] - N[i*3-3]) * u, N[i*3-2] + (N[i*3+1] - N[i*3-2]) * u, N[i*3-1] + (N[i*3+2] - N[i*3-1]) * u);
      t += h;
    }
    carry = L - (t - h);
  }
  const k = op.length - 3, L = Math.hypot(op[k] - P[n*3-3], op[k+1] - P[n*3-2], op[k+2] - P[n*3-1]);
  if (L > h * 0.3) { op.push(P[n*3-3], P[n*3-2], P[n*3-1]); on.push(N[n*3-3], N[n*3-2], N[n*3-1]); }
  return { p: op, n: on };
}
// closest points of segments p1-q1 and p2-q2: [s, t, distance]
function segSeg(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a < 1e-20 && e < 1e-20) { s = t = 0; }
  else if (a < 1e-20) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e < 1e-20) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-20 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const x = [p1[0] + d1[0]*s - p2[0] - d2[0]*t, p1[1] + d1[1]*s - p2[1] - d2[1]*t, p1[2] + d1[2]*s - p2[2] - d2[2]*t];
  return [s, t, Math.hypot(x[0], x[1], x[2])];
}

export function topologyFromStrokes(strokes, h, opt = {}) {
  const tol = h * (opt.tol ?? 0.9), maxSides = opt.maxSides ?? 6;
  const S = strokes.filter(s => s.p.length >= 6).map(s => resample(s, h));
  // spatial hash of segments
  const cell = tol * 2 + h, grid = new Map(), key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const pt = (s, i) => [S[s].p[i*3], S[s].p[i*3+1], S[s].p[i*3+2]];
  S.forEach((s, k) => { for (let i = 0; i + 1 < s.p.length / 3; i++) { const a = pt(k, i), b = pt(k, i + 1), m = [(a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2]; const g = key(...m); (grid.get(g) || grid.set(g, []).get(g)).push(k, i); } });
  // crossings: per stroke pair, runs of close segments are one crossing (keep the closest pair of the run)
  const hits = new Map();   // "k1,k2" -> [[i1 + s, i2 + t, d, point]]
  for (const [g, list] of grid) {
    const [cx, cy, cz] = g.split(',').map(Number), near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const l = grid.get(`${cx+dx},${cy+dy},${cz+dz}`); if (l) near.push(l); }
    for (let x = 0; x < list.length; x += 2) {
      const k1 = list[x], i1 = list[x + 1];
      for (const l of near) for (let y = 0; y < l.length; y += 2) {
        const k2 = l[y], i2 = l[y + 1]; if (k2 <= k1) continue;
        const a = pt(k1, i1), b = pt(k1, i1 + 1), c = pt(k2, i2), d = pt(k2, i2 + 1), [s, t, dist] = segSeg(a, b, c, d);
        if (dist > tol) continue;
        const pk = k1 + ',' + k2; (hits.get(pk) || hits.set(pk, []).get(pk)).push([i1 + s, i2 + t, dist, [(a[0] + (b[0]-a[0])*s + c[0] + (d[0]-c[0])*t) / 2, (a[1] + (b[1]-a[1])*s + c[1] + (d[1]-c[1])*t) / 2, (a[2] + (b[2]-a[2])*s + c[2] + (d[2]-c[2])*t) / 2]]);
      }
    }
  }
  const at = S.map(() => []);   // per stroke: [param, crossing id]
  const X = [];                 // crossing points
  for (const [pk, list] of hits) {
    const [k1, k2] = pk.split(',').map(Number);
    list.sort((u, v) => u[0] - v[0]);
    let run = [];
    const flush = () => { if (!run.length) return; const best = run.reduce((m, u) => u[2] < m[2] ? u : m); const id = X.length; X.push(best[3]); at[k1].push([best[0], id]); at[k2].push([best[1], id]); run = []; };
    for (const u of list) { if (run.length && (u[0] - run[run.length - 1][0] > 2.5 || Math.abs(u[1] - run[run.length - 1][1]) > 2.5)) flush(); run.push(u); }
    flush();
  }
  // merge crossings closer than the tolerance (three strokes through one spot)
  const uf = X.map((_, i) => i), find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  for (let i = 0; i < X.length; i++) for (let j = i + 1; j < X.length; j++) if (Math.hypot(...sub(X[i], X[j])) < tol * 1.5) uf[find(i)] = find(j);
  const nid = new Int32Array(X.length).fill(-1), P = [], Nn = [], cnt = [];
  for (let i = 0; i < X.length; i++) { const r = find(i); if (nid[r] < 0) { nid[r] = P.length; P.push([0, 0, 0]); Nn.push([0, 0, 0]); cnt.push(0); } nid[i] = nid[r]; const k = nid[i]; for (let c = 0; c < 3; c++) P[k][c] += X[i][c]; cnt[k]++; }
  P.forEach((p, k) => { for (let c = 0; c < 3; c++) p[c] /= cnt[k]; });
  // edges: consecutive crossings along each stroke; node normals from the strokes
  const adj = P.map(() => new Set()), edges = [];
  at.forEach((list, k) => {
    list.sort((u, v) => u[0] - v[0]);
    for (const [prm, id] of list) { const i = Math.min(S[k].n.length / 3 - 1, Math.round(prm)), n = nid[id]; for (let c = 0; c < 3; c++) Nn[n][c] += S[k].n[i*3+c]; }
    for (let j = 1; j < list.length; j++) {
      const a = nid[list[j - 1][1]], b = nid[list[j][1]];
      if (a === b || adj[a].has(b)) continue;
      adj[a].add(b); adj[b].add(a); edges.push([a, b]);
    }
  });
  const N = Nn.map(norm);
  // faces: walk with the face on the left; around each node the neighbours are sorted counter-clockwise in its
  // tangent plane, and from u -> v the walk turns to the neighbour of v just before u (clockwise from v -> u)
  const order = P.map((p, v) => {
    const n = N[v], ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], t = norm(cross(n, ref)), b = cross(n, t);
    return [...adj[v]].map(u => { const d = sub(P[u], p); return [u, Math.atan2(dot(d, b), dot(d, t))]; }).sort((x, y) => x[1] - y[1]).map(x => x[0]);
  });
  const used = new Set(), polys = [];
  for (const [a, b] of edges) for (const [u0, v0] of [[a, b], [b, a]]) {
    if (used.has(u0 + ',' + v0)) continue;
    const cyc = [u0]; let u = u0, v = v0, ok = true;
    for (let guard = 0; guard < 64; guard++) {
      used.add(u + ',' + v);
      if (v === u0) break;
      cyc.push(v);
      const o = order[v], i = o.indexOf(u), w = o[(i + o.length - 1) % o.length];
      u = v; v = w;
      if (guard === 63) ok = false;
    }
    if (!ok || cyc.length < 3 || cyc.length > maxSides || new Set(cyc).size !== cyc.length) continue;
    // keep cells that face outward (the outer boundary of a patch winds the other way)
    let nx = 0, ny = 0, nz = 0, ax = 0, ay = 0, az = 0;
    for (let k = 0; k < cyc.length; k++) {
      const p = P[cyc[k]], q = P[cyc[(k + 1) % cyc.length]];
      nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]);
      ax += N[cyc[k]][0]; ay += N[cyc[k]][1]; az += N[cyc[k]][2];
    }
    if (nx * ax + ny * ay + nz * az <= 0) continue;
    polys.push(cyc);
  }
  // compact
  const map = new Int32Array(P.length).fill(-1), pos = [];
  for (const f of polys) for (const v of f) if (map[v] < 0) { map[v] = pos.length / 3; pos.push(...P[v]); }
  return { pos: new Float32Array(pos), polys: polys.map(f => f.map(v => map[v])), nodes: P.length, edges: edges.length };
}
