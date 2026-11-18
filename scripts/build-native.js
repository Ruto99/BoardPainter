// Builds the C++ module in native/ (native/build/Release/bp_native.node) with node-gyp.
// It uses Node-API, so the same build works in Electron without rebuilding per Electron version.
//   node scripts/build-native.js           -> on failure, warn and continue (the app falls back to JavaScript)
//   node scripts/build-native.js --strict  -> on failure, exit with an error (used by the release builds)
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const strict = process.argv.includes('--strict');
const dir = path.join(__dirname, '..', 'native');
const gyp = require.resolve('node-gyp/bin/node-gyp.js');
const r = spawnSync(process.execPath, [gyp, 'rebuild', '--release'], { cwd: dir, stdio: 'inherit' });
const out = path.join(dir, 'build', 'Release', 'bp_native.node');
if (r.status === 0 && fs.existsSync(out)) {
  console.log(`native: built ${path.relative(process.cwd(), out)}`);
} else {
  const msg = 'native: build failed — the app will use the (slower) JavaScript versions. Install a C++ compiler (Windows: Visual Studio Build Tools "Desktop development with C++") and run "npm run build:native".';
  if (strict) { console.error(msg); process.exit(1); }
  console.warn(msg);
}
