import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const WRAPPER = join(REPO_ROOT, 'apps/operator/scripts/systemd/papercusp-script-snapshot.sh');

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
    expect(service).toContain('RuntimeDirectory=papercup-tmp-scratch-reclaim');
    expect(service).toContain('RuntimeDirectoryMode=0700');
    expect(service).toContain('Environment=TMPDIR=%t/papercup-tmp-scratch-reclaim');
  });

  it('bootstraps cleanup when the target refuses temporary allocation', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-tmp-recovery-test-'));
    try {
      const target = join(root, 'full-target');
      const runtimeBase = join(root, 'runtime');
      const shim = join(root, 'shim');
      mkdirSync(target);
      mkdirSync(runtimeBase);
      mkdirSync(shim);
      const old = makeEntry(target, 'papercusp-affected-tests-old.log', 300);
      const fresh = makeEntry(target, 'papercusp-affected-tests-fresh.log');
      const realMktemp = spawnSync('bash', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).stdout.trim();
      expect(realMktemp).not.toBe('');
      const mktempShim = join(shim, 'mktemp');
      writeFileSync(mktempShim, `#!/usr/bin/env bash\nfor arg in "$@"; do\n  case "$arg" in "${target}"/*) echo 'No space left on device' >&2; exit 1;; esac\ndone\nexec "${realMktemp}" "$@"\n`);
      chmodSync(mktempShim, 0o755);
      const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
      delete env.PAPERCUSP_SCRIPT_SNAPSHOT_SELF_COPIED;
      delete env.PAPERCUSP_SCRIPT_SNAPSHOT_SELF_DIR;
      const args = [WRAPPER, SCRIPT, '--root', target, '--execute'];
      const blocked = spawnSync('bash', args, { env: { ...env, TMPDIR: target }, encoding: 'utf8', timeout: 30_000 });
      expect(blocked.status).toBe(73);
      expect(blocked.stderr).toContain('unable to create self-snapshot directory');
      expect(existsSync(old)).toBe(true);

      const service = readFileSync(SERVICE, 'utf8');
      const configuredTmp = /^Environment=TMPDIR=(.+)$/m.exec(service)?.[1];
      expect(configuredTmp).toBeDefined();
      const runtime = configuredTmp!.replace('%t', runtimeBase);
      mkdirSync(runtime, { mode: 0o700 });
      const recovered = spawnSync('bash', args, { env: { ...env, TMPDIR: runtime }, encoding: 'utf8', timeout: 30_000 });
      expect(recovered.status).toBe(0);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(readdirSync(runtime)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses a persistent wall-clock timer rather than an in-process or monotonic loop', () => {
    const timer = readFileSync(TIMER, 'utf8');

    expect(timer).toContain('OnCalendar=*:0/30');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=papercup-tmp-scratch-reclaim.service');
    expect(timer).toContain('WantedBy=timers.target');
  });
});
