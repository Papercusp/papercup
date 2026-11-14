---
rel_path: "portability/census/v83-v80-v82/001-state-census-producers.test.ts.part-004"
updated_at: 1794268279628
_body: "content"
---

omUUID()}.tmp`']) expect(writer).toContain(source);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('classifies desktop process markers and durable target using their actual homes and display payloads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'desktop-census-'));
    const real = join(home, 'real-user');
    const channel = join(real, '.papercusp-nightly');
    const override = join(home, 'host-override');
    const ordinary = join(real, '.papercusp');
    const channelState = join(channel, '.papercusp');
    const report = (display: string) => JSON.stringify({ version: '0.0.1', pid: 42, startedAtMs: 123,
      display, role: 'gui', isDev: false });
    try {
      for (const directory of [ordinary, channelState, override]) await mkdir(directory, { recursive: true });
      for (const directory of [ordinary, channelState]) {
        await writeFile(join(directory, 'desktop-app-version.json'), report(''));
        await writeFile(join(directory, 'desktop-app-version-110_0.json'), report(':110.0'));
        await writeFile(join(directory, 'desktop-app-version-foreign.json'), report(':other'));
        await writeFile(join(directory, 'desktop-app-version-invalid.json'), '{}');
        await writeFile(join(directory, 'desktop-build-target.json'), '{"name":"staging","port":3170}');
        await writeFile(join(directory, 'desktop-build-target.json.bak'), 'unknown');
        await symlink(join(directory, 'desktop-app-version.json'), join(directory, 'desktop-app-version-link.json'));
      }
      // PAPERCUSP_HOME does not relocate either Rust desktop writer.
      await writeFile(join(override, 'desktop-build-target.json'), 'unknown');
      await writeFile(join(override, 'desktop-app-version.json'), report(''));
      const result = await runtimeSidefileCensusProducer(channel, { HOME: real, PAPERCUSP_HOME: override });
      const reports = result.declarations.filter(entry => entry.producer === 'desktop-app-version-report');
      expect(reports).toHaveLength(4);
      expect(reports.every(entry => entry.classification === 'cache' && !entry.descendants)).toBe(true);
      const targets = result.declarations.filter(entry => entry.producer === 'desktop-env-switch-target');
      expect(targets).toHaveLength(1);
      expect(result.roots.find(root => root.id === targets[0].root)?.path).toBe(ordinary);
      expect(targets[0].classification).toBe('config');
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const name of ['desktop-app-version-foreign.json', 'desktop-app-version-invalid.json',
        'desktop-app-version-link.json', 'desktop-build-target.json.bak']) expect(census.residue.some(entry => entry.name === name)).toBe(true);
      const fallback = await runtimeSidefileCensusProducer(channel, { USERPROFILE: real, PAPERCUSP_HOME: override });
      expect(fallback.declarations.filter(entry => entry.producer === 'desktop-app-version-report')).toHaveLength(4);
      expect(fallback.declarations.filter(entry => entry.producer === 'desktop-env-switch-target')).toHaveLength(0);
      const desktop = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/main.rs', import.meta.url), 'utf8');
      expect(desktop).toContain('let ver_path = workspaces::shared_sidecar_home()');
      expect(desktop).toContain('disp.replace(\':\', "").replace(\'.\', "_")');
      const workspaces = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/workspaces.rs', import.meta.url), 'utf8');
      expect(workspaces).toContain('home_for(real_home(), data_home_dir_name())');
      expect(workspaces).toContain('real.join(data_home_dir_name)');
      expect(workspaces).toContain('std::env::var("HOME")');
      expect(workspaces).toContain('std::env::var("USERPROFILE")');
      const target = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/env_switch.rs', import.meta.url), 'utf8');
      expect(target).toContain('let home = std::env::var_os("HOME")?');
      expect(target).toContain('.join(".papercusp/desktop-build-target.json")');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains discovery in explicit workspace runtime homes without following links or claiming copied working directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'workspace-discovery-census-'));
    const active = join(home, 'active');
    const inactive = join(home, 'inactive');
    const copied = join(home, 'project');
    const linked = join(home, 'linked');
    const records = {
      'operator.json': { httpUrl: 'http://127.0.0.1:3170', port: 3170, token: 'fixture-bearer', pid: 123,
        startedAt: 1730000000000, version: '0.1.0' },
      'operator-port.json': { port: 3170, updatedAt: 1730000000000 },
      'endpoint-ipc.3170.json': {},
      'endpoint-ipc.json.2f8f5ba0-d4ba-4c88-8884-2f2a7969683a.tmp': {},
    };
    try {
      for (const directory of [join(home, '.papercusp'), active, inactive, copied]) {
        await mkdir(directory);
        for (const [name, record] of Object.entries(records)) await writeFile(join(directory, name), JSON.stringify(record));
        await writeFile(join(directory, 'operator.json.bak'), '{}');
        await writeFile(join(directory, 'endpoint-ipc.65536.json'), '{}');
      }
      await symlink(copied, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: active }, [copied],
        [active, inactive, inactive, linked]);
      for (const directory of [active, inactive]) {
        const root = result.roots.find(entry => entry.path === directory)!;
        const entries = result.declarations.filter(entry => entry.root === root.id);
        expect(entries.map(entry => entry.name).sort()).toEqual(Object.keys(records).sort());
        expect(entries.find(entry => entry.name === 'operator.json')).toMatchObject({ classification: 'secret' });
        expect(entries.find(entry => entry.name === 'operator-port.json')).toMatchObject({ classification: 'config' });
        expect(entries.filter(entry => entry.name.startsWith('endpoint-ipc')).every(entry => entry.classification === 'cache')).toBe(true);
      }
      expect(result.roots.some(entry => entry.path === linked || entry.path === copied)).toBe(false);
      expect(await readFile(join(inactive, 'operator.json'), 'utf8')).toBe(JSON.stringify(records['operator.json']));
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains validated operator discovery credentials and port memory across host-home relocation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'operator-discovery-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const cwd = join(home, 'project');
    const operator = { httpUrl: 'http://127.0.0.1:3170', port: 3170, token: 'test-bearer', pid: 123,
      processIdentity: 'test-boot:123', startedAt: 1730000000000, version: '0.1.0', sha: null };
    const pg = { url: 'postgresql://harness_admin:test@127.0.0.1:5432/harness',
      appUrl: 'postgresql://harness_app:test@127.0.0.1:5432/harness', port: 5432, pid: 123, startedAt: 1730000000000 };
    const credentials = { schemaVersion: 1, owner: 'a'.repeat(43), admin: 'b'.repeat(43), app: 'c'.repeat(43), zero: 'd'.repeat(43) };
    const records = { 'operator.json': operator, 'operator-port.json': { port: 3170, updatedAt: 1730000000000 },
      'embedded-pg.json': pg, 'embedded-pg.5432.json': pg, 'embedded-pg-credentials.json': credentials };
    try {
      for (const directory of [ordinary, relocated, cwd]) {
        await mkdir(directory);
        for (const [name, record] of Object.entries(records)) {
          await writeFile(join(directory, name), JSON.stringify(record));
          await writeFile(join(directory, `${name}.tmp.123`), JSON.stringify(record));
        }
      }
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [cwd]);
      const owned = result.declarations.filter(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer));
      expect(owned).toHaveLength(20);
      expect(owned.filter(entry => entry.classification === 'secret')).toHaveLength(16);
      expect(owned.filter(entry => entry.classification === 'config')).toHaveLength(4);
      expect(owned.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(owned.every(entry => result.roots.find(root => root.id === entry.root)?.path !== cwd)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.filter(entry => entry.name.startsWith('operator') || entry.name.startsWith('embedded-pg'))).toEqual([]);
      expect(await readFile(join(relocated, 'embedded-pg-credentials.json'), 'utf8')).toBe(JSON.stringify(credentials));
      const writer = await readFile(new URL('../../../../apps/operator/bin/serve.ts', import.meta.url), 'utf8');
      expect(writer).toContain('const PAPERCUSP_DIR = papercuspHome()');
      expect(writer).toContain('`embedded-pg.${pg.port}.json`');
      expect(writer).toContain('const tmp = `${path}.tmp.${process.pid}`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('leaves foreign, malformed, mismatched, oversized and linked operator records unresolved', async () => {
    const home = await mkdtemp(join(tmpdir(), 'operator-discovery-invalid-'));
    const ordinary = join(home, '.papercusp');
    const linked = join(home, 'linked');
    const pg = { url: 'postgresql://harness_admin:test@127.0.0.1:5432/harness', port: 5432, pid: 123, startedAt: 1730000000000 };
    const invalid = {
      'operator.json': { httpUrl: 'https://foreign.example:3170', port: 3070, token: 'bearer', pid: 123, startedAt: 1, version: '1' },
      'operator-port.json': { port: 3170, updatedAt: 1, foreign: true },
      'embedded-pg.json': { ...pg, url: 'file:///foreign' },
      'embedded-pg.5433.json': pg,
      'embedded-pg.65536.json': pg,
      'embedded-pg-credentials.json': { owner: 'short', admin: 'short', app: 'short', zero: 'short' },
      'embedded-pg-credentials.json.tmp.123': { schemaVersion: 2, owner: 'a'.repeat(43), admin: 'b'.repeat(43), app: 'c'.repeat(43), zero: 'd'.repeat(43) },
      'operator-port.json.tmp.0': { port: 3170, updatedAt: 1 },
      'operator-port.json.tmp.2147483648': { port: 3170, updatedAt: 1 },
      'operator-port.json.bak': { port: 3170, updatedAt: 1 },
      'embedded-pg.5440.json': { ...pg, port: 5440 },
    };
    try {
      await mkdir(ordinary);
      for (const [name, record] of Object.entries(invalid)) await writeFile(join(ordinary, name), JSON.stringify(record));
      await writeFile(join(ordinary, 'operator.json.tmp.123'), '{');
      await writeFile(join(ordinary, 'operator-port.json.tmp.124'), ' '.repeat(65_537));
      await symlink(join(ordinary, 'operator-port.json'), join(ordinary, 'operator-port.json.tmp.125'));
      await mkdir(join(ordinary, 'embedded-pg.5432.json'));
      await symlink(ordinary, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: linked });
      expect(result.declarations.some(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer))).toBe(false);
      expect(result.roots.some(root => root.path === linked)).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining(Object.keys(invalid)));
      expect(await readFile(join(ordinary, 'operator.json.tmp.123'), 'utf8')).toBe('{');
      await rename(ordinary, join(home, 'target'));
      await symlink(join(home, 'target'), ordinary);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations
        .some(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer))).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains host gateway logs and one rotation across relocation without trusting workspace names or links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gateway-log-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const override = join(home, 'override', 'lifecycle.txt');
    const logs = [join(ordinary, 'gateway.log'), join(relocated, 'gateway.log'), override];
    const environment = { PAPERCUSP_HOME: relocated, PAPERCUSP_GATEWAY_LOG: override };
    try {
      for (const directory of [ordinary, relocated, join(home, 'override')]) await mkdir(directory);
      for (const log of logs) {
        await writeFile(log, 'retained gateway lifecycle');
        await writeFile(`${log}.1`, 'retained gateway rotation');
        await writeFile(`${log}.2`, 'unproven sibling');
      }
      const result = await runtimeSidefileCensusProducer(home, environment);
      const declarations = result.declarations.filter(entry => entry.producer === 'inference-gateway-lifecycle-log');
      expect(declarations).toHaveLength(6);
      expect(declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.find(root => root.path === join(home, 'override'))?.fileNames?.sort())
        .toEqual(['lifecycle.txt', 'lifecycle.txt.1']);
      const merged = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'relocated', path: relocated }],
        declarations: result.declarations });
      const census = await collectStateCensus({ ...merged, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.classification === 'state')).toHaveLength(6);
      expect(census.residue.map(entry => entry.name)).toEqual(['gateway.log.2', 'gateway.log.2']);
      expect(await readFile(override, 'utf8')).toBe('retained gateway lifecycle');
      await rm(override);
      await symlink(`${override}.1`, override);
      await rename(relocated, join(home, 'relocated-target'));
      await symlink(join(home, 'relocated-target'), relocated);
      const linked = await runtimeSidefileCensusProducer(home, environment);
      const owned = linked.declarations.filter(entry => entry.producer === 'inference-gateway-lifecycle-log');
      expect(owned).toHaveLength(3);
      expect(owned.filter(entry => entry.name.startsWith('lifecycle'))).toEqual([
        expect.objectContaining({ name: 'lifecycle.txt.1' }),
      ]);
      const writer = await readFile(new URL('../inference-gateway/sidecar-main.ts', import.meta.url), 'utf8');
      expect(writer).toContain("import { papercuspPath } from '@papercusp/host-platform/home'");
      expect(writer).toContain("process.env.PAPERCUSP_GATEWAY_LOG || papercuspPath('gateway.log')");
      expect(writer).toContain('const rotatedPath = `${path}.1`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains backup-health writer histories and exact configured markers while exposing unknown files and links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'backup-health-census-'));
    const ordinary = join(home, '.papercusp', 'backup-health');
    const override = join(home, 'health-override');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      const owned = ['db-disk-history', 'db-disk-history.tmp', 'backup-volume-history', 'backup-volume-history.tmp',
        'db-disk-red-ei-filed', 'db-relation-bloat-ei-filed', 'backup-volume-red-ei-filed',
        'workspace-dead-dump-tmp', 'consecutive-fails', 'stale-tmp', 'stale-pg-papercusp-state',
        'missing-pg-restart', 'tmpdir-entries-red-tmp', 'tmpdir-entries-red-tmp-pcv'];
      for (const directory of [ordinary, override]) {
        await mkdir(directory, { recursive: true });
        for (const name of [...owned, 'missing-pg-custom', 'stale--scratch-dump.sql', 'tmpdir-entries-red-scratch---',
          'unknown.json', 'stale-pg-foreign', 'tmpdir-entries-red-foreign']) await writeFile(join(directory, name), 'baseline');
        await mkdir(join(directory, 'copied-source'));
        await writeFile(join(directory, 'copied-source', 'index.ts'), 'foreign');
        await symlink(join(directory, 'db-disk-history'), join(directory, 'missing-pg-papercusp-state'));
      }
      const defaults = await runtimeSidefileCensusProducer(home, {});
      expect(defaults.roots.some(root => root.path === override)).toBe(false);
      expect(defaults.declarations.filter(entry => entry.producer === 'backup-health-probe').map(entry => entry.name).sort())
        .toEqual(['backup-health', ...owned.map(name => `backup-health/${name}`)].sort());
      const environment = { BACKUP_STATE_DIR: override, BACKUP_ARTIFACTS: 'pg/custom',
        BACKUP_OPTIONAL_ARTIFACTS: '/scratch/dump.sql /unexpanded/*/dump.sql', BACKUP_TMPDIR_WATCH: '/scratch/é' };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      const classified = census.inventory.filter(entry => entry.producers.includes('backup-health-probe'));
      expect(classified.every(entry => entry.classification === 'state')).toBe(true);
      expect(classified.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'backup-health/missing-pg-custom', 'backup-health/stale--scratch-dump.sql', 'backup-health/tmpdir-entries-red-scratch---',
        'missing-pg-custom', 'stale--scratch-dump.sql', 'tmpdir-entries-red-scratch---',
      ]));
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'backup-health/unknown.json', 'backup-health/stale-pg-foreign', 'backup-health/tmpdir-entries-red-foreign',
        'backup-health/missing-pg-papercusp-state', 'backup-health/copied-source/index.ts',
        'unknown.json', 'stale-pg-foreign', 'tmpdir-entries-red-foreign', 'copied-source/index.ts',
      ]));
      expect(result.declarations.filter(entry => entry.producer === 'backup-health-probe')
        .every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(await readFile(join(ordinary, 'db-disk-history'), 'utf8')).toBe('baseline');
      for (const [directory, target] of [[ordinary, join(home, 'ordinary-target')], [override, join(home, 'override-target')]]) {
        await rename(directory, target);
        await symlink(target, directory);
      }
      const linked = await runtimeSidefileCensusProducer(home, environment);
      expect(linked.declarations.some(entry => entry.producer === 'backup-health-probe')).toBe(false);
      expect(linked.roots.some(root => root.path === override)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/papercup-backup-health-check.sh', import.meta.url), 'utf8');
      expect(writer).toContain('STATE_DIR="${BACKUP_STATE_DIR:-$HOME/.papercusp/backup-health}"');
      for (const name of owned.slice(0, 10).filter(name => !name.endsWith('.tmp'))) expect(writer).toContain(name);
      expect(writer).toContain('"$hist.tmp"');
      expect(writer).toContain("tr -c 'A-Za-z0-9' '-'");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('keeps Kopia alert state independent of backup probe relocation and rejects unowned neighbors and links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kopia-health-census-'));
    const ordinary = join(home, '.papercusp', 'backup-health');
    const probe = join(home, 'probe');
    const kopia = join(home, 'kopia');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      for (const directory of [ordinary, probe, kopia]) {
        await mkdir(join(directory, 'copied-source'), { recursive: true });
        await writeFile(join(directory, 'last-alert'), '1730000000\n');
        await writeFile(join(directory, 'db-disk-history'), 'baseline');
        await writeFile(join(directory, 'last-alert.tmp'), 'foreign');
        await writeFile(join(directory, 'copied-source', 'index.ts'), 'foreign');
      }
      const environment = { BACKUP_STATE_DIR: probe, HEALTHCHECK_STATE_DIR: kopia,
        PAPERCUSP_HOME: join(home, 'unrelated-home') };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.producers.includes('kopia-healthcheck'))
        .every(entry => entry.classification === 'state')).toBe(true);
      expect(result.declarations.filter(entry => entry.producer === 'kopia-healthcheck').map(entry => entry.name).sort())
        .toEqual(['backup-health', 'backup-health/last-alert', 'last-alert']);
      const rootFor = (path: string) => result.roots.find(root => root.path === path)!.id;
      expect(census.residue).toEqual(expect.arrayContaining([
        expect.objectContaining({ root: rootFor(probe), name: 'last-alert' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'db-disk-history' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'last-alert.tmp' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'copied-source/index.ts' }),
      ]));
      expect(result.declarations.filter(entry => entry.producer === 'kopia-healthcheck')
        .every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const shared = await runtimeSidefileCensusProducer(home, { BACKUP_STATE_DIR: kopia, HEALTHCHECK_STATE_DIR: kopia });
      expect(shared.roots.filter(root => root.path === kopia)).toHaveLength(1);
      const sharedCensus = await collectStateCensus({ ...shared, readCatalogs: async () => [] });
      expect(sharedCensus.residue.some(entry => entry.root === shared.roots.find(root => root.path === kopia)!.id
        && ['last-alert', 'db-disk-history'].includes(entry.name))).toBe(false);
      expect(await readFile(join(kopia, 'last-alert'), 'utf8')).toBe('1730000000\n');
      await rm(join(kopia, 'last-alert'));
      await symlink(join(probe, 'last-alert'), join(kopia, 'last-alert'));
      const linkedFile = await runtimeSidefileCensusProducer(home, environment);
      expect(linkedFile.declarations.some(entry => entry.producer === 'kopia-healthcheck'
        && entry.name === 'last-alert')).toBe(false);
      for (const directory of [ordinary, kopia]) {
        await rename(directory, `${directory}-target`);
        await symlink(`${directory}-target`, directory);
      }
      const linkedDirectories = await runtimeSidefileCensusProducer(home, environment);
      expect(linkedDirectories.declarations.some(entry => entry.producer === 'kopia-healthcheck')).toBe(false);
      expect(linkedDirectories.roots.some(root => root.path === kopia)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/systemd/kopia-healthcheck.sh', import.meta.url), 'utf8');
      expect(writer).toContain('HEALTHCHECK_STATE_DIR="${HEALTHCHECK_STATE_DIR:-$HOME/.papercusp/backup-health}"');
      expect(writer).toContain('local marker="$HEALTHCHECK_STATE_DIR/last-alert"');
      expect(writer).toContain('echo "$now" > "$marker"');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('uses actual default and relocated co-change/model cache writers without following links or owning neighbors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'host-cache-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'configured-home');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      for (const base of [ordinary, relocated]) {
        const snapshots = join
