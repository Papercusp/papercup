/**
 * Binary-dependency probes (§15.20). v1.0 assumes system-installed
 * binaries on PATH; v1.1 will postinstall-download into ~/.papercusp/bin/.
 *
 *   pg_dump      — Postgres native (almost always already present)
 *   trufflehog   — secret scan tier-A (block on verified hits)
 *   gitleaks     — secret scan tier-B (warn on high-recall hits)
 *
 * Used by `papercusp doctor` and by the capture pass's first step.
 */

import { spawn } from 'node:child_process';

export interface BinaryCheck {
  name: 'pg_dump' | 'trufflehog' | 'gitleaks';
  found: boolean;
  version?: string;
  hint?: string;
}

const HINTS: Record<BinaryCheck['name'], string> = {
  pg_dump:
    'install via your OS package manager: `apt install postgresql-client` / `brew install libpq` / etc.',
  trufflehog:
    'install: `curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin` or `brew install trufflehog`',
  gitleaks:
    'install: `brew install gitleaks` or download from https://github.com/gitleaks/gitleaks/releases',
};

export async function probeBinary(
  name: BinaryCheck['name'],
): Promise<BinaryCheck> {
  const versionFlag =
    name === 'pg_dump' ? '--version' : name === 'gitleaks' ? 'version' : '--version';
  const args = versionFlag === 'version' ? ['version'] : ['--version'];
  return new Promise<BinaryCheck>((resolve) => {
    const child = spawn(name, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve({ name, found: false, hint: HINTS[name] }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ name, found: false, hint: HINTS[name] });
        return;
      }
      const versionLine = out.split('\n').find((l) => l.trim().length > 0) ?? '';
      resolve({ name, found: true, version: versionLine.trim() });
    });
  });
}

export async function probeAll(): Promise<BinaryCheck[]> {
  return Promise.all([
    probeBinary('pg_dump'),
    probeBinary('trufflehog'),
    probeBinary('gitleaks'),
  ]);
}

export async function ensureRequiredForCapture(): Promise<void> {
  const results = await probeAll();
  const missing = results.filter((r) => !r.found);
  if (missing.length > 0) {
    const lines = missing.map(
      (m) => `  - ${m.name}: not found on PATH. ${m.hint ?? ''}`.trimEnd(),
    );
    throw new Error(
      `Missing required binaries for snapshot capture:\n${lines.join('\n')}`,
    );
  }
}
