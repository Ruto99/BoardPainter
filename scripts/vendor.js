// Copies the library files the UI imports into src/vendor/ so the app runs fully offline.
// Runs automatically after `npm install` (postinstall) and before every build.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'src', 'vendor');

const FILES = [
  'three/build/three.module.js',
  'three/examples/jsm/controls/OrbitControls.js',
  'three/examples/jsm/controls/TransformControls.js',
  'three/examples/jsm/loaders/OBJLoader.js',
  'three/examples/jsm/loaders/STLLoader.js',
  'three/examples/jsm/exporters/GLTFExporter.js',
  'three/examples/jsm/utils/BufferGeometryUtils.js',
  'three/examples/jsm/utils/TextureUtils.js',
  'three/LICENSE',
  'three-mesh-bvh/build/index.module.js',
  'three-mesh-bvh/LICENSE',
  'meshoptimizer/meshopt_simplifier.js',
  'meshoptimizer/LICENSE.md',
];

fs.rmSync(out, { recursive: true, force: true });
for (const f of FILES) {
  const dst = path.join(out, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(nm, f), dst);
}
console.log(`vendor: copied ${FILES.length} files to src/vendor`);
