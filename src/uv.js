// Automatic UV unwrap for low/medium-poly meshes (e.g. after retopology).
//  1. split the surface into charts: region growing over shared edges while the face normal stays
//     within `angle` degrees of the chart's average normal (so each chart is nearly flat)
//  2. project each chart onto its own plane, rotated so its bounding box is tight (PCA)
//  3. pack the chart rectangles into the unit square (shelf packing, uniform texel density)
// The result is per face corner (uv: 6 floats per face) so seams don't split the sculpt mesh's vertices.

export function unwrap(pos, idx, opt = {}) {
  const angle = (opt.angle ?? 45) * Math.PI / 180, cosA = Math.cos(angle), cosSeed = Math.cos(Math.min(Math.PI * 0.49, angle * 1.35));
  const nF = idx.length / 3, nV = pos.length / 3;
  const fn = new Float32Array(nF * 3), area = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const a = idx[f*3]*3, b = idx[f*3+1]*3, c = idx[f*3+2]*3;
    const ux = pos[b]-pos[a], uy = pos[b+1]-pos[a+1], uz = pos[b+2]-pos[a+2], wx = pos[c]-pos[a], wy = pos[c+1]-pos[a+1], wz = pos[c+2]-pos[a+2];
    const x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx, l = Math.hypot(x, y, z);
    area[f] = l / 2;
    if (l > 0) { fn[f*3] = x / l; fn[f*3+1] = y / l; fn[f*3+2] = z / l; }
  }
  // face adjacency through shared edges
  const edge = new Map(), adj = new Int32Array(nF * 3).fill(-1);
  for (let f = 0; f < nF; f++) for (let k = 0; k < 3; k++) {
    const a = idx[f*3+k], b = idx[f*3+(k+1)%3], key = a < b ? a * nV + b : b * nV + a;
    const o = edge.get(key);
    if (o === undefined) edge.set(key, f * 3 + k);
    else if (o >= 0) { adj[f*3+k] = Math.floor(o / 3); adj[o] = f; edge.set(key, -1); }
  }
  // region growing, largest faces first as seeds
  const chart = new Int32Array(nF).fill(-1), order = Array.from({ length: nF }, (_, i) => i).sort((p, q) => area[q] - area[p]);
  const charts = [];
  const maxFaces = opt.maxChartFaces ?? 4000;
  for (const seed of order) {
    if (chart[seed] >= 0) continue;
    const id = charts.length, faces = [seed];
    let nx = fn[seed*3] * area[seed], ny = fn[seed*3+1] * area[seed], nz = fn[seed*3+2] * area[seed];
    chart[seed] = id;
    for (let h = 0; h < faces.length && faces.length < maxFaces; h++) {
      const f = faces[h];
      const l = Math.hypot(nx, ny, nz) || 1, ax = nx / l, ay = ny / l, az = nz / l;
      for (let k = 0; k < 3; k++) {
        const g = adj[f*3+k];
        if (g < 0 || chart[g] >= 0) continue;
        // zero-area faces have no normal: let them join the neighbouring chart instead of forming their own
        if (area[g] === 0) { chart[g] = id; faces.push(g); continue; }
        if (fn[g*3]*ax + fn[g*3+1]*ay + fn[g*3+2]*az < cosA) continue;
        if (fn[g*3]*fn[seed*3] + fn[g*3+1]*fn[seed*3+1] + fn[g*3+2]*fn[seed*3+2] < cosSeed) continue;   // keep the chart nearly flat
        chart[g] = id; faces.push(g);
        nx += fn[g*3] * area[g]; ny += fn[g*3+1] * area[g]; nz += fn[g*3+2] * area[g];
      }
    }
    const l = Math.hypot(nx, ny, nz);
    // a chart made only of zero-area faces has no normal; any plane works for it
    charts.push({ faces, n: l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 1] });
  }
  // project + PCA-rotate each chart
  const uv = new Float32Array(nF * 6);
  for (const ch of charts) {
    const [nx, ny, nz] = ch.n;
    // t = any unit vector perpendicular to n, b = n x t
    let tx, ty, tz;
    if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; } else { tx = nz; ty = 0; tz = -nx; }
    const l = Math.hypot(tx, ty, tz); tx /= l; ty /= l; tz /= l;
    const bx = ny*tz - nz*ty, by = nz*tx - nx*tz, bz = nx*ty - ny*tx;
    let sx = 0, sy = 0, cnt = 0;
    for (const f of ch.faces) for (let k = 0; k < 3; k++) { const p = idx[f*3+k]*3; sx += pos[p]*tx + pos[p+1]*ty + pos[p+2]*tz; sy += pos[p]*bx + pos[p+1]*by + pos[p+2]*bz; cnt++; }
    const mx = sx / cnt, my = sy / cnt;
    let cxx = 0, cxy = 0, cyy = 0;
    for (const f of ch.faces) for (let k = 0; k < 3; k++) {
      const p = idx[f*3+k]*3, u = pos[p]*tx + pos[p+1]*ty + pos[p+2]*tz - mx, v = pos[p]*bx + pos[p+1]*by + pos[p+2]*bz - my;
      cxx += u*u; cxy += u*v; cyy += v*v;
    }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy), c = Math.cos(th), s = Math.sin(th);
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const f of ch.faces) for (let k = 0; k < 3; k++) {
      const p = idx[f*3+k]*3, pu = pos[p]*tx + pos[p+1]*ty + pos[p+2]*tz - mx, pv = pos[p]*bx + pos[p+1]*by + pos[p+2]*bz - my;
      const u = pu * c + pv * s, v = -pu * s + pv * c;
      uv[f*6 + k*2] = u; uv[f*6 + k*2 + 1] = v;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    ch.u0 = u0; ch.v0 = v0; ch.w = u1 - u0; ch.h = v1 - v0;
  }
  // shelf packing; binary search on the scale so everything fits in [0,1]² with padding
  const pad = (opt.padding ?? 4) / (opt.size ?? 1024);
  const sorted = charts.slice().sort((p, q) => q.h - p.h);
  const tryPack = k => {
    let x = pad, y = pad, rowH = 0;
    for (const ch of sorted) {
      const w = ch.w * k, h = ch.h * k;
      if (x + w + pad > 1) { x = pad; y += rowH + pad; rowH = 0; }
      if (w + 2 * pad > 1) return false;
      ch.px = x; ch.py = y; x += w + pad; rowH = Math.max(rowH, h);
    }
    return y + rowH + pad <= 1;
  };
  let total = 0; for (const ch of charts) total += (ch.w + 1e-9) * (ch.h + 1e-9);
  let lo = 0, hi = 1 / Math.sqrt(total) * 1.5;
  while (tryPack(hi)) hi *= 1.5;
  for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (tryPack(mid)) lo = mid; else hi = mid; }
  tryPack(lo);
  for (const ch of charts) for (const f of ch.faces) for (let k = 0; k < 3; k++) {
    const o = f*6 + k*2;
    uv[o] = ch.px + (uv[o] - ch.u0) * lo; uv[o+1] = ch.py + (uv[o+1] - ch.v0) * lo;
  }
  let used = 0; for (const ch of charts) used += ch.w * ch.h * lo * lo;
  return { uvIdx: idx.slice(), uv, charts: charts.length, coverage: used };
}

// Draw the UV layout (for the panel preview)
export function drawUV(canvas, uvIdx, uv) {
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  g.fillStyle = '#18191c'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(217,163,91,.75)'; g.lineWidth = 0.6; g.fillStyle = 'rgba(217,163,91,.12)';
  g.beginPath();
  for (let f = 0; f < uv.length / 6; f++) {
    const o = f * 6;
    g.moveTo(uv[o] * W, (1 - uv[o+1]) * H); g.lineTo(uv[o+2] * W, (1 - uv[o+3]) * H); g.lineTo(uv[o+4] * W, (1 - uv[o+5]) * H); g.closePath();
  }
  g.fill(); g.stroke();
}
