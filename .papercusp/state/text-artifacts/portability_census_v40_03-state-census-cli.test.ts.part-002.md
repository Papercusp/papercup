---
rel_path: "portability/census/v40/03-state-census-cli.test.ts.part-002"
updated_at: 1794240916945
_body: "content"
---

r, 'CORESTORE'), 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n');
      writeFileSync(join(peer, 'db', 'persistent-log'), 'state');
      writeFileSync(join(peer, '..', 'unowned-sibling'), 'unknown state');
      writeFileSync(join(directory, 'registry', 'fixture', 'unowned-workspace-file'), 'unknown state');
      writeFileSync(join(directory, 'registry', 'fixture', '.papercusp', 'unowned-root-file'), 'unknown state');
      mkdirSync(join(directory, 'registry', 'uninitialized', '.papercusp', 'harness', 'hyperbee'), { recursive: true });
      const linkedWorkspace = join(directory, 'registry', 'linked');
      mkdirSync(linkedWorkspace);
      symlinkSync(join(directory, 'registry', 'fixture', '.papercusp'), join(linkedWorkspace, '.papercusp'));
      const restoredPeer = join(directory, 'registry', 'fixture', '.restored', 'snapshot', 'clone', '.papercusp', 'harness', 'hyperbee');
      mkdirSync(join(restoredPeer, 'db'), { recursive: true });
      writeFileSync(join(restoredPeer, 'CORESTORE'), 'device/platform=linux\ndevice/inode=789\ndevice/created=123\n');
      const nestedPeer = join(directory, 'registry', 'fixture', '.papercusp', 'harness', 'retained-app', 'hyperbee');
      mkdirSync(join(nestedPeer, 'db'), { recursive: true });
      writeFileSync(join(nestedPeer, 'CORESTORE'), 'device/platform=linux\ndevice/inode=456\ndevice/created=789\n');
      writeFileSync(join(nestedPeer, 'db', 'persistent-log'), 'preserved state');
      const unprovenPeer = join(directory, 'registry', 'fixture', '.papercusp', 'harness', 'unproven-app', 'hyperbee');
      mkdirSync(join(unprovenPeer, 'db'), { recursive: true });
      writeFileSync(join(unprovenPeer, 'db', 'unknown-log'), 'unproven');
      const lock = { pid: process.pid, token: '2f8f5ba0-d4ba-4c88-8884-2f2a7969683a',
        startedAt: '2026-11-09T00:00:00.000Z' };
      const lockSuffix = '.single-instance.lock';
      const acceptedLocks = new Map([
        [`${peer}${lockSuffix}`, JSON.stringify({ ...lock, processIdentity: 'linux:fixture-start' })],
        [`${nestedPeer}${lockSuffix}`, JSON.stringify({ ...lock, processIdentity: null })],
        [`${restoredPeer}${lockSuffix}`, JSON.stringify(lock)],
      ]);
      for (const [path, content] of acceptedLocks) writeFileSync(path, content);
      const lockInodes = [...acceptedLocks.keys()].map(path => lstatSync(path).ino);
      const rejectedContents = new Map([
        ['empty', ''], ['malformed', '{'], ['array', '[]'], ['null', 'null'],
        ['oversized', JSON.stringify(lock).padEnd(4097, ' ')],
        ...Object.entries({ 'string-pid': { pid: '123' }, 'zero-pid': { pid: 0 },
          'negative-pid': { pid: -1 }, 'fractional-pid': { pid: 1.5 },
          'unsafe-pid': { pid: Number.MAX_SAFE_INTEGER + 1 }, 'missing-token': { token: undefined },
          'invalid-token': { token: 'unproven' }, 'invalid-date': { startedAt: '2026-02-30T00:00:00.000Z' },
          'missing-date': { startedAt: undefined }, 'non-iso-date': { startedAt: '2026-11-09' },
          'numeric-identity': { processIdentity: 1 }, 'empty-identity': { processIdentity: '' },
          'oversized-identity': { processIdentity: 'x'.repeat(1025) },
          'control-identity': { processIdentity: 'linux:\n' }, 'extra-field': { unknown: true },
        }).map(([name, fields]) => [name, JSON.stringify({ ...lock, ...fields })] as [string, string]),
      ]);
      // Keep one visible unproven sibling in the inventory. The nested
      // unproven-app remains a single failing subtree in diagnostic mode.
      const rejectedLocks: string[] = [join(directory, 'registry', 'fixture', '.papercusp', 'harness', `unproven-store${lockSuffix}`)];
      writeFileSync(rejectedLocks[0], JSON.stringify(lock));
      writeFileSync(`${unprovenPeer}${lockSuffix}`, JSON.stringify(lock));
      for (const kind of [...rejectedContents.keys(), 'symlink', 'directory',
        ...(process.platform === 'linux' ? ['fifo'] : [])]) {
        const store = join(directory, 'registry', 'fixture', '.papercusp', `lock-case-${kind}`, 'hyperbee');
        mkdirSync(join(store, 'db'), { recursive: true });
        writeFileSync(join(store, 'CORESTORE'), 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n');
        const path = `${store}${lockSuffix}`;
        rejectedLocks.push(path);
        if (kind === 'symlink') symlinkSync(`${peer}${lockSuffix}`, path);
        else if (kind === 'directory') mkdirSync(path);
        else if (kind === 'fifo') expect(spawnSync('mkfifo', [path]).status).toBe(0);
        else writeFileSync(path, rejectedContents.get(kind)!);
      }
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
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout.trim(), result.stderr).not.toBe('');
      const report = JSON.parse(result.stdout);
      expect(report.wholeInstallVerified).toBe(false);
      expect(report.scope).toBe('implemented-writer-filesystem-roots-only');
      expect(report.representedPeers).toHaveLength(3 + rejectedLocks.length - 1);
      for (const path of acceptedLocks.keys()) {
        const name = path.slice(directory.length + 1).split('\\').join('/');
        expect(report.inventory.find((entry: { name: string }) => entry.name === name))
          .toMatchObject({ classification: 'cache', producers: ['corestore-single-instance-lock'] });
        expect(report.residue.some((entry: { name: string }) => entry.name === name)).toBe(false);
      }
      for (const path of rejectedLocks) {
        const name = path.slice(directory.length + 1).split('\\').join('/');
        expect(report.residue.some((entry: { name: string }) => entry.name === name), name).toBe(true);
      }
      expect(report.representedPeers.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/hyperbee')).toBe(true);
      expect(report.inventory.find((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness'))
        .toMatchObject({ classification: 'state', producers: ['harness-corestore-container'] });
      for (const name of ['registry/fixture', 'registry/fixture/.papercusp']) {
        expect(report.inventory.find((entry: { name: string }) => entry.name === name))
          .toMatchObject({ classification: 'state', producers: ['harness-corestore-container'] });
      }
      for (const name of ['registry/fixture/unowned-workspace-file', 'registry/fixture/.papercusp/unowned-root-file',
        'registry/uninitialized', 'registry/linked', 'registry/fixture/.restored']) {
        expect(report.residue.some((entry: { name: string }) => entry.name === name), name).toBe(true);
      }
      expect(report.inventory.some((entry: { name: string; classification: string | null }) =>
        entry.name.startsWith('registry/linked/') && entry.classification)).toBe(false);
      expect(readlinkSync(join(linkedWorkspace, '.papercusp'))).toBe(join(directory, 'registry', 'fixture', '.papercusp'));
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unowned-sibling')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/legacy')).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name.includes('/.restored/snapshot/clone/'))).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/retained-app/hyperbee')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/retained-app')).toBe(true);
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

  it.runIf(process.p
