---
rel_path: "portability/census/v83-v80-v82/001-state-census-producers.test.ts.part-002"
updated_at: 1794268279628
_body: "content"
---

xture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old');
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
      await writeFile(join(parent, names[0], 'source.ts'), 'source');
      await mkdir(join(parent, names[0], 'log'));
      await writeFile(join(parent, names[0], 'log', 'codex-login.log'), 'login diagnostic');
      await writeFile(join(parent, names[0], 'log', 'foreign.log'), 'foreign');
      await symlink(join(parent, names[0]), join(parent, '.codex-setup-link-1234abcd'));
      const result = await cliSetupHomeCensusProducer(root);
      expect(result.declarations.map(entry => [entry.name, entry.classification])).toEqual([
        [`deploy-credentials/${names[0]}`, 'state'],
        [`deploy-credentials/${names[0]}/auth.json`, 'secret'],
        [`deploy-credentials/${names[0]}/log`, 'state'],
        [`deploy-credentials/${names[0]}/log/codex-login.log`, 'state'],
        [`deploy-credentials/${names[1]}`, 'state'],
      ]);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      await rm(join(parent, names[0], 'log', 'codex-login.log'));
      await symlink(join(parent, names[0], 'auth.json'), join(parent, names[0], 'log', 'codex-login.log'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name))
        .not.toContain(`deploy-credentials/${names[0]}/log/codex-login.log`);
      await rm(join(parent, names[0], 'log'), { recursive: true });
      await symlink(join(parent, names[1]), join(parent, names[0], 'log'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name))
        .not.toContain(`deploy-credentials/${names[0]}/log`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains Claude setup config and backup secrets while exposing foreign files and links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-setup-census-'));
    const name = 'deploy-credentials/.setup-acme-1234abcd';
    const backup = '.claude.json.backup.1794230000000';
    const corrupted = '.claude.json.corrupted.1794230000001';
    try {
      const home = join(root, name);
      await mkdir(join(home, 'backups'), { recursive: true });
      for (const file of ['.claude.json', '.claude.json.backup', backup, `backups/${backup}`, `backups/${corrupted}`,
        'foreign.ts', 'backups/foreign.json', 'backups/.claude.json.backup.invalid']) await writeFile(join(home, file), 'opaque fixture');
      await mkdir(join(home, 'backups', '.claude.json.backup.1794230000002'));
      await symlink(join(home, '.claude.json'), join(home, 'backups', '.claude.json.backup.1794230000003'));
      const result = await cliSetupHomeCensusProducer(root, null);
      expect(result.declarations.filter(entry => entry.classification === 'secret').map(entry => entry.name).sort())
        .toEqual(['.claude.json', '.claude.json.backup', backup, `backups/${backup}`, `backups/${corrupted}`].map(file => `${name}/${file}`).sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        `${name}/foreign.ts`, `${name}/backups/foreign.json`, `${name}/backups/.claude.json.backup.invalid`,
        `${name}/backups/.claude.json.backup.1794230000002`, `${name}/backups/.claude.json.backup.1794230000003`,
      ]));
      await rename(join(home, 'backups'), join(root, 'backup-target'));
      await symlink(join(root, 'backup-target'), join(home, 'backups'));
      await rm(join(home, '.claude.json'));
      await symlink(join(home, '.claude.json.backup'), join(home, '.claude.json'));
      const linked = await cliSetupHomeCensusProducer(root, null);
      expect(linked.declarations.map(entry => entry.name)).not.toContain(`${name}/backups`);
      expect(linked.declarations.map(entry => entry.name)).not.toContain(`${name}/.claude.json`);
      await rename(join(root, 'deploy-credentials'), join(root, 'credential-target'));
      await symlink(join(root, 'credential-target'), join(root, 'deploy-credentials'));
      expect((await cliSetupHomeCensusProducer(root, null)).declarations).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('classifies exact Codex arg0 directories and locks without claiming helpers or foreign descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-census-'));
    try {
      const home = 'deploy-credentials/.codex-setup-acme-1234abcd';
      const arg0 = `${home}/tmp/arg0`;
      const session = `${arg0}/codex-arg0PSchFu`;
      await mkdir(join(root, session), { recursive: true });
      await mkdir(join(root, arg0, 'foreign'));
      await writeFile(join(root, session, '.lock'), '');
      await writeFile(join(root, session, 'foreign.txt'), 'foreign');
      await symlink('/unverified/codex', join(root, session, 'apply_patch'));
      await symlink(join(root, session), join(root, arg0, 'codex-arg0ABC123'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toEqual([
        home, `${home}/tmp`, arg0, session, `${session}/.lock`,
      ]);
      expect((await cliSetupHomeCensusProducer(root)).declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      await rm(join(root, session, '.lock'));
      await symlink(join(root, session, 'foreign.txt'), join(root, session, '.lock'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).not.toContain(`${session}/.lock`);
      await rm(join(root, home, 'tmp'), { recursive: true });
      await symlink(root, join(root, home, 'tmp'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toEqual([home]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('requires helper symlinks to resolve to the selected native Codex executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-identity-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const native = join(root, 'native-codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await writeFile(join(root, 'foreign-codex'), 'foreign');
      await symlink(native, join(root, session, 'apply_patch'));
      await symlink(native, join(root, session, 'applypatch'));
      await symlink(join(root, 'foreign-codex'), join(root, session, 'codex-linux-sandbox'));
      await symlink(join(root, 'missing'), join(root, session, 'codex-execve-wrapper'));
      await symlink(native, join(root, session, 'foreign-helper'));
      const names = (await cliSetupHomeCensusProducer(root, native)).declarations.map(entry => entry.name);
      expect(names).toContain(`${session}/apply_patch`);
      expect(names).toContain(`${session}/applypatch`);
      for (const name of ['codex-linux-sandbox', 'codex-execve-wrapper', 'foreign-helper']) expect(names).not.toContain(`${session}/${name}`);
      // The interactive account-link module is mocked to throw in this suite.
      // Default writer selection must still prove the native helpers.
      vi.stubEnv('CODEX_BIN', native);
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      expect((await cliSetupHomeCensusProducer(root, null)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
      const packageRoot = join(root, 'npm-codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
      const launcher = join(packageRoot, 'bin/codex.js');
      await writeFile(launcher, '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const vendor = join(packageRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      await symlink(native, join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      await rm(join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
      const optionalRoot = join(packageRoot, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`);
      await mkdir(join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin'), { recursive: true });
      await writeFile(join(optionalRoot, 'package.json'), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
      const optionalNative = join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
      await symlink(native, optionalNative);
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      // An installed optional package owns resolution; a stale bundled binary
      // must not classify helpers if the selected optional binary is missing.
      await symlink(native, join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      await rm(optionalNative);
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it('proves helpers from another installed npm Codex without depending on PATH selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-multiple-installs-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const selected = join(root, 'selected-codex');
      await writeFile(selected, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      vi.stubEnv('CODEX_BIN', selected);
      const packageRoot = join(root, 'older-install', 'node_modules', '@openai', 'codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      const manifest = { name: '@openai/codex', bin: { codex: 'bin/codex.js' } };
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const vendor = join(packageRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      const native = join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await symlink(native, join(root, session, 'apply_patch'));
      const foreign = join(packageRoot, 'foreign-codex');
      await writeFile(foreign, 'foreign');
      await symlink(foreign, join(root, session, 'applypatch'));
      const names = async (cli?: string | null) => (await cliSetupHomeCensusProducer(root, cli)).declarations.map(entry => entry.name);
      expect(await names()).toContain(`${session}/apply_patch`);
      expect(await names()).not.toContain(`${session}/applypatch`);
      expect(await names(selected)).not.toContain(`${session}/apply_patch`);
      expect(await names(null)).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, name: 'foreign' }));
      expect(await names()).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await rm(native);
      expect(await names()).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it('proves hoisted optional Codex helpers through their owning CLI package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-hoisted-install-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const selected = join(root, 'selected-codex');
      await writeFile(selected, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      vi.stubEnv('CODEX_BIN', selected);
      const scope = join(root, 'older-install', 'node_modules', '@openai');
      const packageRoot = join(scope, 'codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      const manifest = { name: '@openai/codex', bin: { codex: 'bin/codex.js' } };
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const optionalRoot = join(scope, `codex-${process.platform}-${process.arch}`);
      const vendor = join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      await writeFile(join(optionalRoot, 'package.json'), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
      const native = join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await symlink(native, join(root, session, 'apply_patch'));
      const names = async (cli?: string | null) => (await cliSetupHomeCensusProducer(root, cli)).declarations.map(entry => entry.name);
      expect(await names()).toContain(`${session}/apply_patch`);
      expect(await names(selected)).not.toContain(`${session}/apply_patch`);
      expect(await names(null)).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, name: 'foreign' }));
      expect(await names()).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await rm(join(optionalRoot, 'package.json'));
      expect(await names()).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(['nested', 'hoisted'])('proves npm-aliased optional Codex helpers (%s)', async layout => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-aliased-install-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const selected = join(root, 'selected-codex');
      await writeFile(selected, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      vi.stubEnv('CODEX_BIN', selected);
      const scope = join(root, 'older-install', 'node_modules', '@openai');
      const packageRoot = join(scope, 'codex'
