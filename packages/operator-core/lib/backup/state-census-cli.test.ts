import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('unit census executable exit contract', () => {
  it('root diagnostic explicitly reports partial scope and fails unknown filesystem ownership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'root-census-cli-'));
    try {
      mkdirSync(join(directory, 'registry'));
      mkdirSync(join(directory, 'spills'));
      mkdirSync(join(directory, 'analysis-cache'));
      mkdirSync(join(directory, 'checkpoint-history'));
      mkdirSync(join(directory, '.config', 'papercusp'), { recursive: true });
      const peer = join(directory, 'registry', 'fixture', '.papercusp', 'harness', 'hyperbee');
      mkdirSync(join(peer, 'db'), { recursive: true });
      writeFileSync(join(peer, 'CORESTORE'), 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n');
      writeFileSync(join(peer, 'db', 'persistent-log'), 'state');
      const restoredPeer = join(directory, 'registry', 'fixture', '.restored', 'snapshot', 'clone', '.papercusp', 'harness', 'hyperbee');
      mkdirSync(join(restoredPeer, 'db'), { recursive: true });
      writeFileSync(join(restoredPeer, 'CORESTORE'), 'device/platform=linux\ndevice/inode=789\ndevice/created=123\n');
      const app = join(directory, 'registry', 'fixture', '.papercusp', 'apps-copy', 'portal');
      mkdirSync(join(app, 'scripts'), { recursive: true });
      mkdirSync(join(app, '.next-build-123-456-abcd'));
      writeFileSync(join(app, 'scripts', 'build-standalone.mjs'), 'const buildDistDir = ".next-build";');
      const release = join(directory, 'registry', 'fixture', '.papercusp', 'apps-copy', '.portal-runtime', 'portal', 'releases', 'generation');
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, '.papercusp-release.json'), JSON.stringify({ schemaVersion: 1,
        release: 'generation', buildId: 'fixture', publishedAt: '2026-10-08T00:00:00Z' }));
      writeFileSync(join(release, 'standalone-entry.mjs'), 'fixture');
      // An uninitialized sibling is walked, not mistaken for a valid store.
      mkdirSync(join(directory, 'registry', 'fixture', '.papercusp', 'legacy', 'hyperbee'), { recursive: true });
      writeFileSync(join(directory, 'unknown'), 'fixture');
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', 'scripts/state-census-roots.mts'], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, HOME: directory, PAPERCUSP_HOME: directory,
            PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'),
            PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'),
            PAPERCUSP_STRIP_CACHE_DIR: join(directory, 'analysis-cache'),
            PAPERCUSP_CHECKPOINT_LOG_DIR: join(directory, 'checkpoint-history'),
            PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key') },
        });
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.wholeInstallVerified).toBe(false);
      expect(report.scope).toBe('implemented-writer-filesystem-roots-only');
      expect(report.representedPeers).toHaveLength(2);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/hyperbee')).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name.includes('/.restored/snapshot/clone/'))).toBe(true);
      expect(report.representedPeers[0].disposition).toBe('preserve-state-subtree');
      expect(report.representedReleases[0].disposition).toBe('preserve-state-subtree');
      expect(report.representedSubtrees.some((entry: { name: string }) => entry.name === 'checkpoint-history')).toBe(true);
      expect(report.inventory.find((entry: { name: string }) => entry.name.endsWith('.next-build-123-456-abcd')).classification).toBe('cache');
      expect(report.residue.some((entry: { name: string }) => entry.name === 'unknown')).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.runIf(process.platform === 'linux')('returns drift exit1 for an unknown installed unit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'census-cli-'));
    try {
      writeFileSync(join(directory, 'systemctl'),
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{unit_file:"fixture-unowned-census-unique.service"}]));\n',
        { mode: 0o755 });
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', 'scripts/state-census-units.mts', '--system'], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` },
        });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.scope).toBe('systemd-system-only');
      expect(report.ok).toBe(false);
      expect(report.residue.map((entry: { name: string }) => entry.name))
        .toEqual(['fixture-unowned-census-unique.service']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
