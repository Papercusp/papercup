---
rel_path: "portability/census/v41/03-state-census-cli.test.ts.part-003"
updated_at: 1794241756285
_body: "content"
---

idue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/retained-app')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unproven-app')).toBe(true);
      expect(report.representedUnknown.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unproven-app')).toBe(true);
      expect(report.inventory.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unproven-app/hyperbee.single-instance.lock')).toBe(false);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name.includes('/unproven-app/'))).toBe(false);
      expect(report.representedPeers[0].disposition).toBe('preserve-state-subtree');
      expect(report.representedReleases[0].disposition).toBe('preserve-state-subtree');
      expect(report.representedSubtrees.some((entry: { name: string }) => entry.name === 'checkpoint-history')).toBe(true);
      expect(report.inventory.find((entry: { name: string }) => entry.name.endsWith('.next-build-123-456-abcd')).classification).toBe('cache');
      expect(report.residue.some((entry: { name: string }) => entry.name === 'unknown')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'affected-cache/unowned-cache-entry')).toBe(true);
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
      for (const [path, content] of acceptedLocks) expect(readFileSync(path, 'utf8')).toBe(content);
      expect(readFileSync(`${unprovenPeer}${lockSuffix}`, 'utf8')).toBe(JSON.stringify(lock));
      expect([...acceptedLocks.keys()].map(path => lstatSync(path).ino)).toEqual(lockInodes);
      expect(readlinkSync(rejectedLocks.find(path => path.includes('lock-case-symlink'))!)).toBe(`${peer}${lockSuffix}`);
      for (const [kind, content] of rejectedContents) {
        expect(readFileSync(rejectedLocks.find(path => path.includes(`lock-case-${kind}/`))!, 'utf8')).toBe(content);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('includes receipt-backed reaper tails in the root census and leaves unproven tails as residue', async () => {
    const directory = fixtureHome;
    try {
      const env = {
        HOME: directory, PAPERCUSP_HOME: directory, XDG_CONFIG_HOME: join(directory, '.config'),
        PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'), PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'),
        PAPERCUSP_STRIP_CACHE_DIR: join(directory, 'analysis-cache'),
        AFFECTED_TASK_HISTORY_PATH: join(directory, 'affected-cache', 'durations.json'),
        AFFECTED_TASK_VERDICT_CACHE_PATH: join(directory, 'affected-cache', 'verdict.json'),
        PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key'),
      };
      mkdirSync(directory, { recursive: true });
      for (const path of [env.PAPERCUSP_WORKSPACES_ROOT, env.PAPERCUSP_SCRATCH_ROOT, env.PAPERCUSP_STRIP_CACHE_DIR,
        join(directory, 'affected-cache'), join(directory, '.config', 'papercusp'), join(directory, '.papercusp', 'secrets'),
        join(directory, 'checkpoint-history')]) {
        mkdirSync(path, { recursive: true });
      }
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const source = join(directory, 'reaper-output.log');
      writeFileSync(source, 'fixture tail bytes');
      await archiveReapTail('task-123', source, directory, new Date('2026-10-11T12:00:00.000Z'));
      const orphan = 'reap-archive/2026-10-11/unproven.tail.log';
      const mergedRootPrefix = '.papercusp/';
      writeFileSync(join(directory, '.papercusp', orphan), 'unproven fixture');

      const report = await runRootCensus({ checkpointLogDir: join(directory, 'checkpoint-history') });
      const inventoryNames = report.inventory.map(entry => entry.name);
      expect(inventoryNames).toContain(`${mergedRootPrefix}reap-archive/2026-10-11/task-123.tail.log`);
      expect(inventoryNames).toContain(`${mergedRootPrefix}reap-archive/2026-10-11/task-123.tail.log.receipt.json`);
      expect(report.residue.some(entry => entry.name === `${mergedRootPrefix}${orphan}`)).toBe(true);
    } finally {
      rmSync(join(directory, '.papercusp', 'reap-archive'), { recursive: true, force: true });
    }
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

