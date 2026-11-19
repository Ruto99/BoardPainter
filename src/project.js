// BoardPainter project file (.bpp)
//
// The file is gzip-compressed. Uncompressed layout:
//   "BPPROJ" (6 bytes) · uint16 format version · uint32 header length · header JSON (UTF-8)
//   · zero padding to a 4-byte boundary · binary blob
// The header lists every subtool and, for each typed array, its type, offset in the blob and element count.
export const EXT = 'bpp';
const MAGIC = 'BPPROJ';
const VERSION = 2;   // 2: arbitrary nested arrays (subdivision levels, quads); 1 is still readable
const TYPES = { Float32Array, Uint32Array, Int32Array, Uint8Array };
const ARRAYS = ['pos', 'idx', 'mask', 'mirror'];

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// meta: plain JSON-safe object
// subtools: [{ name, visible, pos, idx, mask, mirror, ...anything else }] — typed arrays may appear at any depth
// (e.g. subdivision levels); they are moved into the binary blob and replaced by {$a: type, o: offset, n: count}.
export async function encodeProject(meta, subtools) {
  const parts = [];
  let off = 0;
  const walk = x => {
    if (ArrayBuffer.isView(x)) {
      const d = { $a: x.constructor.name, o: off, n: x.length };
      parts.push(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
      off += x.byteLength; off += (4 - off % 4) % 4; parts.push(new Uint8Array((4 - x.byteLength % 4) % 4));
      return d;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') { const o = {}; for (const k in x) if (x[k] !== undefined && k !== 'view') o[k] = walk(x[k]); return o; }
    return x;
  };
  const subs = subtools.map(walk);
  const header = new TextEncoder().encode(JSON.stringify({ format: 'boardpainter-project', version: VERSION, ...meta, subtools: subs }));
  const pre = 6 + 2 + 4 + header.length, pad = (4 - pre % 4) % 4;
  const out = new Uint8Array(pre + pad + off), dv = new DataView(out.buffer);
  for (let i = 0; i < 6; i++) out[i] = MAGIC.charCodeAt(i);
  dv.setUint16(6, VERSION, true);
  dv.setUint32(8, header.length, true);
  out.set(header, 12);
  let p = pre + pad;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return pipe(out, new CompressionStream('gzip'));
}

export async function decodeProject(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await pipe(bytes, new DecompressionStream('gzip'));
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== MAGIC) throw new Error('BoardPainter のプロジェクトファイルではありません');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ver = dv.getUint16(6, true);
  if (ver > VERSION) throw new Error('新しいバージョンの BoardPainter で作られたファイルです');
  const hlen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hlen)));
  const pre = 12 + hlen, base = pre + (4 - pre % 4) % 4;
  const arr = d => {
    const T = TYPES[d.$a || d.type], o = d.$a ? d.o : d.offset, n = d.$a ? d.n : d.length;
    if (!T) throw new Error('ファイルが壊れています');
    const start = base + o, end = start + n * T.BYTES_PER_ELEMENT;
    if (end > bytes.length) throw new Error('ファイルが壊れています（途中で切れています）');
    return new T(bytes.slice(start, end).buffer);
  };
  const isDesc = x => x && typeof x === 'object' && (('$a' in x) || (ver === 1 && 'type' in x && 'offset' in x));
  const walk = x => isDesc(x) ? arr(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x;
  return finish(header, walk);
}
function finish(header, walk) {
  const subtools = (header.subtools || []).map((e, n) => {
    const s = walk(e);
    s.name = String(s.name || `サブツール${n + 1}`); s.visible = s.visible !== false;
    for (const k of ARRAYS) if (!(s[k] instanceof TYPES[k === 'pos' || k === 'mask' ? 'Float32Array' : k === 'idx' ? 'Uint32Array' : 'Int32Array'])) throw new Error('ファイルが壊れています');
    const nV = s.pos.length / 3;
    if (s.pos.length % 3 || s.idx.length % 3 || s.mask.length !== nV || s.mirror.length !== nV) throw new Error('ファイルが壊れています');
    for (let i = 0; i < s.idx.length; i++) if (s.idx[i] >= nV) throw new Error('ファイルが壊れています');
    return s;
  });
  if (!subtools.length) throw new Error('サブツールが入っていません');
  delete header.subtools;
  return { meta: header, subtools };
}

// ---------------- streaming (models whose file would not fit in one 2 GB buffer) ----------------
// Same bytes as encodeProject: gzip of magic · version · header · padding · blob, produced piece by piece.
export function encodeProjectStream(meta, subtools, piece = 8 << 20) {
  const parts = [];
  let off = 0;
  const walk = x => {
    if (ArrayBuffer.isView(x)) {
      const d = { $a: x.constructor.name, o: off, n: x.length };
      parts.push(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
      off += x.byteLength; const pad = (4 - off % 4) % 4; if (pad) { parts.push(new Uint8Array(pad)); off += pad; }
      return d;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') { const o = {}; for (const k in x) if (x[k] !== undefined && k !== 'view') o[k] = walk(x[k]); return o; }
    return x;
  };
  const subs = subtools.map(walk);
  const header = new TextEncoder().encode(JSON.stringify({ format: 'boardpainter-project', version: VERSION, ...meta, subtools: subs }));
  const pre = 6 + 2 + 4 + header.length, pad = (4 - pre % 4) % 4, head = new Uint8Array(pre + pad), dv = new DataView(head.buffer);
  for (let i = 0; i < 6; i++) head[i] = MAGIC.charCodeAt(i);
  dv.setUint16(6, VERSION, true); dv.setUint32(8, header.length, true); head.set(header, 12);
  const queue = [head, ...parts];
  let qi = 0, qo = 0;
  const raw = new ReadableStream({
    pull(c) {
      while (qi < queue.length && qo >= queue[qi].length) { qi++; qo = 0; }
      if (qi >= queue.length) { c.close(); return; }
      const b = queue[qi], n = Math.min(piece, b.length - qo);
      c.enqueue(b.slice(qo, qo + n)); qo += n;   // a copy, so the stream never holds the model's own buffers
    },
  });
  return raw.pipeThrough(new CompressionStream('gzip'));
}

// stream: ReadableStream of the file's bytes (gzip). Every typed array gets its own buffer, filled as the
// decompressed bytes go by, so nothing ever holds the whole file at once.
export async function decodeProjectStream(stream, onProgress) {
  const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
  let buf = new Uint8Array(0), pos = 0;   // bytes before the blob are collected until the header is parsed
  const take = async need => {
    while (buf.length < need) {
      const { value, done } = await reader.read(); if (done) throw new Error('ファイルが壊れています（途中で切れています）');
      const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb;
    }
  };
  await take(12);
  if (String.fromCharCode(...buf.subarray(0, 6)) !== MAGIC) throw new Error('BoardPainter のプロジェクトファイルではありません');
  const dv = new DataView(buf.buffer, 0, 12), ver = dv.getUint16(6, true), hlen = dv.getUint32(8, true);
  if (ver > VERSION) throw new Error('新しいバージョンの BoardPainter で作られたファイルです');
  const pre = 12 + hlen, base = pre + (4 - pre % 4) % 4;
  await take(base);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(12, pre)));
  // all array descriptors, in blob order
  const descs = [];
  const isDesc = x => x && typeof x === 'object' && (('$a' in x) || (ver === 1 && 'type' in x && 'offset' in x));
  const find = x => { if (isDesc(x)) descs.push(x); else if (Array.isArray(x)) x.forEach(find); else if (x && typeof x === 'object') Object.values(x).forEach(find); };
  find(header.subtools || []);
  for (const d of descs) {
    const T = TYPES[d.$a || d.type]; if (!T) throw new Error('ファイルが壊れています');
    d._o = d.$a ? d.o : d.offset; d._n = d.$a ? d.n : d.length; d._arr = new T(d._n); d._b = new Uint8Array(d._arr.buffer);
  }
  const order = descs.slice().sort((a, b) => a._o - b._o);
  let total = 0; for (const d of descs) total = Math.max(total, d._o + d._b.length);
  // copy a decompressed piece that starts at blob offset `at` into the arrays it overlaps
  let di = 0;
  const feed = (chunk, at) => {
    const end = at + chunk.length;
    while (di < order.length && order[di]._o + order[di]._b.length <= at) di++;
    for (let k = di; k < order.length && order[k]._o < end; k++) {
      const d = order[k], s = Math.max(at, d._o), e = Math.min(end, d._o + d._b.length);
      if (e > s) d._b.set(chunk.subarray(s - at, e - at), s - d._o);
    }
  };
  let at = 0;
  if (buf.length > base) { feed(buf.subarray(base), 0); at = buf.length - base; }
  buf = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    feed(value, at); at += value.length;
    if (onProgress && total) onProgress(Math.min(1, at / total));
  }
  if (at < total) throw new Error('ファイルが壊れています（途中で切れています）');
  const walk = x => isDesc(x) ? x._arr : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x;
  return finish(header, walk);
}
