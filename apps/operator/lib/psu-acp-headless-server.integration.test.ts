import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { fixtureNode, referenceSidecar } from '../scripts/psu-acp/fixtures/fixture-node';

const run = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL('../scripts/psu-acp/fixtures/', import.meta.url));
const packer = fileURLToPath(new URL('../../../papercusp-desktop/bin/pack-headless-server.py', import.meta.url));
const dockerHost = process.env.DOCKER_HOST || 'unix:///run/docker-bench.sock';
const docker = (...args: string[]) => run('docker', ['--host', dockerHost, ...args], { timeout: 100_000 });

async function buildSqlProbe(directory: string) {
  await build({
    entryPoints: [join(fixtureRoot, 'measure-postgres.mjs')], outfile: join(directory, 'measure.mjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['@embedded-postgres/*'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}

function verifySqlProfile(stdout: string) {
  const measurement = JSON.parse(stdout.trim());
  expect(measurement.uid).toBe(65534);
  expect(measurement.hostBytes).toBeGreaterThanOrEqual(8 * 2 ** 30);
  expect(measurement.physicalCores).toBeGreaterThan(0);
  const connections = Math.min(1000, Math.max(100, 4 * measurement.physicalCores));
  const workMem = Math.min(64, Math.max(4, Math.round((8192 - 1229) / (4 * connections))));
  expect(measurement.settings).toEqual({ max_connections: connections, shared_buffers: 1229,
    effective_cache_size: 4096, maintenance_work_mem: 512, work_mem: workMem, wal_buffers: 37, max_wal_size: 1024 });
  return measurement;
}

describe.runIf(process.platform === 'linux')('psu-acp headless server', () => {
  it('boots a smaller relocated server offline under an ordinary user', async () => {
    const source = referenceSidecar;
    const directory = await mkdtemp(join(tmpdir(), 'psu-acp-package-'));
    let container: string | undefined;
    try {
      const archive = process.env.PSU_ACP_HEADLESS_ARCHIVE || join(directory, 'headless.tar.gz');
      if (!process.env.PSU_ACP_HEADLESS_ARCHIVE) {
        await run('python3', [packer, source, archive], { timeout: 600_000 });
        await chmod(archive, 0o644);
      }
      const stamp = JSON.parse(await readFile(join(source, '.sidecar-build-stamp'), 'utf8'));
      const original = Number((await run('du', ['-sb', source])).stdout.split('\t')[0]);
      const observer = join(directory, 'observer');
      await mkdir(observer);
      await buildSqlProbe(observer);
      // Keep the tracer's dependencies outside the distribution under test.
      await copyFile('/usr/bin/strace', join(observer, 'strace'));
      const { stdout: libraries } = await run('ldd', ['/usr/bin/strace']);
      for (const hit of libraries.matchAll(/=> (\/[^\s]+) \(/g)) {
        if (basename(hit[1]).startsWith('libc.so')) continue;
        await copyFile(hit[1], join(observer, basename(hit[1])));
      }
      const image = (await docker('build', '--quiet', '--network=none', '--pull=false', fixtureRoot)).stdout.trim();
      container = (await docker('run', '-d', '--network', 'none', '--memory', '8g', '--memory-swap', '8g',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', 'type=bind,src=' + archive + ',dst=/input.tar.gz,readonly',
        '--mount', 'type=bind,src=' + observer + ',dst=/observer,readonly',
        '-e', 'PAPERCUSP_HONO_PORT=3461', '-e', 'PAPERCUSP_PG_PORT=5461',
        image, 'sleep', '900')).stdout.trim();
      const exec = (...args: string[]) => docker('exec', container!, ...args);
      const destination = '/work/relocated install';
      const root = destination + '/papercusp-server';
      const node = root + '/sidecar/bin/node';
      await exec('mkdir', destination);
      await exec('tar', '-xzf', '/input.tar.gz', '-C', destination);
      const installed = Number((await exec('du', '-sb', root)).stdout.split('\t')[0]);
      expect(installed).toBeLessThan(original);
      expect((await exec('stat', '-c', '%u', root + '/start-server')).stdout.trim()).toBe('65534');
      const manifest = JSON.parse((await exec('cat', root + '/headless-manifest.json')).stdout);
      expect(manifest.serveSha256).toBe(stamp.serveSha256);
      expect((await exec('sha256sum', root + '/sidecar/serve.mjs')).stdout.split(' ')[0]).toBe(stamp.serveSha256);
      await exec('test', '!', '-e', root + '/seed');
      await exec('test', '!', '-e', root + '/sidecar/source.tar.zst');
      await exec('test', '!', '-e', root + '/sidecar/spa');
      expect((await exec('/sbin/ldconfig', '-p')).stdout).not.toMatch(/lib(?:gtk|webkit|X11|wayland-client|gstreamer)/i);
      await docker('exec', '-d', container, 'sh', '-c',
        'exec env LD_LIBRARY_PATH=/observer /observer/strace -f -qq -E LD_LIBRARY_PATH -e trace=connect,sendto,sendmsg,sendmmsg -o /work/network.log "$1" > /work/server.log 2>&1',
        'observe-server', root + '/start-server');
      const health = "const r = await fetch('http://127.0.0.1:3461/api/health'); if (!r.ok) process.exit(1);";
      await vi.waitFor(() => exec(node, '--input-type=module', '--eval', health), { timeout: 150_000, interval: 1000 });
      // Include a served request after readiness in the observed interval.
      await exec(node, '--input-type=module', '--eval', health);
      const sqlResult = await exec(node, '/observer/measure.mjs', root + '/state/embedded-pg.json');
      const postgresProfile = verifySqlProfile(sqlResult.stdout);
      const trace = join(directory, 'network.log');
      await docker('cp', container + ':/work/network.log', trace);
      const network = await readFile(trace, 'utf8');
      const addresses = Array.from(network.matchAll(/(?:inet_addr\("|inet_pton\(AF_INET6, ")([^"]+)"/g),
        match => match[1]);
      expect(addresses.some(ip => ip.startsWith('127.') || ip === '::1')).toBe(true);
      const external = [...new Set(addresses.filter(ip => !ip.startsWith('127.') &&
        ip !== '::1' && !ip.startsWith('::ffff:127.')))];
      expect(external).toEqual([]);
      console.info('PSU_ACP_PACKAGE_MEASUREMENT', { sourceBytes: original, archiveBytes: (await stat(archive)).size,
        installedBytes: installed, serveSha256: stamp.serveSha256, external, postgresProfile });
    } catch (error) {
      if (container) {
        const diagnostics = await mkdtemp(join(tmpdir(), 'psu-acp-package-diagnostics-'));
        const copies = await Promise.allSettled(['server.log', 'network.log'].map(name =>
          docker('cp', container + ':/work/' + name, join(diagnostics, name))));
        console.error('PSU_ACP_PACKAGE_DIAGNOSTICS', diagnostics, copies.map(result => result.status));
      }
      throw error;
    } finally {
      try { if (container) await docker('rm', '-f', container); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 850_000);

  it('reports the independently predicted SQL memory profile under an 8 GiB limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'psu-acp-sql-'));
    let container: string | undefined;
    try {
      const embedded = createRequire(import.meta.url).resolve('@papercusp/embedded-postgres-server');
      const nativeName = '@embedded-postgres/linux-' + process.arch;
      const nativeDir = dirname(dirname(createRequire(embedded).resolve(nativeName)));
      await buildSqlProbe(directory);
      await chmod(directory, 0o755);
      await mkdir(join(directory, 'node_modules', nativeName), { recursive: true });
      const image = (await docker('build', '--network=none', '--pull=false', '--quiet', fixtureRoot)).stdout.trim();
      const node = fixtureNode();
      container = (await docker('create', '--network', 'none', '--memory', '8g', '--memory-swap', '8g',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-e', 'LANG=C.UTF-8',
        '--mount', 'type=bind,src=' + directory + ',dst=/probe,readonly',
        '--mount', 'type=bind,src=' + nativeDir + ',dst=/probe/node_modules/' + nativeName + ',readonly',
        '--mount', 'type=bind,src=' + node + ',dst=/usr/local/bin/node,readonly',
        image, '/usr/local/bin/node', '/probe/measure.mjs')).stdout.trim();
      const { stdout } = await docker('start', '--attach', container);
      expect((await docker('inspect', '--format', '{{.State.ExitCode}} {{.HostConfig.Memory}}', container)).stdout.trim())
        .toBe('0 8589934592');
      console.info('PSU_ACP_SQL_MEASUREMENT', verifySqlProfile(stdout));
    } finally {
      try { if (container) await docker('rm', '-f', container); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 150_000);
});
