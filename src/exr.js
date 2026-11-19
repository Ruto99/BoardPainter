// OpenEXR writer: scanline image, no compression, 32-bit float channels.
// channels: { name: Float32Array(width * height) } (rows top-down); written in alphabetical order as the format requires.
export function encodeEXR(width, height, channels) {
  const names = Object.keys(channels).sort();
  const enc = new TextEncoder(), parts = [];
  let size = 0;
  const push = b => { parts.push(b); size += b.length; };
  const u8 = (...a) => push(Uint8Array.from(a));
  const i32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); push(b); };
  const f32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); push(b); };
  const str = s => { push(enc.encode(s)); u8(0); };
  const attr = (name, type, len) => { str(name); str(type); i32(len); };
  u8(0x76, 0x2f, 0x31, 0x01); i32(2);   // magic, version 2 (single part scanline)
  let chLen = 1; for (const n of names) chLen += enc.encode(n).length + 1 + 16;
  attr('channels', 'chlist', chLen);
  for (const n of names) { str(n); i32(2); u8(0, 0, 0, 0); i32(1); i32(1); }   // FLOAT, pLinear 0, sampling 1 x 1
  u8(0);
  attr('compression', 'compression', 1); u8(0);
  attr('dataWindow', 'box2i', 16); i32(0); i32(0); i32(width - 1); i32(height - 1);
  attr('displayWindow', 'box2i', 16); i32(0); i32(0); i32(width - 1); i32(height - 1);
  attr('lineOrder', 'lineOrder', 1); u8(0);
  attr('pixelAspectRatio', 'float', 4); f32(1);
  attr('screenWindowCenter', 'v2f', 8); f32(0); f32(0);
  attr('screenWindowWidth', 'float', 4); f32(1);
  u8(0);   // end of header
  // offset table, then one block per scanline: y, byte count, each channel's row
  const rowBytes = width * 4 * names.length, table = new Uint8Array(height * 8), tv = new DataView(table.buffer);
  const first = size + table.length;
  for (let y = 0; y < height; y++) tv.setBigUint64(y * 8, BigInt(first + y * (8 + rowBytes)), true);
  push(table);
  const block = new Uint8Array(height * (8 + rowBytes)), bv = new DataView(block.buffer);
  let o = 0;
  for (let y = 0; y < height; y++) {
    bv.setInt32(o, y, true); bv.setInt32(o + 4, rowBytes, true); o += 8;
    for (const n of names) { const c = channels[n]; for (let x = 0; x < width; x++, o += 4) bv.setFloat32(o, c[y * width + x], true); }
  }
  push(block);
  return new Blob(parts, { type: 'image/x-exr' });
}

// read back (tests and re-import): only what encodeEXR writes
export function decodeEXR(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), dec = new TextDecoder();
  if (dv.getUint32(0, true) !== 20000630) throw new Error('not an EXR file');
  let o = 8; const cstr = () => { const s = o; while (b[o]) o++; return dec.decode(b.subarray(s, o++)); };
  const names = []; let W = 0, H = 0;
  for (;;) {
    const name = cstr(); if (!name) break;
    const type = cstr(), len = dv.getInt32(o, true); o += 4; const end = o + len;
    if (type === 'chlist') { for (;;) { const n = cstr(); if (!n) break; names.push(n); o += 16; } }
    if (name === 'dataWindow') { W = dv.getInt32(o + 8, true) + 1; H = dv.getInt32(o + 12, true) + 1; }
    o = end;
  }
  const ch = Object.fromEntries(names.map(n => [n, new Float32Array(W * H)]));
  for (let y = 0; y < H; y++) {
    let p = Number(dv.getBigUint64(o + y * 8, true)); const yy = dv.getInt32(p, true); p += 8;
    for (const n of names) for (let x = 0; x < W; x++, p += 4) ch[n][yy * W + x] = dv.getFloat32(p, true);
  }
  return { width: W, height: H, channels: ch };
}
