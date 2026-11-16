// Alphas: grayscale stamps that shape a brush's footprint (white = full effect, black = none).
// Stored as Float32Array(RES*RES) in [0,1], row 0 = bottom (v = -1), matching THREE.DataTexture.
export const RES = 256;

// Small deterministic PRNG so built-in alphas look the same every launch.
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function fill(fn) {
  const a = new Float32Array(RES * RES);
  for (let j = 0; j < RES; j++) {
    const v = j / (RES - 1) * 2 - 1;
    for (let i = 0; i < RES; i++) a[j * RES + i] = Math.min(1, Math.max(0, fn(i / (RES - 1) * 2 - 1, v)));
  }
  return a;
}
function normalize(a) {
  let lo = Infinity, hi = -Infinity;
  for (const x of a) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return a;
}

// Value noise with smooth interpolation on a seeded lattice
function valueNoise(seed, cells) {
  const r = rng(seed), g = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x, y) => { // x,y in [0,1]
    const fx = x * cells, fy = y * cells, ix = Math.min(cells - 1, Math.floor(fx)), iy = Math.min(cells - 1, Math.floor(fy));
    const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), W = cells + 1;
    const a = g[iy * W + ix], b = g[iy * W + ix + 1], c = g[(iy + 1) * W + ix], d = g[(iy + 1) * W + ix + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
function fbm(seed, base, oct) {
  const layers = Array.from({ length: oct }, (_, o) => valueNoise(seed + o * 101, base << o));
  return (x, y) => { let s = 0, amp = 1, tot = 0; for (const n of layers) { s += n(x, y) * amp; tot += amp; amp *= 0.5; } return s / tot; };
}
// Jittered-grid Voronoi: returns [F1, F2] distances in cell units
function voronoi(seed, cells, jitter = 0.9) {
  const r = rng(seed), pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) { pts[i * 2] = 0.5 + (r() - 0.5) * jitter; pts[i * 2 + 1] = 0.5 + (r() - 0.5) * jitter; }
  return (x, y) => {
    const fx = x * cells, fy = y * cells, cx = Math.floor(fx), cy = Math.floor(fy);
    let f1 = 9, f2 = 9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gy = cy + oy, wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells, k = (wy * cells + wx) * 2;
      const d = Math.hypot(gx + pts[k] - fx, gy + pts[k + 1] - fy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
}

const GEN = {
  square: () => fill((u, v) => 1 - smoothstep(0.78, 0.97, Math.max(Math.abs(u), Math.abs(v)))),
  ring: () => fill((u, v) => Math.exp(-(((Math.hypot(u, v) - 0.58) / 0.14) ** 2))),
  star: () => fill((u, v) => {
    const a = Math.atan2(u, v), d = Math.hypot(u, v);
    const edge = 0.42 + 0.5 * Math.pow(Math.abs(Math.cos(a * 2.5)), 6);
    return 1 - smoothstep(edge - 0.06, edge + 0.02, d);
  }),
  noise: () => { const n = fbm(11, 4, 5); return normalize(fill((u, v) => n((u + 1) / 2, (v + 1) / 2))); },
  bumps: () => { const vo = voronoi(23, 9, 0.8); return fill((u, v) => { const [f1] = vo((u + 1) / 2, (v + 1) / 2); return 1 - smoothstep(0.05, 0.42, f1); }); },
  cracks: () => {
    const vo = voronoi(37, 6, 1), n = fbm(5, 6, 3);
    return fill((u, v) => { const x = (u + 1) / 2 + (n((u + 1) / 2, (v + 1) / 2) - 0.5) * 0.06, y = (v + 1) / 2; const [f1, f2] = vo(x, y); return 1 - smoothstep(0.0, 0.07, f2 - f1); });
  },
  scales: () => {
    const a = new Float32Array(RES * RES), R = 0.17, rowH = R * 0.9;
    // rows top to bottom: each lower row is drawn over the previous one (overlapping scales)
    for (let row = 0, cy = 1 + R; cy > -1 - R; row++, cy -= rowH) {
      for (let cx = -1 - R + (row % 2) * R; cx < 1 + R * 2; cx += R * 2) {
        const i0 = Math.max(0, Math.floor(((cx - R + 1) / 2) * (RES - 1))), i1 = Math.min(RES - 1, Math.ceil(((cx + R + 1) / 2) * (RES - 1)));
        const j0 = Math.max(0, Math.floor(((cy - R + 1) / 2) * (RES - 1))), j1 = Math.min(RES - 1, Math.ceil(((cy + R + 1) / 2) * (RES - 1)));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const u = i / (RES - 1) * 2 - 1, v = j / (RES - 1) * 2 - 1, d = Math.hypot(u - cx, v - cy) / R;
          if (d < 1) a[j * RES + i] = 0.25 + 0.75 * Math.sqrt(1 - d * d) * (0.55 + 0.45 * (cy - v) / R);
        }
      }
    }
    return a;
  },
  wrinkles: () => { const n = fbm(71, 3, 3); return fill((u, v) => Math.pow(0.5 + 0.5 * Math.sin((v + (n((u + 1) / 2, (v + 1) / 2) - 0.5) * 0.5) * Math.PI * 6), 3)); },
  weave: () => fill((u, v) => {
    const k = 6, x = (u + 1) / 2 * k, y = (v + 1) / 2 * k, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const along = (ix + iy) % 2 ? fy : fx, across = (ix + iy) % 2 ? fx : fy;
    return Math.sin(Math.PI * across) ** 0.7 * (0.75 + 0.25 * Math.sin(Math.PI * along));
  }),
};

export const BUILTIN = [
  { id: 'none',     name: 'なし（丸）' },
  { id: 'square',   name: '四角' },
  { id: 'ring',     name: 'リング' },
  { id: 'star',     name: '星' },
  { id: 'noise',    name: 'ノイズ' },
  { id: 'bumps',    name: '粒・毛穴' },
  { id: 'cracks',   name: 'ひび割れ' },
  { id: 'scales',   name: 'ウロコ' },
  { id: 'wrinkles', name: 'しわ' },
  { id: 'weave',    name: '布目' },
];

const cache = new Map();
export function builtinAlpha(id) {
  if (id === 'none' || !GEN[id]) return null;
  if (!cache.has(id)) cache.set(id, GEN[id]());
  return cache.get(id);
}

// Convert an image (any size/aspect) into an alpha: fitted inside the square, luminance -> value.
export function imageToAlpha(img) {
  const c = document.createElement('canvas'); c.width = c.height = RES;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, RES, RES);
  const s = Math.min(RES / img.width, RES / img.height), w = img.width * s, h = img.height * s;
  g.drawImage(img, (RES - w) / 2, (RES - h) / 2, w, h);
  const d = g.getImageData(0, 0, RES, RES).data, a = new Float32Array(RES * RES);
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const k = ((RES - 1 - j) * RES + i) * 4; // canvas rows are top-down; alphas are bottom-up
    a[j * RES + i] = (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255 * (d[k + 3] / 255);
  }
  return a;
}

// Bilinear sample at u,v in [-1,1]; outside the square -> 0
export function sampleAlpha(a, u, v) {
  if (u <= -1 || u >= 1 || v <= -1 || v >= 1) return 0;
  const x = (u + 1) * 0.5 * (RES - 1), y = (v + 1) * 0.5 * (RES - 1);
  const i = x | 0, j = y | 0, tx = x - i, ty = y - j, k = j * RES + i;
  const a0 = a[k], a1 = a[k + 1], a2 = a[k + RES], a3 = a[k + RES + 1];
  return a0 + (a1 - a0) * tx + (a2 - a0) * ty + (a0 - a1 - a2 + a3) * tx * ty;
}

// Draw an alpha into a canvas (for thumbnails)
export function drawAlpha(a, canvas, invert = false) {
  const n = canvas.width, g = canvas.getContext('2d'), img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let val = a ? sampleAlpha(a, (x + 0.5) / n * 2 - 1, 1 - (y + 0.5) / n * 2) : Math.max(0, 1 - Math.hypot((x + 0.5) / n * 2 - 1, (y + 0.5) / n * 2 - 1)) ** 0.6;
    if (invert && a) val = 1 - val;
    const c = Math.round(val * 235 + 12), k = (y * n + x) * 4;
    img.data[k] = c; img.data[k + 1] = c; img.data[k + 2] = c; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

// RGBA bytes for a THREE.DataTexture cursor preview (white, alpha = value)
export function alphaRGBA(a, invert = false) {
  const out = new Uint8Array(RES * RES * 4);
  for (let i = 0; i < RES * RES; i++) { const v = invert ? 1 - a[i] : a[i]; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255; out[i * 4 + 3] = Math.round(v * 255); }
  return out;
}
