/**
 * tsx-runtime import guard — catches the D-007 bug class from
 * universal-voice-interface-2026-06-05: "every test is green but the host
 * can't boot".
 *
 * Why this exists: the operator host runs under **tsx** (`bin/hono-host.ts`),
 * where a typeless `@papercusp/*` package compiles to CJS and Node's
 * `cjs-module-lexer` statically links named imports — and can fail to see
 * exports that are perfectly visible to vitest/vite (which BUNDLE, doing
 * cross-module analysis with no lexer). So `import { X } from 'pkg'` can throw
 * `does not provide an export named 'X'` ONLY at host boot, with the whole
 * vitest suite green (that exact failure shipped: `operator-converse-tags` →
 * `@papercusp/chat-protocol.parseReportBlock` killed `startOperatorVoiceHost()`
 * on every real operator until chat-protocol gained `"type":"module"`).
 *
 * The only faithful check is to load the module under REAL tsx, so each guard
 * spawns a tsx subprocess (≈1.5–2 s warm). Keep the list to boot-critical
 * package-boundary seams; do NOT add `operator-voice-host`/`…-session-deps` —
 * their `agent-tools/index` side-effect import never resolves outside a real
 * host context, so a bare import would hang, not fail informatively.
 *
 * On a break, the assertion message carries tsx's stderr (the "does not
 * provide an export named …" line names the culprit directly).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);

// EI-12473: the guard spawns tsx, and tsx opens an IPC UNIX DOMAIN SOCKET under
// os.tmpdir() (`$TMPDIR/tsx-<uid>/<pid>.pipe`) via its own createIpcServer.
// Some sandboxes — notably the cup capability_bash sandbox, whose writable tmp
// is /tmp/claude — reject `listen()`/`bind()` on AF_UNIX sockets ANYWHERE with
// EPERM (the WI-4439 class: a third-party tmp assumption vs a locked-down
// sandbox tmp). tsx then dies with `listen EPERM … .pipe` BEFORE it imports the
// guarded module, so every subtest fails with an ENVIRONMENT error, not a real
// D-007 export break — a false boot alarm. No TMPDIR helps (every dir EPERMs),
// so — exactly like the OPERATOR_DIR/TSX_CLI absence skips below — the faithful
// move is to recognize the environment as unable to run the guard and skip.
//
// Probe (never throws → skipIf always gets a clean boolean): try to bind+close
// a unix socket. Returns false on any error, true on a clean listen.
function probeUnixSocketBindable(sockPath: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const server = createServer();
    const finish = (ok: boolean) => {
      try {
        server.close();
      } catch {
        /* noop */
      }
      try {
        unlinkSync(sockPath);
      } catch {
        /* noop */
      }
      resolveProbe(ok);
    };
    server.once('error', () => finish(false));
    try {
      server.listen(sockPath, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

const CAN_BIND_UNIX_SOCKET = await probeUnixSocketBindable(
  resolve(tmpdir(), `tsx-guard-probe-${process.pid}-${Date.now()}.pipe`),
);

// Resolve the tsx CLI entry directly, rather than shelling out to `npx tsx`.
// `npx` is an npm wrapper and a PACKAGED install ships no npm/npx by design —
// so `npx tsx` there fails with `spawn npx ENOENT`, which this test's own
// catch reported as "the operator host would fail at boot" even though the
// module imports perfectly (the packaged desktop boots all its operators).
// That conflates missing-tooling with a real D-007 export break — the exact
// signal this guard exists to catch. Run tsx's CLI under THIS process's node
// (process.execPath) so no `npx`/PATH lookup is needed and the packaged node
// at sidecar/bin/node works too. If tsx can't be resolved at all, the guard
// self-skips (see TSX_CLI below) instead of firing a false boot alarm.
const TSX_CLI = (() => {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('tsx/package.json');
    const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin;
    const rel = typeof bin === 'string' ? bin : bin?.tsx;
    return rel ? resolve(dirname(pkgPath), rel) : null;
  } catch {
    return null;
  }
})();

/** Boot-critical package-boundary seams the host imports under tsx. */
const GUARDED_MODULES = [
  '@papercusp/chat-protocol',
  '@papercusp/operator-core/lib/operator-converse-tags',
  '@papercusp/operator-core/lib/voice-node/operator-voice-bus',
  '@papercusp/operator-core/lib/voice-node/el-convai-protocol',
  // EI-23094620132530174: the MCP route exports pure warning helpers, so
  // importing it under the host's real tsx runtime must not construct the
  // mcp-handler adapter or eagerly arm the full operator tool graph.
  '@papercusp/operator-core/lib/endpoint-route/routes/transport/_mcp-handler',
  // EI-8: the plan-item CLAIM write path routes through the swarm claim
  // authority → lock-authority → device-identity chain. It used to EAGERLY pull
  // in a holepunch/Hypercore CJS dep, throwing `require is not defined` under
  // tsx on :3070 while every vitest bundle stayed green (vitest bundles, the
  // host doesn't). The chain was refactored to no longer eager-load the swarm
  // layer; this guard fails if anyone re-introduces such an import.
  '@papercusp/operator-core/lib/plan-items/claim-authority-swarm',
];

// Run from apps/operator — the host's own cwd, so workspace resolution matches
// what `bin/hono-host.ts` sees. Skip cleanly if the monorepo layout is absent.
const OPERATOR_DIR = resolve(process.cwd(), '../../apps/operator');
const PER_MODULE_TIMEOUT_MS = 60_000;

describe.skipIf(!existsSync(OPERATOR_DIR) || !TSX_CLI || !CAN_BIND_UNIX_SOCKET)(
  'tsx-runtime imports (D-007 guard)',
  () => {
  for (const mod of GUARDED_MODULES) {
    it(
      `loads ${mod} under the real tsx runtime`,
      async () => {
        const script = `import(${JSON.stringify(mod)}).then(()=>{console.log('TSX_IMPORT_OK')}).catch(e=>{console.error(e?.message ?? e);process.exit(1)})`;
        try {
          const { stdout } = await execFileP(process.execPath, [TSX_CLI as string, '-e', script], {
            cwd: OPERATOR_DIR,
            timeout: PER_MODULE_TIMEOUT_MS,
          });
          expect(stdout).toContain('TSX_IMPORT_OK');
        } catch (err) {
          const e = err as { stderr?: string; stdout?: string; message?: string };
          // Surface tsx's own error (e.g. "The requested module 'x' does not
          // provide an export named 'y'") — it names the broken seam directly.
          expect.fail(
            `tsx failed to import ${mod} — the operator host would fail at boot.\n` +
              `stderr: ${(e.stderr ?? '').trim().slice(0, 600)}\n` +
              `stdout: ${(e.stdout ?? '').trim().slice(0, 200)}\nmessage: ${e.message ?? ''}`,
          );
        }
      },
      PER_MODULE_TIMEOUT_MS + 10_000,
    );
  }
});

// EI-12473 regression: the unix-socket probe is what keeps the guard from
// false-alarming in a socket-hostile sandbox. It must (a) NEVER throw — so
// describe.skipIf always receives a clean boolean instead of the collection
// phase crashing, and (b) return false on an unbindable path (the sandbox
// case → guard skips) yet true where sockets work (the dev box / green gate →
// guard runs for real).
describe('unix-socket bind probe (EI-12473 regression)', () => {
  it('returns false without throwing for an unbindable socket path', async () => {
    // A path under a directory that does not exist can never be bound; the
    // probe must swallow the error and resolve `false`, not reject.
    const bad = resolve(tmpdir(), `ei12473-nonexistent-${process.pid}-${Date.now()}`, 'x.pipe');
    await expect(probeUnixSocketBindable(bad)).resolves.toBe(false);
  });

  it.skipIf(!CAN_BIND_UNIX_SOCKET)('returns true where tmpdir supports unix sockets', async () => {
    const ok = resolve(tmpdir(), `ei12473-probe-ok-${process.pid}-${Date.now()}.pipe`);
    await expect(probeUnixSocketBindable(ok)).resolves.toBe(true);
  });
});
