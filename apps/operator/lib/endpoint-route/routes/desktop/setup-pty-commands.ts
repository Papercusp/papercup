/**
 * GET /api/desktop/setup-pty-commands — platform-correct spawn opts for
 * the Setup Wizard's inline pty terminals (install + sign-in flows).
 *
 * Ported from app/api/desktop/setup-pty-commands/route.ts. `auth: {}`.
 */
import { platform, homedir } from 'node:os';
import { defineRoute } from '../../define-route';

const MERIDIAN_VERSION = '1.42.1';
const OMP_PACKAGE = '@oh-my-pi/cli';

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * Build the install spawn spec for a given OS. Pure — `os` is the value
 * of `process.platform` and `home` is the user's home dir.
 */
export function buildInstallSpec(os: string, home: string): SpawnSpec {
  if (os === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
Write-Host '==> installing Claude Code'
Invoke-WebRequest -UseBasicParsing -Uri https://claude.ai/install.ps1 | Select-Object -ExpandProperty Content | Invoke-Expression
Write-Host '==> bootstrapping runtime'
$runtime = Join-Path $env:USERPROFILE '.papercusp\\runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
@'
{ "name":"papercusp-runtime","version":"0.0.0","private":true,
  "dependencies":{"@rynfar/meridian":"${MERIDIAN_VERSION}","${OMP_PACKAGE}":"latest"} }
'@ | Set-Content -Path (Join-Path $runtime 'package.json') -Encoding UTF8
Write-Host '==> installing meridian + omp'
npm install --prefix $runtime --no-audit --no-fund
Write-Host '==> done'
`;
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: home,
      env: {},
    };
  }
  const script = `set -e
echo '==> installing Claude Code'
curl -fsSL https://claude.ai/install.sh | bash
echo '==> bootstrapping runtime'
mkdir -p ~/.papercusp/runtime
cat > ~/.papercusp/runtime/package.json <<JSON
{
  "name": "papercusp-runtime",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@rynfar/meridian": "${MERIDIAN_VERSION}",
    "${OMP_PACKAGE}": "latest"
  }
}
JSON
echo '==> installing meridian + omp'
npm install --prefix ~/.papercusp/runtime --no-audit --no-fund
echo '==> done'
`;
  return { command: 'bash', args: ['-c', script], cwd: home, env: {} };
}

/** Build the login spawn spec for a provider. Pure. */
export function buildLoginSpec(provider: 'claude' | 'omp', home: string): SpawnSpec {
  return { command: provider, args: ['/login'], cwd: home, env: {} };
}

export default defineRoute({
  method: 'GET',
  path: '/desktop/setup-pty-commands',
  auth: {},
  handler() {
    const os = platform();
    const home = homedir();
    return Response.json({
      installRuntime: buildInstallSpec(os, home),
      loginClaude: buildLoginSpec('claude', home),
      loginOmp: buildLoginSpec('omp', home),
    });
  },
});
