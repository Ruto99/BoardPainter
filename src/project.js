// BoardPainter project file (.bpp)
//
// The file is gzip-compressed. Uncompressed layout:
//   "BPPROJ" (6 bytes) · uint16 format version · uint32 header length · header JSON (UTF-8)
//   · zero padding to a 4-byte boundary · binary blob
// The header lists every subtool and, for each typed array, its type, offset in the blob and element count.
export const EXT = 'bpp';
const MAGIC = 'BPPROJ';
const VERSION = 1;
const TYPES = { Float32Array, Uint32Array, Int32Array };
const ARRAYS = ['pos', 'idx', 'mask', 'mirror'];

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// meta: plain JSON-safe object · subtools: [{ name, visible, pos, idx, mask, mirror }]
export async function encodeProject(meta, subtools) {
  const parts = [];
  let off = 0;
  const subs = subtools.map(s => {
    const e = { name: s.name, visible: s.visible !== false };
    for (const k of ARRAYS) {
      const a = s[k];
      e[k] = { type: a.constructor.name, offset: off, length: a.length };
      parts.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      off += a.byteLength;
    }
    return e;
  });
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
  const subtools = (header.subtools || []).map((e, n) => {
    const s = { name: String(e.name || `サブツール${n + 1}`), visible: e.visible !== false };
    for (const k of ARRAYS) {
      const d = e[k], T = d && TYPES[d.type];
      if (!T) throw new Error('ファイルが壊れています');
      const start = base + d.offset, end = start + d.length * T.BYTES_PER_ELEMENT;
      if (end > bytes.length) throw new Error('ファイルが壊れています（途中で切れています）');
      s[k] = new T(bytes.slice(start, end).buffer);
    }
    const nV = s.pos.length / 3;
    if (s.pos.length % 3 || s.idx.length % 3 || s.mask.length !== nV || s.mirror.length !== nV) throw new Error('ファイルが壊れています');
    for (let i = 0; i < s.idx.length; i++) if (s.idx[i] >= nV) throw new Error('ファイルが壊れています');
    return s;
  });
  if (!subtools.length) throw new Error('サブツールが入っていません');
  delete header.subtools;
  return { meta: header, subtools };
}
