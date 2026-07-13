/**
 * WI-4642 / P-021 — the Windows VM build directory is a real cross-run lease.
 *
 * This runs the production shell helper against a tiny fake MCP transport. It
 * proves the behavior the incident lacked: process A holds the host+directory,
 * process B is refused before its mutation marker, and a TERM exit releases,
 * verifies cleanup, and fires the previously-declared latched event.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

const repoRoot = new URL('../../../../../', import.meta.url).pathname;
const leaseLib = join(repoRoot, 'papercusp-desktop/bin/lib/windows-build-resource-lease.sh');
const producer = join(repoRoot, 'papercusp-desktop/bin/build-windows-on-vm.sh');
const migration = join(repoRoot, 'libs/papercusp/packages/locks/src/sql/019-register-windows-vm-build.sql');
const resource = 'windows-vm-build:user@127.0.0.1:2223:papercup-build-release';

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'windows-build-lease-'));
  tempDirs.push(dir);
  const state = join(dir, 'lease.json');
  const eventLog = join(dir, 'events.log');
  const fakeMcp = join(dir, 'fake-mcp.mjs');
  writeFileSync(
    fakeMcp,
    String.raw`
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const tool = argv[0];
const args = JSON.parse(argv[1] || '{}');
const clientAt = argv.indexOf('--client');
const owner = clientAt >= 0 ? argv[clientAt + 1] : 'unknown';
const statePath = process.env.PAPERCUSP_FAKE_LEASE_STATE;
const eventLog = process.env.PAPERCUSP_FAKE_LEASE_EVENTS;
const output = (value) => process.stdout.write(JSON.stringify(value));
const current = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

if (tool === 'locks:acquire_resource') {
  try {
    const row = { owner, resource: args.resource, lock_id: '11111111-1111-4111-8111-111111111111', reason: args.reason };
    writeFileSync(statePath, JSON.stringify(row), { flag: 'wx' });
    output({ ok: true, status: 'held', lock_id: row.lock_id, owner });
  } catch {
    const row = current();
    output({ ok: false, reason: 'held_exclusive', holders: row ? [row] : [] });
  }
} else if (tool === 'locks:heartbeat_resource') {
  const row = current();
  output({ ok: true, counts: { ok: row?.owner === owner ? 1 : 0, failed: row?.owner === owner ? 0 : 1 },
    results: [{ ok: row?.owner === owner, extended: row?.owner === owner }] });
} else if (tool === 'locks:release_resource') {
  const row = current();
  const released = row?.owner === owner ? 1 : 0;
  if (released) unlinkSync(statePath);
  output({ ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true, released }] });
} else if (tool === 'locks:list') {
  const row = current();
  if (row) process.stdout.write('format: toon\nok: true\nholders[1]{owner,resource}:\n  ' + row.owner + ',' + row.resource + '\n');
  else process.stdout.write('format: toon\nok: true\nholders: []\ndraining: false\n');
} else if (tool === 'events:emit' && args.announce) {
  appendFileSync(eventLog, 'announce:' + args.event + '\n');
  output({ ok: true, announced: true, event: args.event });
} else if (tool === 'events:emit') {
  appendFileSync(eventLog, 'fire:' + args.event + '\n');
  output({ ok: true, event: args.event, waiters: 0 });
} else {
  process.stderr.write('unexpected tool: ' + tool);
  process.exit(2);
}
`,
  );
  return { dir, state, eventLog, fakeMcp };
}

function envFor(f: ReturnType<typeof fixture>) {
  return {
    ...process.env,
    PAPERCUSP_WINDOWS_LEASE_MCP_CALL: f.fakeMcp,
    PAPERCUSP_FAKE_LEASE_STATE: f.state,
    PAPERCUSP_FAKE_LEASE_EVENTS: f.eventLog,
    PAPERCUSP_WINDOWS_LEASE_TTL_SEC: '30',
    PAPERCUSP_WINDOWS_LEASE_HEARTBEAT_SEC: '1',
  };
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}; output=${output}`)), 8_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(needle)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => {
      if (!output.includes(needle)) {
        clearTimeout(timer);
        reject(new Error(`holder exited ${code} before ${needle}; output=${output}`));
      }
    });
  });
}

describe('Windows VM build resource lease', () => {
  it('registers the concrete host+directory and acquires before the first VM deletion', () => {
    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain(`'${resource}'`);
    expect(sql).toContain("'enforced'");
    expect(sql).toContain("ARRAY['build-windows-on-vm']");

    const script = readFileSync(producer, 'utf8');
    expect(script).toContain('source "$HERE/lib/windows-build-resource-lease.sh"');
    expect(script.indexOf('windows_build_lease_acquire')).toBeLessThan(
      script.indexOf('RECLAIM_PS="Remove-Item -Recurse -Force'),
    );
    expect(script).toContain('trap windows_build_cleanup EXIT');
    expect(script).toContain("trap 'exit 143' TERM");
  });

  it('refuses a concurrent run before mutation and releases + latches on TERM', async () => {
    const f = fixture();
    const holder = spawn(
      'bash',
      ['-c', String.raw`
set -euo pipefail
source "$1"
cleanup() { status=$?; trap - EXIT; windows_build_lease_release; exit "$status"; }
trap cleanup EXIT
trap 'exit 143' TERM
windows_build_lease_acquire 'user@127.0.0.1' 2223 papercup-build-release 'holder build' 120
echo READY
while true; do sleep 1; done
`, 'holder', leaseLib],
      { env: envFor(f), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(holder);
    await waitForOutput(holder, 'READY');
    expect(existsSync(f.state)).toBe(true);

    const marker = join(f.dir, 'contender-mutated');
    const contender = spawnSync(
      'bash',
      ['-c', String.raw`
set -uo pipefail
source "$1"
rc=0
windows_build_lease_acquire 'user@127.0.0.1' 2223 papercup-build-release 'contender build' 120 || rc=$?
if [[ "$rc" == 0 ]]; then echo MUTATED > "$2"; windows_build_lease_release; fi
exit "$rc"
`, 'contender', leaseLib, marker],
      { env: envFor(f), encoding: 'utf8', timeout: 8_000 },
    );
    expect(contender.status).toBe(73);
    expect(existsSync(marker)).toBe(false);
    expect(contender.stderr).toContain('refusing before preflight/extract/build');

    holder.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('holder did not exit after TERM')), 8_000);
      holder.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    children.splice(children.indexOf(holder), 1);

    expect(existsSync(f.state)).toBe(false);
    const events = readFileSync(f.eventLog, 'utf8');
    expect(events).toContain('announce:windows-vm-build-released:11111111-1111-4111-8111-111111111111');
    expect(events).toContain('fire:windows-vm-build-released:11111111-1111-4111-8111-111111111111');
  }, 20_000);
});
