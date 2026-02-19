#!/usr/bin/env node
// Pre-install check: verify native build tools exist before electron-rebuild runs.
// node-pty is a C++ addon — without a compiler, the build fails with a cryptic error.

const { execSync } = require('child_process');
const os = require('os');

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function run(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', timeout: 10000 }).toString().trim();
  } catch (_) {
    return null;
  }
}

function fail(msg, fix) {
  console.error(`\n${RED}${BOLD}✖ Missing build dependency${RESET}`);
  console.error(`${RED}  ${msg}${RESET}\n`);
  console.error(`${YELLOW}${BOLD}Fix:${RESET}`);
  fix.forEach(line => console.error(`${YELLOW}  ${line}${RESET}`));
  console.error(`\n${YELLOW}Then re-run: npm install${RESET}\n`);
  process.exit(1);
}

function ok(msg) {
  console.log(`${GREEN}✔${RESET} ${msg}`);
}

const platform = os.platform();

console.log(`\n${BOLD}Checking build dependencies for ${platform}...${RESET}\n`);

// ── Python (node-gyp needs it on all platforms) ──
const python = run('python3 --version') || run('python --version');
if (!python) {
  const fixes = {
    win32:  ['Install Python 3: https://www.python.org/downloads/', 'Or: winget install Python.Python.3.12'],
    darwin: ['brew install python3'],
    linux:  ['sudo apt install python3   # Debian/Ubuntu', 'sudo dnf install python3   # Fedora'],
  };
  fail('Python not found (required by node-gyp).', fixes[platform] || ['Install Python 3']);
}
ok(`Python: ${python}`);

// ── Platform-specific C++ toolchain ──
if (platform === 'win32') {
  // Check for MSBuild (ships with VS Build Tools)
  const msbuild = run('where msbuild.exe 2>nul')
    || run('cmd /c ""%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath" 2>nul');

  if (!msbuild) {
    fail('Visual Studio Build Tools with C++ not found.', [
      '1. Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      '2. In the installer, select "Desktop development with C++"',
      '3. Reboot after installation',
    ]);
  }
  ok('Visual Studio C++ Build Tools: found');

} else if (platform === 'darwin') {
  const xcode = run('xcode-select -p');
  if (!xcode) {
    fail('Xcode Command Line Tools not found.', [
      'xcode-select --install',
    ]);
  }
  ok(`Xcode CLT: ${xcode}`);

} else {
  // Linux — check for make and g++/gcc
  const make = run('which make');
  const gcc = run('which g++') || run('which gcc');
  if (!make || !gcc) {
    fail('C++ build tools (make, g++) not found.', [
      'sudo apt install build-essential   # Debian/Ubuntu',
      'sudo dnf groupinstall "Development Tools"   # Fedora',
      'sudo pacman -S base-devel   # Arch',
    ]);
  }
  ok(`make: ${make}`);
  ok(`C++ compiler: ${gcc}`);
}

console.log(`\n${GREEN}${BOLD}All build dependencies found. Proceeding with install.${RESET}\n`);
