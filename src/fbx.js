// Binary FBX 7.4 writer (meshes only): what Blender, Maya, 3ds Max, Unity and Unreal import.
//
// File layout: "Kaydara FBX Binary  \0\x1a\0" + uint32 version, then node records, a null record and the footer.
// A node record: uint32 end offset · uint32 property count · uint32 property bytes · uint8 name length · name ·
// properties · child records (+ a 13-byte null record when it has children or no properties).
// Big arrays are zlib-compressed (encoding 1).

const HEAD = 'Kaydara FBX Binary  \0\x1a\0';
const VERSION = 7400;
// the fixed FileId / CreationTime / footer id that other writers use (the SDK checks they belong together)
const FILE_ID = [0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1];
const CREATION_TIME = '1970-01-01 10:00:00:000';
const FOOT_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOT_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];

// property helpers
const I = v => ({ t: 'I', v }), L = v => ({ t: 'L', v }), D = v => ({ t: 'D', v }), Sx = v => ({ t: 'S', v }), C = v => ({ t: 'C', v });
const R = v => ({ t: 'R', v }), Ai = v => ({ t: 'i', v }), Ad = v => ({ t: 'd', v });
const N = (name, props = [], kids = []) => ({ name, props, kids });
// Properties70 entry
const P = (name, type, label, flags, ...vals) => N('P', [Sx(name), Sx(type), Sx(label), Sx(flags), ...vals]);

const enc = new TextEncoder();
async function zlib(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// properties -> bytes (arrays over 4 KB are compressed)
async function propBytes(p) {
  const T = p.t;
  if (T === 'I') { const b = new Uint8Array(5); b[0] = 73; new DataView(b.buffer).setInt32(1, p.v, true); return b; }
  if (T === 'L') { const b = new Uint8Array(9); b[0] = 76; new DataView(b.buffer).setBigInt64(1, BigInt(p.v), true); return b; }
  if (T === 'D') { const b = new Uint8Array(9); b[0] = 68; new DataView(b.buffer).setFloat64(1, p.v, true); return b; }
  if (T === 'C') return Uint8Array.of(67, p.v ? 1 : 0);
  if (T === 'S' || T === 'R') {
    const s = T === 'S' ? enc.encode(p.v) : Uint8Array.from(p.v), b = new Uint8Array(5 + s.length);
    b[0] = T.charCodeAt(0); new DataView(b.buffer).setUint32(1, s.length, true); b.set(s, 5); return b;
  }
  // arrays: i (int32), d (float64)
  const raw = T === 'i' ? (p.v instanceof Int32Array ? p.v : Int32Array.from(p.v)) : (p.v instanceof Float64Array ? p.v : Float64Array.from(p.v));
  let data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), encoding = 0;
  if (data.length > 4096) { data = await zlib(data); encoding = 1; }
  const b = new Uint8Array(13 + data.length), dv = new DataView(b.buffer);
  b[0] = T.charCodeAt(0); dv.setUint32(1, raw.length, true); dv.setUint32(5, encoding, true); dv.setUint32(9, data.length, true); b.set(data, 13);
  return b;
}

// node -> list of byte chunks; `at` is the absolute offset where the record starts
async function nodeBytes(node, at, out) {
  const name = enc.encode(node.name), props = [];
  for (const p of node.props) props.push(await propBytes(p));
  const plen = props.reduce((n, b) => n + b.length, 0);
  const head = new Uint8Array(13 + name.length), hv = new DataView(head.buffer);
  out.push(head);
  let off = at + head.length + plen;
  for (const b of props) out.push(b);
  for (const k of node.kids) off = await nodeBytes(k, off, out);
  if (node.kids.length || !node.props.length) { out.push(new Uint8Array(13)); off += 13; }
  hv.setUint32(0, off, true); hv.setUint32(4, node.props.length, true); hv.setUint32(8, plen, true); head[12] = name.length; head.set(name, 13);
  return off;
}

// meshes: [{ name, pos: Float32Array, polys: [[v...]], normals?: Float32Array (per vertex), colors?: Float32Array (sRGB rgb per vertex),
//            uv?: { idx: per-polygon-corner uv index list, uv: Float32Array pairs } | null, crease?: Set of 'a,b' edges (a < b) }]
export async function encodeFBX(meshes, opt = {}) {
  let id = 1000000;
  const nid = () => ++id;
  const objects = [], conns = [];
  for (const m of meshes) {
    const gid = nid(), mid = nid(), matId = nid();
    const pvi = [], corners = [];   // polygon vertex index (last corner of each polygon xor -1); corner -> vertex
    for (const f of m.polys) { for (let k = 0; k < f.length; k++) { pvi.push(k === f.length - 1 ? ~f[k] : f[k]); corners.push(f[k]); } }
    const kids = [
      N('Properties70'),
      N('GeometryVersion', [I(124)]),
      N('Vertices', [Ad(Float64Array.from(m.pos))]),
      N('PolygonVertexIndex', [Ai(Int32Array.from(pvi))]),
    ];
    const layer = [];
    // edges (each by the polygon corner it starts at) + crease per edge
    if (m.crease && m.crease.size) {
      const seen = new Map(), edges = [], cr = [];
      let c = 0;
      for (const f of m.polys) for (let k = 0; k < f.length; k++, c++) {
        const a = f[k], b = f[(k + 1) % f.length], key = a < b ? a + ',' + b : b + ',' + a;
        if (seen.has(key)) continue; seen.set(key, edges.length); edges.push(c); cr.push(m.crease.has(key) ? 1 : 0);
      }
      kids.push(N('Edges', [Ai(Int32Array.from(edges))]));
      kids.push(N('LayerElementEdgeCrease', [I(0)], [N('Version', [I(101)]), N('Name', [Sx('')]), N('MappingInformationType', [Sx('ByEdge')]), N('ReferenceInformationType', [Sx('Direct')]), N('EdgeCrease', [Ad(Float64Array.from(cr))])]));
      layer.push('LayerElementEdgeCrease');
    }
    if (m.normals) {
      const n = new Float64Array(corners.length * 3);
      corners.forEach((v, i) => { n[i*3] = m.normals[v*3]; n[i*3+1] = m.normals[v*3+1]; n[i*3+2] = m.normals[v*3+2]; });
      kids.push(N('LayerElementNormal', [I(0)], [N('Version', [I(101)]), N('Name', [Sx('')]), N('MappingInformationType', [Sx('ByPolygonVertex')]), N('ReferenceInformationType', [Sx('Direct')]), N('Normals', [Ad(n)])]));
      layer.push('LayerElementNormal');
    }
    if (m.colors) {
      const nv = m.pos.length / 3, c = new Float64Array(nv * 4);
      for (let v = 0; v < nv; v++) { c[v*4] = m.colors[v*3]; c[v*4+1] = m.colors[v*3+1]; c[v*4+2] = m.colors[v*3+2]; c[v*4+3] = 1; }
      kids.push(N('LayerElementColor', [I(0)], [N('Version', [I(101)]), N('Name', [Sx('Col')]), N('MappingInformationType', [Sx('ByPolygonVertex')]), N('ReferenceInformationType', [Sx('IndexToDirect')]), N('Colors', [Ad(c)]), N('ColorIndex', [Ai(Int32Array.from(corners))])]));
      layer.push('LayerElementColor');
    }
    if (m.uv) {
      kids.push(N('LayerElementUV', [I(0)], [N('Version', [I(101)]), N('Name', [Sx('UVMap')]), N('MappingInformationType', [Sx('ByPolygonVertex')]), N('ReferenceInformationType', [Sx('IndexToDirect')]), N('UV', [Ad(Float64Array.from(m.uv.uv))]), N('UVIndex', [Ai(Int32Array.from(m.uv.idx))])]));
      layer.push('LayerElementUV');
    }
    kids.push(N('LayerElementMaterial', [I(0)], [N('Version', [I(101)]), N('Name', [Sx('')]), N('MappingInformationType', [Sx('AllSame')]), N('ReferenceInformationType', [Sx('IndexToDirect')]), N('Materials', [Ai(Int32Array.of(0))])]));
    layer.push('LayerElementMaterial');
    kids.push(N('Layer', [I(0)], [N('Version', [I(100)]), ...layer.map(t => N('LayerElement', [], [N('Type', [Sx(t)]), N('TypedIndex', [I(0)])]))]));
    objects.push(N('Geometry', [L(gid), Sx(m.name + '\0\x01Geometry'), Sx('Mesh')], kids));
    objects.push(N('Model', [L(mid), Sx(m.name + '\0\x01Model'), Sx('Mesh')], [
      N('Version', [I(232)]),
      N('Properties70', [], [P('DefaultAttributeIndex', 'int', 'Integer', '', I(0)), P('Lcl Scaling', 'Lcl Scaling', '', 'A', D(opt.scale || 1), D(opt.scale || 1), D(opt.scale || 1))]),
      N('Shading', [C(true)]), N('Culling', [Sx('CullingOff')]),
    ]));
    const col = m.baseColor || [0.85, 0.75, 0.64];
    objects.push(N('Material', [L(matId), Sx(m.name + '_mat\0\x01Material'), Sx('')], [
      N('Version', [I(102)]), N('ShadingModel', [Sx('phong')]), N('MultiLayer', [I(0)]),
      N('Properties70', [], [P('DiffuseColor', 'Color', '', 'A', D(col[0]), D(col[1]), D(col[2])), P('Diffuse', 'Vector3D', 'Vector', '', D(col[0]), D(col[1]), D(col[2]))]),
    ]));
    conns.push(N('C', [Sx('OO'), L(mid), L(0)]), N('C', [Sx('OO'), L(gid), L(mid)]), N('C', [Sx('OO'), L(matId), L(mid)]));
  }
  const now = new Date();
  const ax = (n, v) => P(n, 'int', 'Integer', '', I(v));
  const top = [
    N('FBXHeaderExtension', [], [
      N('FBXHeaderVersion', [I(1003)]), N('FBXVersion', [I(VERSION)]), N('EncryptionType', [I(0)]),
      N('CreationTimeStamp', [], [N('Version', [I(1000)]), N('Year', [I(now.getFullYear())]), N('Month', [I(now.getMonth() + 1)]), N('Day', [I(now.getDate())]), N('Hour', [I(now.getHours())]), N('Minute', [I(now.getMinutes())]), N('Second', [I(now.getSeconds())]), N('Millisecond', [I(0)])]),
      N('Creator', [Sx('BoardPainter')]),
    ]),
    N('FileId', [R(FILE_ID)]), N('CreationTime', [Sx(CREATION_TIME)]), N('Creator', [Sx('BoardPainter')]),
    N('GlobalSettings', [], [N('Version', [I(1000)]), N('Properties70', [], [
      ax('UpAxis', 1), ax('UpAxisSign', 1), ax('FrontAxis', 2), ax('FrontAxisSign', 1), ax('CoordAxis', 0), ax('CoordAxisSign', 1),
      ax('OriginalUpAxis', 1), ax('OriginalUpAxisSign', 1),
      P('UnitScaleFactor', 'double', 'Number', '', D(opt.unit || 1)), P('OriginalUnitScaleFactor', 'double', 'Number', '', D(opt.unit || 1)),
    ])]),
    N('Documents', [], [N('Count', [I(1)]), N('Document', [L(nid()), Sx('Scene'), Sx('Scene')], [N('Properties70', [], [P('SourceObject', 'object', '', ''), P('ActiveAnimStackName', 'KString', '', '', Sx(''))]), N('RootNode', [L(0)])])]),
    N('References'),
    N('Definitions', [], [
      N('Version', [I(100)]), N('Count', [I(1 + meshes.length * 3)]),
      N('ObjectType', [Sx('GlobalSettings')], [N('Count', [I(1)])]),
      N('ObjectType', [Sx('Geometry')], [N('Count', [I(meshes.length)])]),
      N('ObjectType', [Sx('Model')], [N('Count', [I(meshes.length)])]),
      N('ObjectType', [Sx('Material')], [N('Count', [I(meshes.length)])]),
    ]),
    N('Objects', [], objects),
    N('Connections', [], conns),
    N('Takes', [], [N('Current', [Sx('')])]),
  ];
  const out = [enc.encode(HEAD)], vb = new Uint8Array(4); new DataView(vb.buffer).setUint32(0, VERSION, true); out.push(vb);
  let off = HEAD.length + 4;
  for (const n of top) off = await nodeBytes(n, off, out);
  out.push(new Uint8Array(13)); off += 13;
  // footer: id, 4 zero bytes, padding to 16, version, 120 zero bytes, magic
  out.push(Uint8Array.from(FOOT_ID), new Uint8Array(4)); off += 20;
  let pad = ((off + 15) & ~15) - off; if (pad === 0) pad = 16;
  out.push(new Uint8Array(pad));
  const fv = new Uint8Array(4); new DataView(fv.buffer).setUint32(0, VERSION, true);
  out.push(fv, new Uint8Array(120), Uint8Array.from(FOOT_MAGIC));
  return new Blob(out, { type: 'application/octet-stream' });
}
