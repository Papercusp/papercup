---
rel_path: "portability/census/v41/02-state-census-producers.test.ts.part-005"
updated_at: 1794241756285
_body: "content"
---

process.arch}` }));
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
      const packageRoot = join(scope, 'codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      const packageName = `@openai/codex-${process.platform}-${process.arch}`;
      const nativeVersion = `0.163.0-${process.platform}-${process.arch}`;
      // Published platform packages retain the main package name and are
      // installed under an npm alias named by the owning CLI's manifest.
      const manifest = { name: '@openai/codex', version: '0.163.0', bin: { codex: 'bin/codex.js' },
        optionalDependencies: { [packageName]: `npm:@openai/codex@${nativeVersion}` } };
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const optionalRoot = layout === 'nested'
        ? join(packageRoot, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`)
        : join(scope, `codex-${process.platform}-${process.arch}`);
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const vendor = join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      const optionalManifest = { name: '@openai/codex', version: nativeVersion, os: [process.platform], cpu: [process.arch] };
      const optionalJson = join(optionalRoot, 'package.json');
      await writeFile(optionalJson, JSON.stringify(optionalManifest));
      const native = join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await symlink(native, join(root, session, 'apply_patch'));
      const names = async (cli?: string | null) => (await cliSetupHomeCensusProducer(root, cli)).declarations.map(entry => entry.name);
      expect(await names()).toContain(`${session}/apply_patch`);
      expect(await names(selected)).not.toContain(`${session}/apply_patch`);
      expect(await names(null)).not.toContain(`${session}/apply_patch`);
      for (const changed of [
        { name: 'foreign' }, { version: '0.162.0-linux-x64' }, { os: ['foreign'] }, { cpu: ['foreign'] },
      ]) {
        await writeFile(optionalJson, JSON.stringify({ ...optionalManifest, ...changed }));
        expect(await names()).not.toContain(`${session}/apply_patch`);
      }
      await writeFile(optionalJson, JSON.stringify(optionalManifest));
      for (const optionalDependencies of [{}, { [packageName]: 'npm:foreign@0.163.0' }, { [packageName]: 'npm:@openai/codex@0.162.0-linux-x64' }]) {
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, optionalDependencies }));
        expect(await names()).not.toContain(`${session}/apply_patch`);
      }
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await rm(optionalJson);
      expect(await names()).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it('retains exact pacing and gym sidefiles while leaving unknown siblings and links visible', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidefile-census-'));
    try {
      const pacing = 'google-vertex-gemini-3.1-pro-preview.json';
      const temporary = `${pacing}.tmp-123-12345678-1234-1234-1234-123456789abc`;
      for (const directory of ['provider-pacing', 'template-gym']) await mkdir(join(home, '.papercusp', directory), { recursive: true });
      for (const file of [pacing, `${pacing}.lock`, temporary, `${pacing}.tmp-unknown`, 'unknown']) await writeFile(join(home, '.papercusp', 'provider-pacing', file), 'opaque');
      await writeFile(join(home, '.papercusp', 'template-gym', 'last-run.json'), '{}');
      await symlink(join(home, '.papercusp', 'template-gym', 'last-run.json'), join(home, '.papercusp', 'template-gym', 'runs.jsonl'));
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, '.papercusp', 'fs-mutex-locks'));
      const result = await runtimeSidefileCensusProducer(home, {});
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['provider-pacing', ...[pacing, `${pacing}.lock`, temporary].map(file => `provider-pacing/${file}`), 'template-gym', 'template-gym/last-run.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const hook = await readFile(new URL('../../../../apps/operator/scripts/hooks/omp/coord-hook.ts', import.meta.url), 'utf8');
      expect(hook).toContain(`'${pacing}'`);
      expect(hook).toContain('`${statePath}.tmp-${process.pid}-${randomUUID()}`');
      const gym = await readFile(new URL('../harness/routines/template-gym-runner.ts', import.meta.url), 'utf8');
      for (const name of ['template-gym', 'last-run.json', 'runs.jsonl']) expect(gym).toContain(`'${name}'`);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('excludes relocated host mutex ownership from transport while preserving unknown siblings and live bytes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mutex-census-'));
    const mutex = join(home, 'runtime', 'relocated-locks');
    try {
      await mkdir(join(home, '.papercusp'), { recursive: true });
      await mkdir(join(mutex, 'live.lock'), { recursive: true });
      await writeFile(join(mutex, 'live.lock', 'owner.json'), 'live owner fixture');
      await writeFile(join(home, 'runtime', 'foreign'), 'unproven fixture');
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', mutex);
      const result = await runtimeSidefileCensusProducer(home, {});
      const report = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(report.inventory.find(entry => entry.name === 'relocated-locks')).toMatchObject({ classification: 'cache',
        producers: ['filesystem-mutex-runtime'] });
      expect(report.inventory.some(entry => entry.name.startsWith('relocated-locks/'))).toBe(false);
      expect(report.residue.map(entry => entry.name)).toContain('foreign');
      expect(await readFile(join(mutex, 'live.lock', 'owner.json'), 'utf8')).toBe('live owner fixture');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('censuses exact bundle and TUI cache writers while preserving unknown contents and symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'runtime-cache-census-'));
    const cache = join(home, '.papercusp', 'cache');
    const bundle = join(cache, 'bundle-free-refs');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      await mkdir(bundle, { recursive: true });
      const digest = 'a'.repeat(64);
      const known = [`${digest}.json`, `${digest}.json.123.tmp`];
      for (const name of [...known, 'unknown.json', `${digest.toUpperCase()}.json`, `${digest}.json.bad.tmp`]) {
        await writeFile(join(bundle, name), '{}');
      }
      await symlink(join(bundle, known[0]), join(bundle, `${'b'.repeat(64)}.json`));
      await mkdir(join(bundle, `${'c'.repeat(64)}.json`));
      await writeFile(join(cache, 'plans-list-standard-v1.json'), '{}');
      await writeFile(join(cache, '.plans-list-standard-v1.123.tmp'), '{}');
      await writeFile(join(cache, 'unknown.json'), '{}');
      await symlink(join(cache, 'unknown.json'), join(cache, '.plans-list-standard-v1.456.tmp'));
      const result = await runtimeSidefileCensusProducer(home, {});
      expect(result.declarations.map(entry => entry.name).sort()).toEqual([
        'cache', 'cache/plans-list-standard-v1.json', 'cache/.plans-list-standard-v1.123.tmp',
        'cache/bundle-free-refs', ...known.map(name => `cache/bundle-free-refs/${name}`),
      ].sort());
      expect(result.declarations.every(entry => entry.classification === 'cache' && !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'cache/unknown.json', 'cache/.plans-list-standard-v1.456.tmp',
        'cache/bundle-free-refs/unknown.json', `cache/bundle-free-refs/${'b'.repeat(64)}.json`,
        `cache/bundle-free-refs/${'c'.repeat(64)}.json`,
      ]));
      // A recognized directory name never licenses following a directory link.
      await rename(bundle, join(home, 'bundle-target'));
      await symlink(join(home, 'bundle-target'), bundle);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations.some(entry => entry.name.startsWith('cache/bundle-free-refs'))).toBe(false);
      await rename(cache, join(home, 'cache-target'));
      await symlink(join(home, 'cache-target'), cache);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations).toEqual([]);
      const writer = await readFile(new URL('../../../../scripts/check-bundle-free-refs.mjs', import.meta.url), 'utf8');
      expect(writer).toContain("join(homedir(), '.papercusp', 'cache', 'bundle-free-refs')");
      expect(writer).toContain('`${file}.${process.pid}.tmp`');
      const queryWriter = await readFile(new URL('../../../../apps/tui/src/shared_cache.rs', import.meta.url), 'utf8');
      expect(queryWriter).toContain('h.join(".papercusp").join("cache")');
      expect(queryWriter).toContain('format!(".{key}.{}.tmp", std::process::id())');
      expect(await readFile(new URL('../../../../apps/tui/src/client.rs', import.meta.url), 'utf8')).toContain('"plans-list-standard-v1"');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact project MCP writer files as secrets at explicit homes and workspace roots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'project-mcp-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const workspace = join(home, 'workspace', '.papercusp');
    const unknown = join(home, 'unknown');
    const linked = join(home, 'linked');
    const superuser = JSON.stringify({ mcpServers: { papercusp: {
      url: 'http://localhost:3070/api/mcp?superuser=1&workspace=fixture', headers: { Authorization: 'Bearer fixture' },
    } } });
    const role = JSON.stringify({ mcpServers: { papercusp: { type: 'http',
      url: 'https://operator.example/api/mcp?workspace=fixture&role=test&run=r&spawn=s&client=c&exp=1&sig=fixture',
    } } });
    const names = ['.mcp.json', '.mcp.json.papercusp.bak', '.mcp.json.su-parked',
      '.mcp.json.tmp-123-1234567890-aabbccddeeff', '.mcp.json.su-stub.123.12345678-1234-4234-8234-123456789abc.tmp'];
    try {
      for (const directory of [ordinary, relocated, workspace, unknown]) {
        await mkdir(directory, { recursive: true });
        for (const name of names) await writeFile(join(directory, name), name.includes('su-stub')
          ? JSON.stringify({ mcpServers: {} }) : name.endsWith('su-parked') ? role : superuser);
      }
      await symlink(workspace, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [workspace, workspace, linked]);
      const entries = result.declarations.filter(entry => entry.producer === 'console-project-mcp-writer');
      expect(entries).toHaveLength(names.length * 3);
      expect(entries.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.map(root => root.path).sort()).toEqual([ordinary, relocated, workspace].sort());
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue).toEqual([]);
      expect((await runtimeSidefileCensusProducer(home, {})).roots.map(root => root.path)).toEqual([ordinary]);
      const consoleWriter = await readFile(new URL('../console-spawn.ts', import.meta.url), 'utf8');
      const launcher = await readFile(new URL('../../../../apps/operator/scripts/psu-launcher.mjs', import.meta.url), 'utf8');
      expect(consoleWriter).toContain("'.mcp.json.papercusp.bak'");
      e
