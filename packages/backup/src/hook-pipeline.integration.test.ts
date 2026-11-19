import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

vi.mock('./config', () => ({
  backupHost: () => ({ getHarnessAdminUrl: () => ({ url: 'postgres://fixture@127.0.0.1/fixture', source: 'test' }) }),
}));
vi.mock('./host-dump-coverage', () => ({
  hostDumpStatusPath: () => '/unused-fixture-receipt',
  readHostDumpStatus: async () => null,
  readHostDumpInProgress: async () => null,
  probeSystemIdentifier: async () => null,
  evaluateHostDumpCoverage: () => ({ covered: false, reason: 'isolated fixture' }),
}));
import { runPreSnapshotHook } from './hook';

// These are real child processes and files; no PostgreSQL or shared backup is
// contacted. The observer blocks the operator's JS thread while checking that
// the complete compressed data (including its tail) still reaches the file.
describe.skipIf(process.platform !== 'linux')('backup pipeline independent of the operator event loop', () => {
  let root: string;
  let bin: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'backup-pipeline-'));
    bin = join(root, 'bin');
    await mkdir(bin);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('KOPIA_BACKUP_GUARD_ACTIVE', '1');
    vi.stubEnv('BACKUP_PIPE_FIXTURE', root);
    await writeFile(join(bin, 'pg_dump'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.BACKUP_PIPE_FIXTURE;
fs.writeFileSync(path.join(root, 'ready'), '');
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(root, 'go'))) return;
  clearInterval(timer);
  fs.createReadStream(path.join(root, 'input')).pipe(process.stdout);
}, 5);
`, { mode: 0o700 });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([65_535, 65_536, 65_537, 8 * 1024 * 1024 + 17])(
    'preserves all %i bytes while the operator thread cannot relay streams', async (size) => {
      const input = randomBytes(size);
      await writeFile(join(root, 'input'), input);
      const pending = runPreSnapshotHook({ workspaceId: 'fixture', workspaceRoot: root, triggerReason: 'pre_destructive' });
      await vi.waitFor(() => expect(existsSync(join(root, 'ready'))).toBe(true), { timeout: 20_000 });
      writeFileSync(join(root, 'go'), '');
      const observer = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = process.argv[1];
const expected = fs.readFileSync(path.join(root, 'input'));
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  for (const name of fs.readdirSync(path.join(root, 'db-dumps'))) {
    if (!name.endsWith('.tmp')) continue;
    try {
      const actual = zlib.gunzipSync(fs.readFileSync(path.join(root, 'db-dumps', name)));
      if (actual.equals(expected)) process.exit(0);
    } catch {}
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
process.stderr.write('backup stopped transferring while operator JS was blocked');
process.exit(1);
`, root], { encoding: 'utf8', timeout: 20_000 });
      // Drain the hook even on a failed assertion, so its children/queue cannot
      // leak into the next case or hide the old transport's failure.
      const result = await pending;
      expect(observer.status, observer.stderr).toBe(0);
      expect(result.ok).toBe(true);
      expect(gunzipSync(await readFile(join(root, 'db-dumps', 'pg-embedded.sql.gz')))).toEqual(input);
    }, 45_000,
  );

  it.each(['producer', 'compressor'] as const)('preserves the installed dump when the %s fails', async (which) => {
    const dumpDir = join(root, 'db-dumps');
    await mkdir(dumpDir);
    const installed = join(dumpDir, 'pg-embedded.sql.gz');
    const previous = Buffer.from('previous independently verified backup');
    await writeFile(installed, previous);
    await writeFile(join(root, 'input'), randomBytes(65_537));
    writeFileSync(join(root, 'go'), '');
    if (which === 'producer') {
      await writeFile(join(bin, 'pg_dump'), `#!${process.execPath}
process.stderr.write('fixture producer failed');
process.exit(17);
`, { mode: 0o700 });
    } else {
      await writeFile(join(bin, 'gzip'), `#!${process.execPath}
process.stderr.write('fixture compressor failed');
process.exit(23);
`, { mode: 0o700 });
    }
    const result = await runPreSnapshotHook({ workspaceId: 'fixture', workspaceRoot: root, triggerReason: 'pre_destructive' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`fixture ${which} failed`);
    expect(await readFile(installed)).toEqual(previous);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dumpDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 30_000);

  it('retains the guard READY/ACK fence before starting the inherited data transfer', async () => {
    const guard = join(bin, 'guard');
    await writeFile(guard, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
fs.writeSync(3, 'KOPIA_BACKUP_GUARD_READY\\n');
const ack = new net.Socket({ fd: 4, readable: true, writable: false });
ack.once('data', (data) => {
  ack.destroy();
  if (data.toString().trim() !== 'PROCEED') process.exit(75);
  const child = spawn('pg_dump', [], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
});
`, { mode: 0o700 });
    vi.stubEnv('KOPIA_BACKUP_GUARD_ACTIVE', '0');
    vi.stubEnv('KOPIA_BACKUP_GUARD_BIN', guard);
    const input = randomBytes(65_537);
    await writeFile(join(root, 'input'), input);
    writeFileSync(join(root, 'go'), '');
    let admissionChecked = false;
    const result = await runPreSnapshotHook(
      { workspaceId: 'fixture', workspaceRoot: root, triggerReason: 'pre_destructive' },
      { onGuardReady: async () => {
        expect(existsSync(join(root, 'ready'))).toBe(false);
        admissionChecked = true;
      } },
    );
    expect(admissionChecked).toBe(true);
    expect(result.ok).toBe(true);
    expect(gunzipSync(await readFile(join(root, 'db-dumps', 'pg-embedded.sql.gz')))).toEqual(input);
  }, 30_000);
});
