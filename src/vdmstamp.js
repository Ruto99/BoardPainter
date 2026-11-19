// Vector displacement (VDM) stamps for the VDM brush.
//
// A stamp is { S, vec: Float32Array(S*S*3) }, rows top-down, covering the square [-1, 1]^2 of the brush's tangent
// plane; each texel is a displacement in that frame: x along the brush's right, y along its up, z along the surface
// normal, in units of the brush radius (the convention of Blender's VDM brushes, so their EXR files load as is).
import { unzlibSync } from 'three/addons/libs/fflate.module.js';

// ---------------- built-in stamps (shapes with overhangs: what a height map can't do) ----------------
const sstep = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const SHAPES = {
  // mushroom: a stem and a cap whose rim curls out over it
  mushroom: (u, v) => {
    const r = Math.hypot(u, v); if (r >= 0.95) return [0, 0, 0];
    const cap = sstep((0.95 - r) / 0.35), stem = sstep((0.45 - r) / 0.25);
    const h = 0.55 * stem + 0.35 * cap, out = 0.45 * cap * (1 - stem) * sstep(r / 0.5);
    return r > 1e-6 ? [u / r * out * 0.6, v / r * out * 0.6, h] : [0, 0, h];
  },
  // hook: a horn that bends toward +x as it rises
  hook: (u, v) => {
    const r = Math.hypot(u, v); if (r >= 0.9) return [0, 0, 0];
    const t = sstep((0.9 - r) / 0.9), h = 0.9 * t * t;
    return [0.55 * h * h, 0, h];
  },
  // horn: a tall, slightly twisted spike
  horn: (u, v) => {
    const r = Math.hypot(u, v); if (r >= 0.85) return [0, 0, 0];
    const t = Math.pow(sstep((0.85 - r) / 0.85), 1.6), h = 1.1 * t, a = 0.6 * t;
    return [(u * Math.cos(a) - v * Math.sin(a) - u) * 0.6, (u * Math.sin(a) + v * Math.cos(a) - v) * 0.6, h];
  },
  // ring: a raised torus whose outer edge leans outward
  ring: (u, v) => {
    const r = Math.hypot(u, v), d = Math.abs(r - 0.6); if (d >= 0.25) return [0, 0, 0];
    const t = sstep((0.25 - d) / 0.25), h = 0.22 * t, out = r > 0.6 ? 0.08 * t : 0;
    return r > 1e-6 ? [u / r * out, v / r * out, h] : [0, 0, h];
  },
};
export const BUILTIN_VDM = [
  { id: 'v:mushroom', name: 'キノコ（傘が張り出す）' },
  { id: 'v:hook', name: 'フック（曲がったツノ）' },
  { id: 'v:horn', name: 'ねじれたツノ' },
  { id: 'v:ring', name: '輪（外へ張り出す）' },
];
const cache = new Map();
export function builtinVDM(id, S = 128) {
  if (cache.has(id)) return cache.get(id);
  const f = SHAPES[id.slice(2)]; if (!f) return null;
  const vec = new Float32Array(S * S * 3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S * 2 - 1, v = 1 - (y + 0.5) / S * 2, d = f(u, v), k = (y * S + x) * 3;
    vec[k] = d[0]; vec[k+1] = d[1]; vec[k+2] = d[2];
  }
  const st = { S, vec }; cache.set(id, st); return st;
}

// bilinear sample at (u, v) in [-1, 1]^2 (v up); out = [x, y, z]
export function sampleVDM(st, u, v, out) {
  const S = st.S, fx = (u + 1) / 2 * S - 0.5, fy = (1 - (v + 1) / 2) * S - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  out[0] = out[1] = out[2] = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const x = Math.min(S - 1, Math.max(0, x0 + i)), y = Math.min(S - 1, Math.max(0, y0 + j)), w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty), k = (y * S + x) * 3;
    out[0] += st.vec[k] * w; out[1] += st.vec[k+1] * w; out[2] += st.vec[k+2] * w;
  }
  return out;
}

// small preview (RGBA, size n): height shaded, sideways push tinted
export function vdmPreview(st, n = 64) {
  const out = new Uint8ClampedArray(n * n * 4), d = [0, 0, 0];
  let mz = 1e-6; for (let k = 2; k < st.vec.length; k += 3) mz = Math.max(mz, Math.abs(st.vec[k]));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    sampleVDM(st, (x + 0.5) / n * 2 - 1, 1 - (y + 0.5) / n * 2, d);
    const g = 40 + 200 * Math.max(0, d[2]) / mz, side = Math.min(1, Math.hypot(d[0], d[1]) / mz * 3), k = (y * n + x) * 4;
    out[k] = g + side * 30; out[k+1] = g * (1 - side * 0.3); out[k+2] = g * (1 - side * 0.6); out[k+3] = 255;
  }
  return out;
}

// ---------------- OpenEXR reader (scanline; NONE / RLE / ZIPS / ZIP; HALF / FLOAT) ----------------
function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 5.960464477539063e-8;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
function unRLE(src, size) {
  const out = new Uint8Array(size); let i = 0, o = 0;
  while (i < src.length && o < size) {
    const c = (src[i] << 24) >> 24; i++;
    if (c < 0) { for (let k = 0; k < -c && o < size; k++) out[o++] = src[i++]; }
    else { const b = src[i++]; for (let k = 0; k <= c && o < size; k++) out[o++] = b; }
  }
  return out;
}
// undo the predictor and the byte interleaving used by RLE / ZIP
function unPredict(t) {
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 0xff;
  const out = new Uint8Array(t.length), h = (t.length + 1) >> 1;
  for (let i = 0, a = 0, b = h; i < t.length; i += 2) { out[i] = t[a++]; if (i + 1 < t.length) out[i + 1] = t[b++]; }
  return out;
}
export function readEXR(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), dec = new TextDecoder();
  if (dv.getUint32(0, true) !== 20000630) throw new Error('EXR ファイルではありません');
  const flags = dv.getUint32(4, true);
  if (flags & 0x200) throw new Error('タイル形式の EXR には対応していません');
  if (flags & 0x1000) throw new Error('マルチパートの EXR には対応していません');
  let o = 8; const cstr = () => { const s = o; while (b[o]) o++; return dec.decode(b.subarray(s, o++)); };
  const ch = []; let comp = 0, win = null;
  for (;;) {
    const name = cstr(); if (!name) break;
    const type = cstr(), len = dv.getInt32(o, true); o += 4; const end = o + len;
    if (type === 'chlist') { for (;;) { const n = cstr(); if (!n) break; ch.push({ name: n, type: dv.getInt32(o, true) }); o += 16; } }
    else if (name === 'compression') comp = b[o];
    else if (name === 'dataWindow') win = [dv.getInt32(o, true), dv.getInt32(o + 4, true), dv.getInt32(o + 8, true), dv.getInt32(o + 12, true)];
    o = end;
  }
  if (!win) throw new Error('EXR の大きさが読めません');
  const per = { 0: 1, 1: 1, 2: 1, 3: 16 }[comp];
  if (!per) throw new Error(`この圧縮方式の EXR には対応していません（${['なし', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'][comp] || comp}）。保存時に ZIP か圧縮なしを選んでください`);
  const W = win[2] - win[0] + 1, H = win[3] - win[1] + 1;
  ch.sort((a, c) => a.name < c.name ? -1 : a.name > c.name ? 1 : 0);
  const out = Object.fromEntries(ch.map(c => [c.name, new Float32Array(W * H)]));
  const bytesOf = t => t === 1 ? 2 : 4, lineBytes = ch.reduce((n, c) => n + W * bytesOf(c.type), 0);
  const nBlocks = Math.ceil(H / per);
  for (let k = 0; k < nBlocks; k++) {
    let p = Number(dv.getBigUint64(o + k * 8, true));
    const y0 = dv.getInt32(p, true) - win[1], size = dv.getInt32(p + 4, true); p += 8;
    const lines = Math.min(per, H - y0), raw = lines * lineBytes;
    let data = b.subarray(p, p + size);
    if (size < raw) {   // compressed (a block that wouldn't shrink is stored raw)
      if (comp === 1) data = unPredict(unRLE(data, raw));
      else if (comp === 2 || comp === 3) data = unPredict(unzlibSync(data));
    }
    const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let q = 0;
    for (let l = 0; l < lines; l++) for (const c of ch) {
      const arr = out[c.name], row = (y0 + l) * W;
      for (let x = 0; x < W; x++) {
        if (c.type === 1) { arr[row + x] = halfToFloat(ddv.getUint16(q, true)); q += 2; }
        else if (c.type === 2) { arr[row + x] = ddv.getFloat32(q, true); q += 4; }
        else { arr[row + x] = ddv.getUint32(q, true); q += 4; }
      }
    }
  }
  return { width: W, height: H, channels: out };
}
// EXR -> stamp: R, G, B = x, y, z (resampled to a square of at most 512)
export function stampFromEXR(buf) {
  const e = readEXR(buf), C = e.channels, R = C.R || C.X || C.r, G = C.G || C.Y || C.g, B = C.B || C.Z || C.b;
  if (!R || !G || !B) throw new Error('R・G・B のチャンネルがありません');
  const S = Math.min(512, Math.max(e.width, e.height)), vec = new Float32Array(S * S * 3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const sx = Math.min(e.width - 1, Math.floor((x + 0.5) / S * e.width)), sy = Math.min(e.height - 1, Math.floor((y + 0.5) / S * e.height)), k = sy * e.width + sx, o = (y * S + x) * 3;
    vec[o] = R[k] || 0; vec[o+1] = G[k] || 0; vec[o+2] = B[k] || 0;
  }
  return { S, vec };
}

// ---------------- capture: a sculpted plate -> stamp ----------------
// cur / ref: current and original (flat) positions of the plate, faces idx; the plate lies in the XY plane,
// centred at (cx, cy) with half-size h, normal +Z. Each triangle is rasterised at its original place.
export function captureStamp(cur, ref, idx, cx, cy, h, S = 256) {
  const vec = new Float32Array(S * S * 3), filled = new Uint8Array(S * S), U = [0, 0, 0], V = [0, 0, 0], D = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let f = 0; f < idx.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const v = idx[f + k] * 3;
      U[k] = ((ref[v] - cx) / h + 1) / 2 * S; V[k] = (1 - ((ref[v+1] - cy) / h + 1) / 2) * S;
      D[k][0] = (cur[v] - ref[v]) / h; D[k][1] = (cur[v+1] - ref[v+1]) / h; D[k][2] = (cur[v+2] - ref[v+2]) / h;
    }
    const det = (U[1] - U[0]) * (V[2] - V[0]) - (U[2] - U[0]) * (V[1] - V[0]); if (Math.abs(det) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(U[0], U[1], U[2]))), x1 = Math.min(S - 1, Math.ceil(Math.max(U[0], U[1], U[2])));
    const y0 = Math.max(0, Math.floor(Math.min(V[0], V[1], V[2]))), y1 = Math.min(S - 1, Math.ceil(Math.max(V[0], V[1], V[2])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w1 = ((px - U[0]) * (V[2] - V[0]) - (U[2] - U[0]) * (py - V[0])) / det, w2 = ((U[1] - U[0]) * (py - V[0]) - (px - U[0]) * (V[1] - V[0])) / det, w0 = 1 - w1 - w2;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const k = (y * S + x) * 3; filled[y * S + x] = 1;
      for (let j = 0; j < 3; j++) vec[k + j] = D[0][j] * w0 + D[1][j] * w1 + D[2][j] * w2;
    }
  }
  return { S, vec };
}
