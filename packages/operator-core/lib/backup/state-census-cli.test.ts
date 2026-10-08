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
      writeFileSync(join(directory, 'unknown'), 'fixture');
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', 'scripts/state-census-roots.mts'], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, PAPERCUSP_HOME: directory,
            PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'),
            PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'),
            PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key') },
        });
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.wholeInstallVerified).toBe(false);
      expect(report.scope).toBe('implemented-writer-filesystem-roots-only');
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
