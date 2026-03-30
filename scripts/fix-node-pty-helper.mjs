import fs from 'fs';
import path from 'path';

function resolveNodePtySpawnHelperPath() {
  if (process.platform === 'win32') {
    return null;
  }

  try {
    const nodePtyRoot = path.dirname(require.resolve('node-pty/package.json'));
    const helperPath = path.join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    return fs.existsSync(helperPath) ? helperPath : null;
  } catch {
    return null;
  }
}

const helperPath = resolveNodePtySpawnHelperPath();
if (!helperPath) {
  process.exit(0);
}

const stat = fs.statSync(helperPath);
if ((stat.mode & 0o111) !== 0) {
  process.exit(0);
}

fs.chmodSync(helperPath, stat.mode | 0o755);
console.log(`[fix-node-pty-helper] made executable: ${helperPath}`);
