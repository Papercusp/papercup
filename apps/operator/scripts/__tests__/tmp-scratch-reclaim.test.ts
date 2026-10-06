import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/reclaim-tmp-scratch-residue.sh');
const SERVICE = join(REPO_ROOT, 'apps/operator/scripts/systemd/papercup-tmp-scratch-reclaim.service');
const TIMER = join(REPO_ROOT, 'apps/operator/scripts/systemd/papercup-tmp-scratch-reclaim.timer');

function ageFileOrDirectory(path: string, ageMinutes: number): void {
  const timestamp = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, timestamp, timestamp);
}

function makeEntry(root: string, name: string, ageMinutes?: number): string {
  const path = join(root, name);
  if (name.endsWith('/')) {
    mkdirSync(path, { recursive: true });
  } else if (name.includes('.dir')) {
    mkdirSync(path, { recursive: true });
  } else {
    writeFileSync(path, 'residue\n');
  }
  if (ageMinutes !== undefined) ageFileOrDirectory(path, ageMinutes);
  return path;
}

function runReclaimer(root: string, ...args: string[]) {
  return spawnSync('bash', [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('reclaim-tmp-scratch-residue.sh', () => {
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toBe('');
  });

  it('defaults to a dry-run and leaves old audited residue intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-tmp-reclaim-test-'));
    try {
      const old = makeEntry(root, 'papercusp-affected-tests-old.log', 300);
      const result = runReclaimer(root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('execute=0');
      expect(result.stdout).toContain('reclaimable=1');
      expect(existsSync(old)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes only old audited top-level shapes and preserves fresh or unrelated paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-tmp-reclaim-test-'));
    try {
      const oldEntries = [
        makeEntry(root, 'papercusp-affected-tests-old.log', 300),
        makeEntry(root, 'prov-sidecar-old.dir', 300),
        makeEntry(root, 'sidecar-fresh-old.dir', 300),
        makeEntry(root, 'pc-heavy-self.legacy.sh', 300),
      ];
      const fresh = makeEntry(root, 'papercusp-affected-tests-fresh.log');
      const unrelated = makeEntry(root, 'exthost-123.cpuprofile', 300);
      const nestedParent = join(root, 'pc-heavy');
      const nested = join(nestedParent, 'pc-heavy-self.nested');
      mkdirSync(nested, { recursive: true });
      ageFileOrDirectory(nested, 300);

      const result = runReclaimer(root, '--execute', '--max-age-min', '240');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('execute=1');
      expect(result.stdout).toContain('grand-reclaimable=4');
      for (const path of oldEntries) expect(existsSync(path)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('shared /tmp scratch reclaimer systemd contract', () => {
  it('runs the audited actor against the shared namespace with hardening', () => {
    const service = readFileSync(SERVICE, 'utf8');

    expect(service).toContain(
      'ExecStart=%h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercusp-script-snapshot.sh %h/papercupai-workspace/papercusp/scripts/reclaim-tmp-scratch-residue.sh --execute --root /tmp --max-age-min 240',
    );
    expect(service).toContain('PrivateTmp=no');
    expect(service).toContain('ProtectSystem=strict');
    expect(service).toContain('ProtectHome=read-only');
    expect(service).toContain('ReadWritePaths=/tmp');
    expect(service).toContain('NoNewPrivileges=yes');
    expect(service).toContain('TimeoutStartSec=600');
  });

  it('uses a persistent wall-clock timer rather than an in-process or monotonic loop', () => {
    const timer = readFileSync(TIMER, 'utf8');

    expect(timer).toContain('OnCalendar=*:0/30');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=papercup-tmp-scratch-reclaim.service');
    expect(timer).toContain('WantedBy=timers.target');
  });
});
