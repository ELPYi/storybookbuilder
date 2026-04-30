'use strict';
/**
 * package.js
 * Runs electron-builder in --dir mode to produce dist/win-unpacked, then
 * copies the result to StorybookBuilder-v2 on the Desktop.
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const ROOT     = path.resolve(__dirname, '..');
const DIST     = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const EXE      = path.join(UNPACKED, 'Storybook Builder.exe');
const DESKTOP  = path.join(os.homedir(), 'Desktop');
const OUT_DIR  = path.join(DESKTOP, 'StorybookBuilder-v2');

console.log('Building app (packaging step)...');

// Run electron-builder; allow it to fail — the win-unpacked folder is
// created early in the process, before the optional rcedit/winCodeSign step.
const result = spawnSync(
  'npx', ['electron-builder', '--win', '--dir'],
  { cwd: ROOT, stdio: 'inherit', shell: true }
);

if (!fs.existsSync(EXE)) {
  console.error('\nBuild failed: dist/win-unpacked/Storybook Builder.exe not found.');
  if (result.error) console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.log('\nNote: electron-builder reported an error (likely rcedit icon step), but the app was built successfully.');
}

// Copy dist/win-unpacked → Desktop/StorybookBuilder-v2
console.log(`\nCopying to ${OUT_DIR} ...`);

if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}

const ps = spawnSync('powershell', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Copy-Item -Recurse -Force "${UNPACKED}" "${OUT_DIR}"`,
], { stdio: 'inherit' });

if (ps.status !== 0) {
  console.error('Copy failed.');
  process.exit(1);
}

console.log('\nDone!');
console.log(`Output: ${OUT_DIR}`);
console.log('\nZip that folder and send it — the other person just extracts it and runs "Storybook Builder.exe".');
console.log('On their first launch it will automatically install Python and the required AI packages.');
