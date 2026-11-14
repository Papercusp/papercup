---
rel_path: "portability/census/v41/02-state-census-producers.test.ts.part-009"
updated_at: 1794241756285
_body: "content"
---

nst home = join(parent, 'deploy-credentials', name);
    const databases = ['state_5.sqlite', 'logs_2.sqlite', 'goals_1.sqlite', 'memories_1.sqlite',
      'memories_v2_1.sqlite', 'queue_1.sqlite', 'thread_history_1.sqlite'];
    const relativeNames = ['auth.json', 'auth.json.123.tmp', 'installation_id', ...databases.flatMap(file => [file, `${file}-wal`, `${file}-shm`])];
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'auth.json'), 'credential bytes must not be parsed');
      await writeFile(join(home, 'auth.json.123.tmp'), 'refresh credential');
      await writeFile(join(home, 'installation_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      for (const file of databases) {
        await writeFile(join(home, file), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
        for (const suffix of ['-wal', '-shm']) await writeFile(join(home, `${file}${suffix}`), `live ${suffix} bytes`);
      }
      const before = await Promise.all(relativeNames.map(file => readFile(join(home, file))));
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` }]);
      expect(result.roots).toEqual([{ id: 'account-credential-0', path: dirname(home) }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual([name, ...relativeNames.map(file => `${name}/${file}`)].sort());
      expect(result.declarations.filter(entry => entry.producer === 'codex-sqlite-runtime')).toHaveLength(21);
      expect(result.declarations.find(entry => entry.name === `${name}/installation_id`)?.classification).toBe('config');
      expect(result.declarations.filter(entry => entry.classification === 'secret')).toHaveLength(2);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue).toEqual([]);
      expect(await Promise.all(relativeNames.map(file => readFile(join(home, file))))).toEqual(before);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('leaves unknown accounts, malformed databases, orphan companions, backups and links unresolved', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-account-negative-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'auth.json'), 'opaque');
      for (const file of ['state_5.sqlite', 'state_5.sqlite-wal', 'goals_1.sqlite-shm', 'state_6.sqlite',
        'state_5.sqlite.backup', 'installation_id', 'foreign.ts']) await writeFile(join(home, file), 'foreign bytes');
      await writeFile(join(parent, 'external.sqlite'), 'SQLite format 3\0');
      await symlink(join(parent, 'external.sqlite'), join(home, 'logs_2.sqlite'));
      await writeFile(join(home, 'logs_2.sqlite-wal'), 'orphan');
      await mkdir(join(home, 'memories_1.sqlite'));
      await mkdir(join(parent, 'deploy-credentials', 'unknown.codex-cli'));
      await writeFile(join(parent, 'deploy-credentials', 'unknown.codex-cli', 'state_5.sqlite'), 'SQLite format 3\0');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]);
      expect(result.declarations.map(entry => entry.name)).toEqual(['known.codex-cli', 'known.codex-cli/auth.json']);
      const direct = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(direct.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'known.codex-cli/foreign.ts', 'unknown.codex-cli', 'unknown.codex-cli/state_5.sqlite',
      ]));
      const merged = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'all', path: parent }], declarations: result.declarations });
      const census = await collectStateCensus({ ...merged, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'deploy-credentials/known.codex-cli/state_5.sqlite', 'deploy-credentials/known.codex-cli/state_5.sqlite-wal',
        'deploy-credentials/known.codex-cli/goals_1.sqlite-shm', 'deploy-credentials/known.codex-cli/logs_2.sqlite',
        'deploy-credentials/unknown.codex-cli/state_5.sqlite',
      ]));
      await rm(join(home, 'installation_id'));
      await symlink(join(parent, 'external.sqlite'), join(home, 'installation_id'));
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }])).declarations)
        .toEqual(result.declarations);
      await rename(home, `${home}.retained`);
      await symlink(`${home}.retained`, home);
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }])).declarations
        .some(entry => entry.producer === 'codex-sqlite-runtime' || entry.producer === 'account-link-cli-completed-home')).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('does not treat an arbitrary referenced CLI home as a managed account container', async () => {
    const home = await mkdtemp(join(tmpdir(), 'external-codex-account-'));
    try {
      await writeFile(join(home, 'auth.json'), 'opaque');
      await writeFile(join(home, 'state_5.sqlite'), 'SQLite format 3\0');
      await writeFile(join(home, 'installation_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]);
      expect(result.roots[0].fileNames).toEqual(['auth.json']);
      expect(result.declarations.map(entry => entry.name)).toEqual(['auth.json']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('unions external references without allowing a selected parent to hide an installed child', () => {
    const result = mergeNestedCensusRoots({ roots: [
      { id: 'a', path: '/external', fileNames: ['auth.json'] },
      { id: 'b', path: '/external', fileNames: ['token'] },
      { id: 'child', path: '/external/installed' },
    ], declarations: [] });
    expect(result.roots).toEqual([
      { id: 'a', path: '/external', fileNames: ['auth.json', 'token'] },
      { id: 'child', path: '/external/installed' },
    ]);
  });
  it('recognizes exact affected-test cache writers without claiming unrelated files or symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-cache-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      await mkdir(directory, { recursive: true });
      const ordinary = 'papercusp-affected-passing-verdicts-v2-0123456789abcdef.json';
      const committed = 'papercusp-affected-passing-verdicts-v2-committed-fedcba9876543210.json';
      await writeFile(join(directory, ordinary), '{}');
      await writeFile(join(directory, committed), '{}');
      for (const name of [ordinary, committed]) await writeFile(closureDigestManifestPath(join(directory, name)), '{}');
      const orphanSidecar = closureDigestManifestPath('papercusp-affected-passing-verdicts-v2-1111111111111111.json');
      await writeFile(join(directory, orphanSidecar), '{}');
      await writeFile(join(directory, 'unknown.json'), '{}');
      await writeFile(closureDigestManifestPath(join(directory, 'unknown.json')), '{}');
      await symlink(join(directory, 'unknown.json'), join(directory, 'papercusp-affected-passing-verdicts-v2-aaaaaaaaaaaaaaaa.json'));
      await symlink(join(directory, 'unknown.json'), closureDigestManifestPath(join(directory, 'papercusp-affected-passing-verdicts-v2-bbbbbbbbbbbbbbbb.json')));
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(home, 'history', 'custom.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', join(home, 'verdict', 'custom.json'));
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', '');
      await mkdir(join(home, 'history'));
      await writeFile(join(home, 'history', 'custom.json'), '{}');
      await mkdir(join(home, 'verdict'));
      await writeFile(join(home, 'verdict', 'custom.json'), '{}');
      await writeFile(closureDigestManifestPath(join(home, 'verdict', 'custom.json')), '{}');
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['custom.json', 'custom.json',
        closureDigestManifestPath('custom.json'), ordinary, committed,
        closureDigestManifestPath(ordinary), closureDigestManifestPath(committed), orphanSidecar].sort());
      expect(result.declarations.every(entry => entry.classification === 'cache' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.declarations.filter(entry => entry.producer === 'affected-tests-closure-manifest')).toHaveLength(4);
      expect(result.roots.map(root => root.path)).toContain(join(home, 'history'));
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === 'custom.json.closure-manifest.json')?.classification).toBe('cache');
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining(['unknown.json', 'unknown.json.closure-manifest.json']));
      const writer = await readFile(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      expect(writer).toContain('papercusp-affected-task-durations-v1.json');
      expect(writer).toContain('papercusp-affected-passing-verdicts-v2-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json');
      const committedWriter = await readFile(new URL('../../../../scripts/lint-as-committed.mjs', import.meta.url), 'utf8');
      expect(committedWriter).toContain('papercusp-affected-passing-verdicts-v2-committed-${scope}.json');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it.each([false, true])('censuses exact partial checkpoints with relocated=%s and preserves unrelated files', async (relocated) => {
    const home = await mkdtemp(join(tmpdir(), 'affected-partial-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      const partialDirectory = relocated ? join(home, 'partial') : directory;
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', relocated ? partialDirectory : '');
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(directory, 'papercusp-affected-task-durations-v1.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', '');
      await mkdir(directory, { recursive: true });
      await mkdir(partialDirectory, { recursive: true });
      const checkpoint = partialTaskCheckpointPath(partialDirectory, '/repo', 'operator-core :: test');
      const unrelated = ['unknown.json', 'papercusp-affected-partial-v999-0123456789abcdef01234567.json',
        'papercusp-affected-partial-v1-not-a-scope.json'];
      await writeFile(checkpoint, '{}');
      for (const name of unrelated) await writeFile(join(partialDirectory, name), '{}');
      const linked = partialTaskCheckpointPath(partialDirectory, '/repo', 'linked');
      await symlink(checkpoint, linked);
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.filter(entry => entry.producer === 'affected-tests-partial-checkpoint'))
        .toEqual([{ kind: 'path', root: expect.any(String), name: checkpoint.split('/').at(-1),
          classification: 'cache', producer: 'affected-tests-partial-checkpoint' }]);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === checkpoint.split('/').at(-1))?.classification).toBe('cache');
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([...unrelated, linked.split('/').at(-1)]));
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('leaves explicit cache symlinks and symlinked partial directories unclassified', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-linked-cache-census-'));
    try {
      const target = join(home, 'target.json');
      const verdict = join(home, 'verdict.json');
      await writeFile(target, '{}');
      await symlink(target, verdict);
      await symlink(target, closureDigestManifestPath(verdict));
      const partialDirectory = join(home, 'partial-target');
      await mkdir(partialDirectory);
      await writeFile(partialTaskCheckpointPath(partialDirectory, '/repo', 'test'), '{}');
      const linkedDirectory = join(home, 'linked-partial');
      await symlink(partialDirectory, linkedDirectory);
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', target);
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', verdict);
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', linkedDirectory);
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.producer)).toEqual(['affected-tests-duration-history']);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('preserves real test-run packets in known homes and the pinned evidence root without claiming siblings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'testing-evidence-census-'));
    const ordinary = join(home, '.papercusp');
    const registered = join(home, 'registered');
    const unregistered = join(home, 'unregistered');
    const environment = { PAPERCUSP_HOME: ordinary, VH_EVIDENCE_ROOT_BASE: join(home, 'offload') };
    try {
      const bases = [ordinary, registered, unregistered].map(directory =>
        defaultTestRunArtifactBase({ PAPERCUSP_HOME: directory }, home));
      bases.push(defaultTestRunArtifactBase(environment, home));
      const packets = bases.map((base, index) => new TestRunArti
