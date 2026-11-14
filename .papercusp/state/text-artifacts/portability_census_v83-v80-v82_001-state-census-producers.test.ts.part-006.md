---
rel_path: "portability/census/v83-v80-v82/001-state-census-producers.test.ts.part-006"
updated_at: 1794268279628
_body: "content"
---

Producer(home, environment, [], [registered, registered]);
      const evidence = result.declarations.filter(entry => entry.producer === 'testing-run-retained-evidence');
      expect(evidence.filter(entry => entry.retainedSubtree)).toHaveLength(3);
      expect(evidence.every(entry => entry.classification === 'state' && !entry.prune)).toBe(true);
      expect(result.roots.some(root => root.path.startsWith(unregistered))).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.representedSubtrees).toHaveLength(3);
      expect(census.residue.map(entry => entry.name).sort()).toEqual([
        'test-artifacts-copy', 'test-artifacts-copy/manifest.json', 'test-artifacts/foreign.txt',
      ]);
      expect(await Promise.all(packets.map(packet => readFile(join(packet.paths.directory, 'proof.json'), 'utf8')))).toEqual(before);
      expect(census.ok).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('does not infer test evidence ownership through linked roots or absent directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'linked-testing-evidence-census-'));
    const ordinary = join(home, '.papercusp');
    const target = join(home, 'target');
    const owned = async () => (await runtimeSidefileCensusProducer(home, {})).declarations
      .filter(entry => entry.producer === 'testing-run-retained-evidence');
    try {
      await mkdir(ordinary);
      expect(await owned()).toEqual([]);
      await mkdir(join(target, 'testing-run'), { recursive: true });
      await symlink(target, join(ordinary, 'test-artifacts'));
      expect(await owned()).toEqual([]);
      await rm(join(ordinary, 'test-artifacts'));
      await mkdir(join(ordinary, 'test-artifacts'));
      await symlink(join(target, 'testing-run'), join(ordinary, 'test-artifacts', 'testing-run'));
      expect(await owned()).toEqual([]);
      await rm(join(ordinary, 'test-artifacts'), { recursive: true });
      await mkdir(join(ordinary, 'test-artifacts', 'testing-run'), { recursive: true });
      await rename(ordinary, `${ordinary}-retained`);
      await symlink(`${ordinary}-retained`, ordinary);
      expect(await owned()).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  describe('source preview original census evidence', () => {
    const fixture = async (runtimeHome: string) => {
      const { archiveVerifierTaskEvidence } = await import('../../../../scripts/source-preview.mjs');
      const container = join(runtimeHome, 'test-artifacts');
      await mkdir(container, { recursive: true });
      const owned = await mkdtemp(join(dirname(runtimeHome), 'verifier-command-'));
      const receiptPath = join(container, 'arbitrary-name.json');
      const taskReceiptPath = `${receiptPath}.task.json`;
      const taskId = 'fixture-verifier-task';
      const receipt = writeVerifierTaskReceipt(owned, dirname(runtimeHome),
        { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId }, taskReceiptPath);
      const runId = createHash('sha256').update(receiptPath).digest('hex');
      const evidenceRoot = join(runtimeHome, 'checkpoint-logs', `verifier-task-${taskId}`, runId);
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      const manifestPath = join(evidenceRoot, 'manifest.json');
      await writeFile(taskReceiptPath, JSON.stringify({ ...receipt, cleanup: 'completed', evidenceManifestPath: manifestPath }) + '\n');
      const suffixes = ['', '.snapshot.txt', '.dependencies.json', '.dependencies.after.json', '.child.json', '.stdout.log', '.stderr.log', '.resources.jsonl', '.phases.jsonl'];
      for (const suffix of suffixes) await writeFile(`${receiptPath}${suffix}`, `writer output ${suffix}\n`, { mode: 0o600 });
      archiveVerifierTaskEvidence({ evidenceRoot, taskId, sourceCommit: 'a'.repeat(40), receiptPath,
        taskReceiptPath, phaseArchivePath: `${receiptPath}.phases.jsonl`, cleanup: 'completed', childExitCode: 0 });
      return { container, receiptPath, taskReceiptPath, evidenceRoot, manifestPath, suffixes };
    };
    const originals = async (home: string, runtimeHomes: string[] = []) => {
      const result = await runtimeSidefileCensusProducer(home, {}, [], runtimeHomes);
      return { ...result, declarations: result.declarations.filter(entry => entry.producer === 'source-preview-verifier-original') };
    };
    it('uses actual retained writer bytes in ordinary and registered homes, leaving unknown siblings unresolved', async () => {
      const home = await mkdtemp(join(tmpdir(), 'verifier-census-'));
      try {
        const first = await fixture(join(home, '.papercusp'));
        await fixture(join(home, 'registered'));
        await fixture(join(home, 'unregistered'));
        const unknown = join(first.container, 'request.json');
        await writeFile(unknown, 'unproven input');
        const before = await readFile(first.taskReceiptPath);
        const result = await originals(home, [join(home, 'registered')]);
        expect(result.declarations.filter(entry => entry.name.endsWith('.task.json'))).toHaveLength(2);
        expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
        expect(result.roots.some(root => root.path === join(home, 'unregistered'))).toBe(false);
        for (const suffix of first.suffixes) expect(result.declarations.some(entry => entry.name === `test-artifacts/arbitrary-name.json${suffix}`)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        expect(census.residue.some(entry => entry.name === 'test-artifacts/request.json')).toBe(true);
        expect(census.ok).toBe(false);
        expect(await readFile(first.taskReceiptPath)).toEqual(before);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['missing-manifest', 'partial-bundle', 'retained-bytes', 'retained-task', 'manifest-task', 'manifest-run',
      'manifest-path', 'artifact-path', 'unknown-role', 'pending-task', 'linked-manifest', 'linked-retained', 'linked-root', 'linked-container'])
      ('rejects %s custody without adopting any originals', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-verifier-census-'));
        try {
          const f = await fixture(join(home, '.papercusp'));
          const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
          if (corruption === 'missing-manifest') await rm(f.manifestPath);
          if (corruption === 'partial-bundle') await rm(join(f.evidenceRoot, 'phases.jsonl'));
          if (corruption === 'retained-bytes') await writeFile(join(f.evidenceRoot, 'stdout.log'), 'corrupt');
          if (corruption === 'retained-task') {
            const bytes = Buffer.from((await readFile(f.taskReceiptPath, 'utf8')).replace('completed', 'deferred'));
            await writeFile(join(f.evidenceRoot, 'task.json'), bytes);
            manifest.artifacts['task.json'].sha256 = createHash('sha256').update(bytes).digest('hex');
            manifest.artifacts['task.json'].sizeBytes = bytes.length;
          }
          if (corruption === 'manifest-task') manifest.taskId = 'foreign-task';
          if (corruption === 'manifest-run') manifest.runId = 'f'.repeat(64);
          if (corruption === 'artifact-path') manifest.artifacts['source.json'].path = f.receiptPath;
          if (corruption === 'unknown-role') manifest.artifacts['request.json'] = manifest.artifacts['source.json'];
          if (['retained-task', 'manifest-task', 'manifest-run', 'artifact-path', 'unknown-role'].includes(corruption))
            await writeFile(f.manifestPath, JSON.stringify(manifest));
          if (corruption === 'manifest-path' || corruption === 'pending-task') {
            const receipt = JSON.parse(await readFile(f.taskReceiptPath, 'utf8'));
            if (corruption === 'manifest-path') receipt.evidenceManifestPath = join(home, 'manifest.json');
            else receipt.cleanup = 'pending';
            await writeFile(f.taskReceiptPath, JSON.stringify(receipt));
          }
          const link = async (path: string) => { await rename(path, `${path}-target`); await symlink(`${path}-target`, path); };
          if (corruption === 'linked-manifest') await link(f.manifestPath);
          if (corruption === 'linked-retained') await link(join(f.evidenceRoot, 'source.json'));
          if (corruption === 'linked-root') await link(f.evidenceRoot);
          if (corruption === 'linked-container') await link(f.container);
          expect((await originals(home)).declarations).toEqual([]);
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it.each(['changed', 'linked', 'missing'])('leaves %s originals unknown while retaining independently proven siblings', async corruption => {
      const home = await mkdtemp(join(tmpdir(), 'changed-verifier-census-'));
      try {
        const f = await fixture(join(home, '.papercusp'));
        const path = `${f.receiptPath}.stdout.log`;
        if (corruption === 'changed') await writeFile(path, 'changed stream');
        if (corruption === 'missing') await rm(path);
        if (corruption === 'linked') { await rename(path, `${path}-target`); await symlink(`${path}-target`, path); }
        const result = await originals(home);
        expect(result.declarations.some(entry => entry.name.endsWith('.stdout.log'))).toBe(false);
        expect(result.declarations.some(entry => entry.name.endsWith('.stderr.log'))).toBe(true);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  });
  describe('native router retained census evidence', () => {
    const fixture = async (runtimeHome: string, partial = false, sourceFamily = false, large = false) => {
      const container = join(runtimeHome, 'test-artifacts', 'arbitrary-run-name');
      await mkdir(container, { recursive: true, mode: 0o700 });
      const packet = await mkdtemp(join(container, 'native-router-'));
      const out = sourceFamily ? join(container, 'arbitrary-report.json') : null;
      const sourceFiles: string[] = [];
      if (out) {
        await writeFile(out, JSON.stringify({ rows: [], padding: large ? 'x'.repeat(17 * 1024 * 1024) : '' }), { mode: 0o600 });
        sourceFiles.push(out);
        for (const suffix of ['.modules', '.native-processes', '.processes']) {
          const directory = `${out}${suffix}`;
          await mkdir(directory, { mode: 0o700 });
          const path = join(directory, 'writer-output');
          await writeFile(path, `retained ${suffix}`, { mode: 0o600 });
          sourceFiles.push(path);
        }
      }
      const identity = { workspace: 'fixture-workspace', harness: 'fixture', runId: 'fixture-run' };
      const auxiliary = ['stdout', 'stderr', 'command-exit.json'].map(role => ({
        role, state: 'produced' as const, path: join(packet, `group-0.${role}`),
      }));
      for (const entry of auxiliary) await writeFile(entry.path, entry.role === 'command-exit.json'
        ? JSON.stringify({ writer: 'router-owned-child-close', status: 0 }) : `retained ${entry.role}`, { mode: 0o600 });
      const expected: NativeCustodyGroup[] = [{ id: 'group-0', attempt: 'primary', selected: ['/fixture/test.ts'], runner: 'vitest',
        armed: sourceFamily, out, cwd: '/fixture', auxiliary: partial
          ? [...auxiliary, { role: 'report', state: 'unavailable', reason: 'fixture-missing-report' }] : auxiliary }];
      const contract = { identity, expected };
      await writeFile(join(packet, 'expected.json'), JSON.stringify(contract), { mode: 0o600 });
      const saved = retainNativeProofPacket(packet, { ...contract,
        observations: [{ id: 'group-0', out, captureComplete: true }], execution: 'router-settled' });
      await writeFile(join(packet, 'locator.json'), JSON.stringify(saved.locator), { mode: 0o600 });
      return { packet, container, saved, out, sourceFiles };
    };
    it.each(['valid', 'retained', 'untrusted-ref', 'changed', 'linked-file', 'linked-directory', 'foreign', 'forged-writer', 'failed-writer', 'changed-receipt', 'corrupt-packet'])(
      'derives only exact bounded verifier outputs from complete historical custody: %s', async condition => {
        const home = await mkdtemp(join(tmpdir(), 'bounded-verifier-census-'));
        try {
          const runtimeHome = join(home, '.papercusp');
          const f = await fixture(runtimeHome);
          const names = ['bg-memory-trace.log', 'bg-memory-sources.json', 'bg-memory-jit.dump',
            'bg-memory-observation.json', 'bg-memory-build.json', 'bg-memory-proof.json'];
          const rawArtifacts: Record<string, { sha256: string; byteLength: number }> = {};
          for (const name of names) {
            const bytes = Buffer.from(`original ${name}`);
            await writeFile(join(f.container, name), bytes);
            rawArtifacts[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
          }
          const unknown = join(f.container, 'unproven-output.json'); await writeFile(unknown, 'unknown sibling');
          const path = join(f.container, 'bounded-proof-receipt.json');
          const sourceSha256 = 'a'.repeat(64); const createdAt = new Date().toISOString();
          const cleanup = { fixtureRootAbsent: true, processes: {} };
          const receipt = { createdAt, workItem: 'WI-6554700010044858', testRunId: 23654091,
            sourcePath: 'packages/operator-core/lib/source-preview-export.test.ts', sourceSha256, terminalExitCode: 0,
            nativeManifest: { path: join(f.packet, 'objects', f.saved.locator.manifest.ref),
              sha256: f.saved.locator.manifest.sha256, byteLength: f.saved.locator.manifest.byteLength }, rawArtifacts, cleanup };
          await writeFile(path, JSON.stringify(receipt));
          const writer = await readFile(new URL('./fixtures/bounded-proof-writer.txt', import.meta.url), 'utf8');
          let toolInput = writer.replace('579a09b1f4b64092cb2d1217cc853483ec8addbf9beb66ce2b4f4d958882bfb8.native-proof.json',
            `${receipt.nativeManifest.sha256}.native-proof.json`).replace('len(b)==1533779', `len(b)==${receipt.nativeManifest.byteLength}`);
          if (condition === 'forged-writer') toolInput = toolInput.replace('raw_names=', 'other_names=');
          const startedAt = new Date(Date.parse(createdAt) - 1000).toISOString();
          const finishedAt = new Date(Date.parse(createdAt) + 1000).toISOString();
          const terminal = { exit_code: condition === 'failed-writer' ? 1 : 0,
            output: JSON.stringify({ receipt: path, cleanup, testRunId: 23654091, sourceSha256 }) };
          const archive = Buffer.from([
            { type: 'response_item', timestamp: startedAt, payload: { type: 'custom_tool_call', name: 'exec', call_id: 'writer', input: toolInput } },
            { type: 'response_item', timestamp: finishedAt, payload: { type: 'custom_tool_call_output', call_id: 'unrelated', output: '{}' } },
            { type: 'response_item', timestamp: finishedAt, payload: { type: 'custom_tool_call_output', call_id: 'writer', output: JSON.stringify(terminal) } },
          ].map(row => JSON.stringify(row)).join('\n'));
          const records = await recoverHistoricalCensusWriterEvidence([{ ref: 'indexed:bounded', sessionId: 'bounded-fixture',
            toolInput: toolInput.slice(0, 1000), startedAt, finishedAt }], async () => ({ bytes: archive,
            sha256: createHash('sha256').update(archive).digest('hex'),
            source: condition === 'retained' ? 'live-jsonl' : 'archive-manifest' }));
          if (condition === 'retained') expect(records[0].ref).toMatch(/^retained:codex:/);
          if (condition === 'untrusted-ref') records[0].ref = 'indexed:bounded';
          const target = join(f.container, names[0]);
          if (condition === 'changed') await writeFile(target, 'changed bytes');
          if (condition === 'linked-file') { await rename(target, `${target}-target`); await symlink(`${target}-target`, target); }
          if (condition === 'linked-directory') { await rename(f.container, `${f.container}-target`); await symlink(`${f.container}-target`, f.container); }
          if (condition === 'changed-receipt') await writeFile(path, JSON.stringify({ ...receipt, sourceSha256: 'b'.repeat(64) }));
          if (condition === 'corrupt-packet') await writeFile(receipt.nativeManifest.path, 'corrupt retained packet');
          const result = await historicalVerifierArtifactCensusProducer(records, condition === 'foreign' ? [join(home, 'foreign')] : [runtimeHome]);
          const declared = (file: string) => result.declarations.some(entry => entry.name === relative(runtimeHome, file));
          if (['valid', 'retained', 'changed', 'linked-file'].includes(condition)) {
            expect(declared(path)).toBe(true);
            expect(declared(target)).toBe(['valid', 'retained'].includes(condition));
            expect(declared(join(f.container, names[1]))).toBe(true);
            expect(declared(unknown)).toBe(false);
            const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
            expect(census.residue.some(entry => entry.name === relative(runtimeHome, unknown))).toBe(true);
            expect(result.declarations.every(entry => !entry.descendants && !entry.prune && entry.classification === 'state')).toBe(true);
          } else expect(result).toEqual({ roots: [], declarations: [] });
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    const native = async (home: string, runtimeHomes: string[] = []) => {
      const result = await runtimeSidefileCensusProducer(home, {}, [], runtimeHomes);
      return { ...result, declarations: result.declarations.filter(entry => entry.producer === 'test-file-native-router-custody') };
    };
    it.each([false, true])('classifies exact captured source families including chunked OUT=%s, preserving unknown siblings', async large => {
      const home = await mkdtemp(join(tmpdir(), 'source-family-census-'));
      try {
        const runtimeHome = join(home, '.papercusp');
        const f = await fixture(runtimeHome, false, true, large);
        const unknown = join(`${f.out}.modules`, 'not-captured');
        await writeFile(unknown, 'not owned');
        const result = await native(home);
        for (const path of f.sourceFiles) expect(result.declarations.some(entry => entry.name === relative(runtimeHome, path))).toBe(true);
        expect(result.declarations.some(entry => entry.name === relative(runtimeHome, unknown))).toBe(false);
        expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        expect(census.residue.some(entry => entry.name === relative(runtimeHome, unknown))).toBe(true);
        expect(f.saved.manifest.verdicts.acceptance).toBe('unmeasured');
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['changed', 'linked-file', 'linked-directory', 'missing', 'foreign-container', 'foreign-out'])(
      'leaves %s source originals unresolved while retaining independent custody', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-source-family-census-'));
        try {
          const runtimeHome = join(home, '.papercusp');
          const f = await fixture(runtimeHome, false, true);
          const path = f.sourceFiles[1];
          if (corruption === 'changed') await writeFile(path, 'changed');
          if (corruption === 'missing') await rm(path);
          if (corruption === 'linked-file' || corruption === 'linked-directory') {
            const target = corruption === 'linked-file' ? path : dirname(path);
            await rename(target, `${target}-target`); await symlink(`${target}-target`, target);
          }
          if (corruption.startsWith('foreign')) {
            const foreign = corruption === 'foreign-out' ? join(runtimeHome, 'foreign-owned-file')
              : join(runtimeHome, 'test-artifacts', 'unrelated-container', 'report.json');
            await mkdir(dirname(foreign), { recursive: true });
            await writeFile(foreign, await readFile(f.out!));
            // The real writer can retain foreign inputs. Byte custody does
            // not adopt an original outside this packet's local output roots.
            const contract = JSON.parse(await readFile(join(f.packet, 'expected.json'), 'utf8'));
            contract.expected[0].out = foreign;
            const saved = retainNativeProofPacket(f.packet, { ...contract,
              observations: [{ id: 'group-0', out: contract.expected[0].out, captureComplete: true }], execution: 'router-settled' });
            await writeFile(join(f.packet, 'expected.json'), JSON.stringify(contract), { mode: 0o600 });
            await writeFile(join(f.packet, 'locator.json'), JSON.stringify(saved.locator), { mode: 0o600 });
            expect((await native(home)).declarations.some(entry => entry.name === relative(runtimeHome, foreign))).toBe(false);
          }
          const result = await native(home);
          expect(result.declarations.some(entry => entry.name === relative(runtimeHome, path))).toBe(false);
          expect(result.declarations.some(entry => entry.name.endsWith('/locator.json'))).toBe(true);
          if (!corruption.startsWith('foreign')) {
            expect(result.declarations.some(entry => entry.name === relative(runtimeHome, f.sourceFiles[2]))).toBe(true);
          }
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it('uses verified custody in ordinary and registered homes while preserving unknown neighbors', async () => {
      const home = await mkdtemp(join(tmpdir(), 'native-census-'));
      try {
        const runtimeHome = join(home, '.papercusp');
        const registered = join(home, 'registered');
        const first = await fixture(runtimeHome);
        await fixture(registered);
        const unregistered = join(home, 'unregistered');
        await fixture(unregistered);
        const unknown = [join(first.container, 'owner.txt'), join(first.packet, 'owner.txt'),
          join(first.packet, 'objects', 'unreferenced.json')];
        for (const path of unknown) await writeFile(path, 'unknown retained input', { mode: 0o600 });
        const before = await readFile(join(first.packet, 'expected.json'));
        const result = await native(home, [registered]);
        expect(result.roots.some(root => root.path === unregistered)).toBe(false);
        expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        for (const path of unknown) expect(census.residue.some(entry => path.endsWith(entry.name))).toBe(true);
        expect(census.inventory.filter(entry => entry.name.endsWith('/locator.json')).every(entry => entry.classification === 'state')).toBe(true);
        expect(census.inventory.filter(entry => entry.name.endsWith('/locator.json'))).toHaveLength(2);
        expect(await readFile(join(first.packet, 'expected.json'))).toEqual(before);
        expect(census.ok).toBe(false);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['object', 'expected', 'locator', 'linked-packet', 'linked-metadata', 'public-metadata', 'missing-locator'])(
      'leaves %s evidence unresolved', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-native-census-'));
        try {
          const { packet, saved } = await fixture(join(home, '.papercusp'));
          if (corruption === 'object') await writeF
