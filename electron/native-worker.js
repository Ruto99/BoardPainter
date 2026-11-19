// Runs the C++ module (native/bp_native.node) off the main process's event loop, so the window
// stays responsive (move / resize) while a heavy job runs. The module itself uses all CPU cores.
const { parentPort, workerData } = require('node:worker_threads');

let mod = null, loadError = null;
try { mod = require(workerData.modulePath); } catch (err) { loadError = String(err && err.message || err); }

const OPS = {
  info: () => mod.info(),
  voxelize: a => mod.voxelize(a.pos, a.idx, a.o, a.n, a.h),
  surfaceNets: a => mod.surfaceNets(a.inside, a.o, a.n, a.h),
  fitSurface: a => mod.fitSurface(a.pos, a.idx, a.srcPos, a.srcIdx, a.buried, a.maxSnap, a.smooth, a.project),
  smoothOrient: a => mod.smoothOrient(a.N, a.Q, a.start, a.list, a.fq, a.iters, a.shuffle, a.parallel),
  smoothPos: a => mod.smoothPos(a.V, a.N, a.Q, a.O, a.start, a.list, a.fo, a.fx, a.s, a.iters, a.shuffle, a.parallel),
  mirrorPairs: a => mod.mirrorPairs(a.pos, a.o, a.cell, a.tol2),
  buildBVH: a => mod.buildBVH(a.pos, a.idx),
  bake: a => mod.bake(a.lowPos, a.uvIdx, a.uv, a.highPos, a.highIdx, a.paint, a.size, a.maxDist, a.dilate),
};

function buffersOf(v, out = []) {
  if (ArrayBuffer.isView(v)) { if (!out.includes(v.buffer)) out.push(v.buffer); }
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) buffersOf(v[k], out);
  return out;
}

parentPort.postMessage({ ready: true, ok: !!mod, error: loadError, info: mod ? mod.info() : null });
parentPort.on('message', ({ id, op, args }) => {
  try {
    if (!mod) throw new Error(loadError || 'native module not loaded');
    if (!OPS[op]) throw new Error(`unknown op ${op}`);
    const result = OPS[op](args);
    parentPort.postMessage({ id, result }, buffersOf(result));
  } catch (err) {
    parentPort.postMessage({ id, error: String(err && err.message || err) });
  }
});
