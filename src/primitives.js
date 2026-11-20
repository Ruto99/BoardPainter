// Primitive shapes as polygon meshes (mostly quads, wound counter-clockwise seen from outside), centred on the
// origin, Y up. Used by the Claude link (agent tools) to build hard-surface props from parts.
//   box(w, h, d, { segs: [x, y, z], taper })      taper: top face scale (1 = box, 0.5 = frustum)
//   cylinder(r, h, { sides, rings, rTop, caps })  rTop: top radius (0 = cone), caps: close the ends
//   sphere(r, { sides, rings })
//   torus(R, r, { sides, rings })                 R: ring radius, r: tube radius (ring lies in the XZ plane)
// Each returns { pos: Float32Array, polys: number[][] }.

export function box(w, h, d, opt = {}) {
  const sx = Math.max(1, opt.segs?.[0] | 0 || 1), sy = Math.max(1, opt.segs?.[1] | 0 || 1), sz = Math.max(1, opt.segs?.[2] | 0 || 1);
  const taper = opt.taper ?? 1, P = [], polys = [], map = new Map();
  // vertices on a lattice (i, j, k): shared between faces by key
  const vid = (i, j, k) => {
    const key = i + ',' + j + ',' + k; let v = map.get(key); if (v !== undefined) return v;
    const t = j / sy, s = 1 + (taper - 1) * t;
    v = P.length / 3; P.push((i / sx - 0.5) * w * s, (t - 0.5) * h, (k / sz - 0.5) * d * s); map.set(key, v); return v;
  };
  // a face is a grid over two lattice axes (u, v) at a fixed third coordinate; `flip` sets the winding outward
  const face = (fix, val, ua, va, nu, nv, flip) => {
    for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
      const c = (x, y) => { const q = [0, 0, 0]; q[fix] = val; q[ua] = x; q[va] = y; return vid(q[0], q[1], q[2]); };
      const quad = [c(a, b), c(a + 1, b), c(a + 1, b + 1), c(a, b + 1)];
      polys.push(flip ? quad.reverse() : quad);
    }
  };
  face(0, sx, 1, 2, sy, sz, false); face(0, 0, 1, 2, sy, sz, true);     // +x, -x
  face(1, sy, 2, 0, sz, sx, false); face(1, 0, 2, 0, sz, sx, true);     // +y, -y
  face(2, sz, 0, 1, sx, sy, false); face(2, 0, 0, 1, sx, sy, true);     // +z, -z
  orient(P, polys, middle);
  return { pos: new Float32Array(P), polys };
}

export function cylinder(r, h, opt = {}) {
  const n = Math.max(3, opt.sides | 0 || 16), rings = Math.max(1, opt.rings | 0 || 1), rTop = opt.rTop ?? r, caps = opt.caps !== false;
  const P = [], polys = [];
  const apex = rTop <= 1e-9;
  const rowsUsed = apex ? rings : rings + 1;
  for (let j = 0; j < rowsUsed; j++) {
    const t = j / rings, rr = r + (rTop - r) * t, y = (t - 0.5) * h;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; P.push(Math.cos(a) * rr, y, -Math.sin(a) * rr); }
  }
  const at = (j, i) => j * n + ((i % n) + n) % n;
  for (let j = 0; j + 1 < rowsUsed; j++) for (let i = 0; i < n; i++) polys.push([at(j, i), at(j, i + 1), at(j + 1, i + 1), at(j + 1, i)]);
  if (apex) {   // cone tip
    const tip = P.length / 3; P.push(0, h / 2, 0);
    const j = rowsUsed - 1; for (let i = 0; i < n; i++) polys.push([at(j, i), at(j, i + 1), tip]);
  } else if (caps) {
    const top = []; for (let i = 0; i < n; i++) top.push(at(rings, i)); polys.push(top);
  }
  if (caps) { const bot = []; for (let i = n - 1; i >= 0; i--) bot.push(at(0, i)); polys.push(bot); }
  orient(P, polys, middle);
  return { pos: new Float32Array(P), polys };
}

export function sphere(r, opt = {}) {
  const n = Math.max(3, opt.sides | 0 || 16), m = Math.max(2, opt.rings | 0 || 8), P = [], polys = [];
  P.push(0, -r, 0);   // south pole 0
  for (let j = 1; j < m; j++) {
    const phi = -Math.PI / 2 + Math.PI * j / m, y = Math.sin(phi) * r, rr = Math.cos(phi) * r;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; P.push(Math.cos(a) * rr, y, -Math.sin(a) * rr); }
  }
  const north = P.length / 3; P.push(0, r, 0);
  const at = (j, i) => 1 + (j - 1) * n + ((i % n) + n) % n;
  for (let i = 0; i < n; i++) polys.push([0, at(1, i + 1), at(1, i)]);
  for (let j = 1; j + 1 < m; j++) for (let i = 0; i < n; i++) polys.push([at(j, i), at(j, i + 1), at(j + 1, i + 1), at(j + 1, i)]);
  for (let i = 0; i < n; i++) polys.push([at(m - 1, i), at(m - 1, i + 1), north]);
  orient(P, polys, middle);
  return { pos: new Float32Array(P), polys };
}

export function torus(R, r, opt = {}) {
  const n = Math.max(3, opt.sides | 0 || 24), m = Math.max(3, opt.rings | 0 || 12), P = [], polys = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, cx = Math.cos(a), cz = -Math.sin(a);
    for (let j = 0; j < m; j++) { const b = j / m * Math.PI * 2, rr = R + Math.cos(b) * r; P.push(cx * rr, Math.sin(b) * r, cz * rr); }
  }
  const at = (i, j) => ((i % n + n) % n) * m + ((j % m) + m) % m;
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) polys.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  orient(P, polys, (x, y, z) => { const l = Math.hypot(x, z) || 1; return [x / l * R, 0, z / l * R]; });
  return { pos: new Float32Array(P), polys };
}

// make every face point away from `centerOf(face centre)` (convex shapes: the middle; torus: the tube's centre)
function orient(P, polys, centerOf) {
  for (const f of polys) {
    let x = 0, y = 0, z = 0, cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < f.length; k++) {
      const a = f[k] * 3, b = f[(k + 1) % f.length] * 3;
      x += (P[a+1] - P[b+1]) * (P[a+2] + P[b+2]); y += (P[a+2] - P[b+2]) * (P[a] + P[b]); z += (P[a] - P[b]) * (P[a+1] + P[b+1]);
      cx += P[a]; cy += P[a+1]; cz += P[a+2];
    }
    cx /= f.length; cy /= f.length; cz /= f.length;
    const c = centerOf(cx, cy, cz);
    if (x * (cx - c[0]) + y * (cy - c[1]) + z * (cz - c[2]) < 0) f.reverse();
  }
  return polys;
}
const middle = () => [0, 0, 0];

// rotate (degrees, applied X then Y then Z), scale and move the points in place
export function transformPoints(P, { move = [0, 0, 0], rotate = [0, 0, 0], scale = [1, 1, 1], pivot = [0, 0, 0] } = {}) {
  const [ax, ay, az] = rotate.map(d => d * Math.PI / 180);
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  for (let i = 0; i < P.length; i += 3) {
    let x = (P[i] - pivot[0]) * scale[0], y = (P[i+1] - pivot[1]) * scale[1], z = (P[i+2] - pivot[2]) * scale[2], t;
    t = y * cx - z * sx; z = y * sx + z * cx; y = t;           // X
    t = x * cy + z * sy; z = -x * sy + z * cy; x = t;          // Y
    t = x * cz - y * sz; y = x * sz + y * cz; x = t;           // Z
    P[i] = x + pivot[0] + move[0]; P[i+1] = y + pivot[1] + move[1]; P[i+2] = z + pivot[2] + move[2];
  }
  return P;
}
