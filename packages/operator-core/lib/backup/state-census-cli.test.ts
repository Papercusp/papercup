import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRootCensus, readMigrationCensusColumns } from '../../../../scripts/state-census-roots.mts';

// Some credential writers resolve their home at module load. Isolate before
// collection, so the in-process census cannot enumerate the developer's home.
const fixtureHome = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'root-census-cli-'));
  for (const [key, value] of Object.entries({ HOME: directory, PAPERCUSP_HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, '.config'), PAPERCUSP_WORKSPACES_ROOT: path.join(directory, 'registry'),
    PAPERCUSP_SCRATCH_ROOT: path.join(directory, 'spills'), PAPERCUSP_STRIP_CACHE_DIR: path.join(directory, 'analysis-cache'),
    PAPERCUSP_DB_ENCRYPTION_KEY_FILE: path.join(directory, 'db-key') })) vi.stubEnv(key, value as string);
  return directory;
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(fixtureHome, { recursive: true, force: true }); });

describe('unit census executable exit contract', () => {
  it('limits schema reads to exact source tables and preserves the overflow guard', async () => {
    const sources = [{ producer: 'fixture', tables: ['harness_shared.consult_state', 'public.records'] }];
    const matching = [{ table_schema: 'harness_shared', table_name: 'consult_state', column_name: 'routing', data_type: 'jsonb' }];
    const query = vi.fn(async (strings: TemplateStringsArray, tables: string[]) => {
      // A catalog with 20,001 unrelated columns must never enter the result.
      const catalog = [...matching, ...Array.from({ length: 20001 }, () => ({ table_schema: 'unrelated', table_name: 'records', column_name: 'id', data_type: 'text' }))];
      expect(strings.join('?')).toContain("(table_schema || '.' || table_name) = ANY(?)");
      return catalog.filter(row => tables.includes(`${row.table_schema}.${row.table_name}`));
    });
    expect(await readMigrationCensusColumns(query as never, sources)).toEqual(matching);
    expect(await readMigrationCensusColumns(query as never, [])).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(readMigrationCensusColumns(vi.fn(async () => Array(20001).fill(matching[0])) as never, sources))
      .rejects.toThrow('Database schema census bound exceeded');
  });
  it('root diagnostic explicitly reports partial scope and fails unknown filesystem ownership', async () => {
    const directory = fixtureHome;
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
      const cloneWriter = readFileSync(join(root, 'packages/operator-core/lib/harness/clone-github.ts'), 'utf8');
      expect(cloneWriter).toContain("join(workspacesRoot(), 'clones')");
      const clone = join(directory, 'registry', 'clones', 'owned');
      const cloned = spawnSync('git', ['clone', '--shared', '--no-checkout', '--', root, clone], { encoding: 'utf8' });
      expect(cloned.status, cloned.stderr).toBe(0);
      writeFileSync(join(clone, 'uncommitted-state'), 'preserve');
      mkdirSync(join(directory, 'registry', 'clones', 'unowned'));
      writeFileSync(join(directory, 'registry', 'clones', 'unowned', 'unknown'), 'fixture');
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', 'scripts/state-census-roots.mts'], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, HOME: directory, PAPERCUSP_HOME: directory,
            XDG_CONFIG_HOME: join(directory, '.config'),
            PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'),
            PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'),
            PAPERCUSP_STRIP_CACHE_DIR: join(directory, 'analysis-cache'),
            PAPERCUSP_CHECKPOINT_LOG_DIR: join(directory, 'checkpoint-history'),
            PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key') },
        });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout.trim(), result.stderr).not.toBe('');
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
      expect(report.representedGit.some((entry: { name: string }) => entry.name === 'registry/clones/owned')).toBe(true);
      expect(report.inventory.find((entry: { name: string }) => entry.name === 'registry/clones').classification).toBe('state');
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/clones/owned/uncommitted-state')).toBe(false);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/clones/unowned')).toBe(true);
      expect(report.representedUnknown.some((entry: { name: string }) => entry.name === 'registry/clones/unowned')).toBe(true);
      // Exercise the same entry inside the Vitest worker so loaded source is
      // observable, rather than treating the child CLI as source identity proof.
      for (const [key, value] of Object.entries({ HOME: directory, PAPERCUSP_HOME: directory,
        XDG_CONFIG_HOME: join(directory, '.config'), PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'),
        PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'), PAPERCUSP_STRIP_CACHE_DIR: join(directory, 'analysis-cache'),
        PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key') })) vi.stubEnv(key, value);
      const inProcess = await runRootCensus({ checkpointLogDir: join(directory, 'checkpoint-history') });
      expect(inProcess.wholeInstallVerified).toBe(false);
      expect(inProcess.ok).toBe(false);
      expect(inProcess.scope).toBe(report.scope);
      expect(inProcess.residue.map(entry => `${entry.kind}:${entry.root}:${entry.name}`).sort())
        .toEqual(report.residue.map((entry: { kind: string; root: string; name: string }) => `${entry.kind}:${entry.root}:${entry.name}`).sort());
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
