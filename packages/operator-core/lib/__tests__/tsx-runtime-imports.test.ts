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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);

/** Boot-critical package-boundary seams the host imports under tsx. */
const GUARDED_MODULES = [
  '@papercusp/chat-protocol',
  '@papercusp/operator-core/lib/operator-converse-tags',
  '@papercusp/operator-core/lib/voice-node/operator-voice-bus',
  '@papercusp/operator-core/lib/voice-node/el-convai-protocol',
];

// Run from apps/operator — the host's own cwd, so workspace resolution matches
// what `bin/hono-host.ts` sees. Skip cleanly if the monorepo layout is absent.
const OPERATOR_DIR = resolve(process.cwd(), '../../apps/operator');
const PER_MODULE_TIMEOUT_MS = 60_000;

describe.skipIf(!existsSync(OPERATOR_DIR))('tsx-runtime imports (D-007 guard)', () => {
  for (const mod of GUARDED_MODULES) {
    it(
      `loads ${mod} under the real tsx runtime`,
      async () => {
        const script = `import(${JSON.stringify(mod)}).then(()=>{console.log('TSX_IMPORT_OK')}).catch(e=>{console.error(e?.message ?? e);process.exit(1)})`;
        try {
          const { stdout } = await execFileP('npx', ['tsx', '-e', script], {
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
