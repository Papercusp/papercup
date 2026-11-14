---
rel_path: "portability/census/v41/02-state-census-producers.test.ts.part-003"
updated_at: 1794241756285
_body: "content"
---

 readFile(receiptPath, 'utf8');
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
      await symlink('other.ts', join(root, 'source.ts'));
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'link');
      const matches = historicalGitBlobIdentityResolver(root);
      expect(await matches(join(root, 'source.ts'), Buffer.from('old source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('new source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('other path only'))).toBe(false);
      expect(await matches(join(root, 'source.ts'), Buffer.from('other.ts'))).toBe(false);
      expect(await matches(join(root, 'source.ts'), Buffer.from('drift'))).toBe(false);
      expect(await matches(join(root, 'missing.ts'), Buffer.from('old source'))).toBe(false);
      expect(await matches(join(root, '..', 'outside.ts'), Buffer.from('old source'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes exact mirror source while exposing drift, unknown siblings and linked parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-identity-census-'));
    try {
      await mkdir(join(root, 'templates', 'app', 'src'), { recursive: true });
      await writeFile(join(root, 'templates', 'app', 'template.yaml'), 'manifest');
      const source = join(root, 'canonical.ts');
      await writeFile(source, 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'same.ts'), 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'drift.ts'), 'changed source');
      await writeFile(join(root, 'templates', 'app', 'src', 'unknown.ts'), 'canonical source');
      await symlink(source, join(root, 'templates', 'app', 'src', 'link.ts'));
      await symlink(join(root, 'templates', 'app', 'src'), join(root, 'templates', 'app', 'linked'));
      const expected = new Map(['src/same.ts', 'src/drift.ts', 'src/link.ts', 'linked/same.ts', 'src/missing.ts'].map(name => [`app/${name}`, source]));
      const result = await templateStoreCensusProducer(root, expected);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/src', 'templates/app/src/same.ts'].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains parsed plan templates while exposing incomplete bundles, links and extra files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-template-census-'));
    try {
      for (const name of ['valid', 'legacy', 'incomplete', 'linked']) await mkdir(join(root, 'plan-templates', name), { recursive: true });
      const valid = join(root, 'plan-templates', 'valid');
      await writeFile(join(valid, 'plan.md'), '---\nslug: fixture\ntitle: Fixture\nstatus: draft\n---\n\n# Fixture\n\n- **P-001** `todo` Build fixture\n');
      await writeFile(join(valid, 'listing.json'), '{}');
      await writeFile(join(valid, 'unknown.ts'), 'source');
      await writeFile(join(root, 'plan-templates', 'legacy', 'plan.md'), '# Legacy');
      await writeFile(join(root, 'plan-templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(valid, 'plan.md'), join(root, 'plan-templates', 'linked', 'plan.md'));
      await symlink(valid, join(root, 'plan-templates', 'linked-dir'));
      const result = await planTemplateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['plan-templates', 'plan-templates/valid', 'plan-templates/valid/plan.md', 'plan-templates/valid/listing.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes installed template metadata without claiming source, bytecode or incomplete bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-store-census-'));
    try {
      for (const name of ['valid', 'incomplete', 'linked-manifest']) await mkdir(join(root, 'templates', name), { recursive: true });
      for (const name of ['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md', 'source.ts', 'module.pyc']) await writeFile(join(root, 'templates', 'valid', name), 'opaque');
      await writeFile(join(root, 'templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(root, 'templates', 'valid', 'template.yaml'), join(root, 'templates', 'linked-manifest', 'template.yaml'));
      await symlink(join(root, 'templates', 'valid'), join(root, 'templates', 'linked-bundle'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/valid', ...['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md'].map(name => `templates/valid/${name}`)].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const writer = await readFile(new URL('../cupboard/install-template-core.ts', import.meta.url), 'utf8');
      expect(writer).toContain("existsSync(join(srcDir, 'template.yaml'))");
      const store = await readFile(new URL('../cupboard/template-store.ts', import.meta.url), 'utf8');
      expect(store).toContain("papercuspPath('templates')");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes historical versioned metadata only with matching identity and regular paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-template-census-'));
    try {
      const valid = join(root, 'templates', 'legacy', '0.1.0');
      await mkdir(join(valid, '.harness'), { recursive: true });
      await writeFile(join(valid, 'papercusp.json'), JSON.stringify({ name: 'legacy', version: '0.1.0', kind: 'template' }));
      for (const file of ['SPEC.md', 'README.md', '.published.json', 'unexpected.ts', '.harness/config.json', '.harness/unexpected.ts']) await writeFile(join(valid, file), 'fixture');
      await symlink(join(valid, 'SPEC.md'), join(valid, 'AGENTS.md'));
      await symlink(join(valid, 'SPEC.md'), join(valid, '.harness/validation-contract.md'));
      for (const version of ['0.2.0', 'invalid']) {
        await mkdir(join(root, 'templates', 'legacy', version), { recursive: true });
        await writeFile(join(root, 'templates', 'legacy', version, 'papercusp.json'), JSON.stringify({ name: 'wrong', version, kind: 'template' }));
      }
      await symlink(valid, join(root, 'templates', 'legacy', '0.3.0'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/legacy', 'templates/legacy/0.1.0', ...['papercusp.json', 'SPEC.md', 'README.md', '.published.json', '.harness', '.harness/config.json'].map(file => `templates/legacy/0.1.0/${file}`)].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves completed setup credentials without claiming copied source or unknown homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-census-'));
    try {
      const parent = join(root, 'deploy-credentials');
      const names = ['.codex-setup-acme-1234abcd', '.setup-acme-1234abcd', '.codex-setup-acme-invalid'];
      for (const name of names) await mkdir(join(parent, name), { recursive: true });
      await writeFile(join(parent, names[0], 'auth.json'), 'opaque credential');
      await writeFile(join(parent, names[0], 'source.ts'
