// Exact mesh booleans with the Manifold library (Apache-2.0, https://github.com/elalish/manifold): the result keeps
// sharp edges and flat faces exactly, unlike the voxel boolean. Inputs must be closed (watertight) surfaces;
// otherwise exactBoolean returns { error: 'notClosed' } so the caller can fall back to the voxel version.
// Per-vertex mask and color ride along as extra vertex properties (interpolated where the surfaces are cut).
import Module from 'manifold-3d';

let ready = null;
export function loadManifold() {
  if (!ready) ready = Module().then(w => { w.setup(); return w; }).catch(err => { ready = null; throw err; });
  return ready;
}

const NP = 7;   // x y z mask r g b
function toMesh(W, m, base) {
  const n = m.pos.length / 3, vp = new Float32Array(n * NP);
  for (let v = 0; v < n; v++) {
    const o = v * NP;
    vp[o] = m.pos[v*3]; vp[o+1] = m.pos[v*3+1]; vp[o+2] = m.pos[v*3+2];
    vp[o+3] = m.mask ? m.mask[v] : 0;
    if (m.paint) { vp[o+4] = m.paint[v*3]; vp[o+5] = m.paint[v*3+1]; vp[o+6] = m.paint[v*3+2]; }
    else { vp[o+4] = base[0]; vp[o+5] = base[1]; vp[o+6] = base[2]; }
  }
  const mesh = new W.Mesh({ numProp: NP, vertProperties: vp, triVerts: Uint32Array.from(m.idx) });
  mesh.merge();   // weld vertices that share a position (seams from imports), so the surface can be closed
  return mesh;
}

// a, b: { pos, idx, mask?, paint? }; op: 'union' | 'subtract' | 'intersect'
// Returns { pos, idx, mask, paint (null when neither had color) } | { error }
export function exactBoolean(W, a, b, op, opt = {}) {
  const base = opt.base || [0.8, 0.8, 0.8], keep = [];
  try {
    let A, B;
    try { A = new W.Manifold(toMesh(W, a, base)); keep.push(A); B = new W.Manifold(toMesh(W, b, base)); keep.push(B); }
    catch (err) { return { error: 'notClosed', detail: String(err && err.message || err) }; }
    if (A.status && A.status() !== 'NoError') return { error: 'notClosed', which: 'a' };
    if (B.status && B.status() !== 'NoError') return { error: 'notClosed', which: 'b' };
    const R = op === 'union' ? A.add(B) : op === 'subtract' ? A.subtract(B) : A.intersect(B);
    keep.push(R);
    if (R.isEmpty()) return { error: 'empty' };
    const out = R.getMesh(), vp = out.vertProperties, np = out.numProp, tv = out.triVerts, nP = vp.length / np;
    // vertices that Manifold split for different properties (where the two surfaces meet) are welded again:
    // mergeFromVert[i] -> mergeToVert[i]
    const to = new Int32Array(nP).map((_, i) => i), mf = out.mergeFromVert, mt = out.mergeToVert;
    if (mf) for (let i = 0; i < mf.length; i++) to[mf[i]] = mt[i];
    for (let i = 0; i < nP; i++) { let j = to[i]; while (to[j] !== j) j = to[j]; to[i] = j; }
    const id = new Int32Array(nP).fill(-1); let n = 0;
    for (let i = 0; i < tv.length; i++) { const r = to[tv[i]]; if (id[r] < 0) id[r] = n++; }
    const pos = new Float32Array(n * 3), mask = new Float32Array(n), paint = new Float32Array(n * 3);
    for (let i = 0; i < nP; i++) {
      const k = id[i]; if (k < 0) continue;
      const o = i * np; pos[k*3] = vp[o]; pos[k*3+1] = vp[o+1]; pos[k*3+2] = vp[o+2];
      mask[k] = np > 3 ? Math.min(1, Math.max(0, vp[o+3])) : 0;
      if (np >= 7) { paint[k*3] = vp[o+4]; paint[k*3+1] = vp[o+5]; paint[k*3+2] = vp[o+6]; }
    }
    const idx = new Uint32Array(tv.length); for (let i = 0; i < tv.length; i++) idx[i] = id[to[tv[i]]];
    return { pos, idx, mask, paint: a.paint || b.paint ? paint : null };
  } finally { for (const m of keep) try { m.delete(); } catch {} }
}
