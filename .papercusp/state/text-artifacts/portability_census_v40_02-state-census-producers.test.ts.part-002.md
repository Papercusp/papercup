---
rel_path: "portability/census/v40/02-state-census-producers.test.ts.part-002"
updated_at: 1794240912951
_body: "content"
---

ync () => source(writer, unrelated, output));
    const recovered = await recoverHistoricalCensusWriterEvidence([candidate], read);
    expect(read).toHaveBeenCalledExactlyOnceWith('native-session');
    expect(recovered).toMatchObject([{ indexedRef: candidate.ref, toolInput: archivedInput, receipt, startedAt: candidate.startedAt, finishedAt: candidate.finishedAt }]);
    expect(recovered[0].ref).toContain(':line:1:call:writer-call');
    expect(historicalPlaywrightStateConstruction(recovered[0].toolInput, '/fixture')).not.toBeNull();
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, unrelated))).toEqual([]);
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, output, output))).toEqual([]);
    expect(await recoverHistoricalCensusWriterEvidence([{ ...candidate, startedAt: '2026-09-06T00:00:00Z' }], read)).toEqual([]);
    await expect(recoverHistoricalCensusWriterEvidence([candidate], async () => ({ ...source(writer, output), sha256: '0'.repeat(64) }))).rejects.toThrow('SHA/size mismatch');
    await expect(recoverHistoricalCensusWriterEvidence([candidate], async () => { throw new Error('canonical native archive sha mismatch'); })).rejects.toThrow('sha mismatch');
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => { throw new Error('canonical codex archive not found'); })).toEqual([]);
    const native = { ...writer, payload: { type: 'function_call', name: 'exec', call_id: 'writer-call', arguments: JSON.stringify({ code: archivedInput }) } };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(native, output)))[0].toolInput).toBe(archivedInput);
    const nestedOutput = (envelope: object) => ({ ...output, payload: { ...output.payload,
      output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify(envelope) }] } });
    const envelope = { exit_code: 0, output: receipt + '\n', chunk_id: 'completed-command' };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(envelope))))[0].receipt).toBe(receipt);
    const sessionReceipt = { ok: true, statePath: '/fixture/.config/papercusp/arbitrary-browser.json',
      mode: '600', sessionHash: '33cd423ed43d' };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer,
      nestedOutput({ ...envelope, output: JSON.stringify(sessionReceipt) }))))[0].receipt).toBe(JSON.stringify(sessionReceipt));
    const stripeReceipt = { accountId: 'acct_fixture', accountName: 'Fixture', mode: 'test',
      plans: [{ planKey: 'cloud', priceId: 'price_fixture', productId: 'prod_fixture', label: 'Cloud', description: 'Fixture' }],
      portalConfigurationId: 'bpc_fixture', webhookEndpointId: 'we_fixture', webhookUrl: 'https://example.test/hook', workItem: 'WI-fixture' };
    const stripeEnvelope = { ...envelope, output: JSON.stringify(stripeReceipt) };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer,
      nestedOutput(stripeEnvelope))))[0].receipt).toBe(JSON.stringify(stripeReceipt));
    for (const invalid of [{ ...stripeEnvelope, exit_code: 1 }, { ...stripeEnvelope, session_id: 123 },
      { ...stripeEnvelope, output: JSON.stringify({ ...stripeReceipt, mode: 'live' }) },
      { ...stripeEnvelope, output: JSON.stringify({ ...stripeReceipt, plans: [{}] }) }]) {
      expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(invalid))))[0].receipt).toBe('');
    }
    for (const invalid of [{ ...envelope, exit_code: 1 }, { output: receipt, session_id: 123 },
      { ...envelope, session_id: 123 }, { ...envelope, output: 'not JSON' }, { ...envelope, output: 'null' },
      { value: envelope }]) {
      expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(invalid))))[0].receipt).toBe('');
    }
    const ambiguousOutput = { ...output, payload: { ...output.payload, output: [
      { type: 'input_text', text: receipt }, { type: 'input_text', text: JSON.stringify(envelope) }] } };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, ambiguousOutput)))[0].receipt).toBe('');
  });
  it('requires a matching successful receipt, private no-follow file and original write window without exposing values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'playwright-state-proof-'));
    const config = join(home, '.config', 'papercusp'); const output = join(config, 'arbitrary-browser.json');
    const state = { cookies: [{ name: 'session', value: 'sensitive-test-cookie', domain: 'app.papercusp.com', path: '/',
      expires: 1788638077, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
    const body = JSON.stringify(state);
    const receipt = { final: { host: 'app.papercusp.com', path: '/cloud-workspaces' },
      session: { status: 200, ok: true, error: null }, storageState: { path: output, mode: '600', bytes: Buffer.byteLength(body) } };
    const record = { ref: 'archive:sha:line463:call-id', toolInput: archivedInput.replaceAll('/fixture/.config/papercusp/arbitrary-browser.json', output),
      startedAt: '2026-09-05T19:49:31.511Z', finishedAt: '2026-09-05T19:49:41.364Z', receipt: JSON.stringify(receipt) };
    try {
      await mkdir(config, { recursive: true }); await writeFile(output, body, { mode: 0o600 });
      await utimes(output, new Date('2026-09-05T19:49:40Z'), new Date('2026-09-05T19:49:40Z'));
      const result = await historicalPlaywrightStateCensusProducer([record], home);
      expect(result.declarations).toEqual([{ kind: 'path', root: 'playwright-state-0', name: 'arbitrary-browser.json',
        classification: 'secret', producer: 'historical-playwright-storage-state:archive:sha:line463:call-id' }]);
      expect(JSON.stringify(result)).not.toContain('sensitive-test-cookie');
      expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: 'null' }], home)).declarations).toEqual([]);
      for (const altered of [
        { ...receipt, session: { status: 401, ok: false, error: 'unauthorized' } },
        { ...receipt, storageState: { ...receipt.storageState, bytes: body.length + 1 } },
        { ...receipt, storageState: { ...receipt.storageState, path: join(config, 'neighbor.json') } },
      ]) expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify(altered) }], home)).declarations).toEqual([]);
      await chmod(output, 0o644);
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await chmod(output, 0o600); await utimes(output, new Date(), new Date());
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await rm(output); await writeFile(join(config, 'neighbor.json'), body, { mode: 0o600 }); await symlink(join(config, 'neighbor.json'), output);
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await rm(output); await writeFile(output, 'invalid json', { mode: 0o600 }); await utimes(output, new Date(record.startedAt), new Date(record.startedAt));
      expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify({ ...receipt, storageState: { ...receipt.storageState, bytes: 12 } }) }], home)).declarations).toEqual([]);
      for (const invalid of [null, { cookies: [null], origins: [] }, { ...state, origins: [null] }, { ...state, cookies: [{ ...state.cookies[0], domain: 'elsewhere.test' }] }]) {
        const content = JSON.stringify(invalid); await writeFile(output, content);
        await utimes(output, new Date(record.startedAt), new Date(record.startedAt));
        expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify({ ...receipt, storageState: { ...receipt.storageState, bytes: Buffer.byteLength(content) } }) }], home)).declarations).toEqual([]);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe('reaper archive writer census', () => {
  it('looks up old archive identities in bounded exact batches and rejects unrelated returned ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-lookup-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      await mkdir(archive, { recursive: true });
      await Promise.all(Array.from({ length: 1001 }, (_, n) => writeFile(join(archive, `old-${n}.tail.log`), 'tail')));
      const lookup = vi.fn(async (ids: string[]) => ids.includes('old-0') ? ['old-0', 'unrequested'] : []);
      const result = await reapArchiveCensusProducer(home, [], lookup);
      expect(lookup.mock.calls.map(([ids]) => ids.length)).toEqual([1000, 1]);
      expect(new Set(lookup.mock.calls.flatMap(([ids]) => ids)).size).toBe(1001);
      const tails = result.declarations.filter(row => row.name.endsWith('.tail.log')).map(row => row.name);
      expect(tails).toEqual(['reap-archive/2026-10-11/old-0.tail.log']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('verifies writer receipts after ledger GC and exposes corrupt, mismatched and linked receipts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-receipt-'));
    try {
      const source = join(home, 'source.log');
      await writeFile(source, Buffer.alloc(REAP_TAIL_MAX_BYTES + 20, 'x'));
      const tail = await archiveReapTail('expired-task', source, home, new Date('2026-10-11T12:00:00Z'));
      expect((await readFile(tail)).length).toBe(REAP_TAIL_MAX_BYTES);
      const receiptPath = `${tail}.receipt.json`;
      const original = await readFile(receiptPath, 'utf8');
      const names = async () => (await reapArchiveCensusProducer(home, [])).declarations.map(row => row.name);
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log');
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log.receipt.json');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'y'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'x'));
      await writeFile(receiptPath, original.replace('expired-task', 'another-task'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(receiptPath, 'null');
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(source, original);
      await rm(receiptPath);
      await symlink(source, receiptPath);
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await expect(archiveReapTail('../escape', source, home)).rejects.toThrow('Invalid reaper task id');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('requires retained task identity, regular files and the writer size bound for tails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      await mkdir(archive, { recursive: true });
      await writeFile(join(archive, 'known.tail.log'), 'tail');
      await writeFile(join(archive, 'unknown.tail.log'), 'tail');
      await writeFile(join(archive, 'large.tail.log'), Buffer.alloc(128 * 1024 + 1));
      await symlink(join(archive, 'known.tail.log'), join(archive, 'linked.tail.log'));
      await mkdir(join(archive, 'directory.tail.log'));
      const result = await reapArchiveCensusProducer(home, ['known', 'large', 'linked', 'directory', '../unknown']);
      expect(result.declarations.map(row => row.name)).toEqual([
        'reap-archive', 'reap-archive/2026-10-11', 'reap-archive/2026-10-11/known.tail.log',
      ]);
      expect(result.declarations.every(row => !row.descendants)).toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('uses OS home and leaves links, invalid dates and unproven tails as residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive');
      await mkdir(join(archive, '2026-10-11'), { recursive: true });
      await mkdir(join(archive, '2026-02-30'));
      await mkdir(join(archive, 'unexpected'));
      await writeFile(join(archive, '2026-10-11', 'unknown.tail.log'), 'fixture');
      await symlink(join(archive, '2026-10-11'), join(archive, '2026-10-12'));
      const producer = await reapArchiveCensusProducer(home);
      expect(producer.roots[0].path).toBe(join(home, '.papercusp'));
      expect(producer.declarations.map(row => row.name)).toEqual(['reap-archive', 'reap-archive/2026-10-11']);
      expect(producer.declarations.every(row => !row.descendants)).toBe(true);
      const otherHome = join(home, 'other');
      await mkdir(join(otherHome, '.papercusp'), { recursive: true });
      await symlink(archive, join(otherHome, '.papercusp', 'reap-archive'));
      expect((await reapArchiveCensusProducer(otherHome)).declarations).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

afterEach(() => vi.clearAllMocks());
describe('secret census producer adapters', () => {
  it('discovers historical workspace stores without following linked workspace homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-template-census-'));
    try {
      const home = join(root, 'retired', '.papercusp');
      await mkdir(join(home, 'templates', 'app'), { recursive: true });
      await writeFile(join(home, 'templates', 'app', 'template.yaml'), 'manifest');
      await writeFile(join(home, 'templates', 'app', 'old.ts'), 'historical bytes');
      const source = join(root, 'source.ts');
      await writeFile(source, 'current bytes');
      await symlink(join(root, 'retired'), join(root, 'linked-workspace'));
      await mkdir(join(root, 'linked-home'));
      await symlink(home, join(root, 'linked-home', '.papercusp'));
      const resolver = vi.fn(async (path: string, bytes: Buffer) => path === source && bytes.equals(Buffer.from('historical bytes')));
      const result = await workspaceTemplateStoreCensusProducer(root, new Map([['app/old.ts', source]]), resolver);
      expect(result.roots).toEqual([{ id: 'workspace-template-store:retired', path: home }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/old.ts'].sort());
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(result.declarations.every(entry => entry.root === result.roots[0].id && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('proves historical bytes only at the same regular Git source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'historical-template-identity-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
      git('init', '-q');
      await writeFile(join(root, 'source.ts'), 'old source');
      await writeFile(join(root, 'other.ts'), 'other path only');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old');
      await writeFile(join(root, 'source.ts'), 'new source');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new');
      // Deletion and a same-content link at another path do not confer ownership.
      git('rm', '-q', 'source.ts');
      await symlink('other.ts', join
