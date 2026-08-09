/**
 * Papercusp CONTEXT-INJECTION hook for OMP — turn-start + mid-turn parity.
 *
 * This is the omp client-native artifact for the shared injection dispatcher at
 * `apps/operator/scripts/hooks/inject/` (plan D-001, shared verbatim with
 * `codex-context-injection-parity-2026-08-09`). It is the structural equivalent
 * of claude's `userpromptsubmit-memory.sh` + `posttoolbatch-midturn-context.sh`
 * — and, like them, it is DUMB TRANSPORT. It parses no memory, builds no query,
 * and applies no budget: it hands the native event to the one dispatcher and
 * injects whatever text comes back. Everything interesting stays server-side and
 * stays fixable without reinstalling this file on every box.
 *
 * ── WHY A SUBPROCESS AND NOT AN IN-PROCESS IMPORT (deliberate; do not "fix") ──
 * OMP loads hooks IN-PROCESS (`await import()`), so importing `core.mjs`
 * directly would work and would be marginally faster. It is not what we do:
 *   1. Invoking `index.mjs` by its frozen CLI contract (argv + event JSON on
 *      stdin, payload on stdout) is the SAME code path claude and codex take.
 *      One dispatcher, one execution path, three clients — which is the whole
 *      point of D-001. An in-process import would quietly become a second path
 *      that can drift (different error handling, different timeout ownership).
 *   2. It gives us process-level fault isolation inside a client that has none.
 *      A crash, an OOM, or a hang in the dispatcher costs us an empty stdout,
 *      not a wedged omp turn.
 * The cost is one runtime start (~tens of ms) per boundary, well inside the
 * per-port budget.
 *
 * ── FAIL-SILENT IS LOAD-BEARING (D-001 invariant 1) ──
 * Every handler swallows every error and injects nothing. OMP catches handler
 * exceptions per-handler, so a throw cannot crash the session — but it DOES
 * surface an extension error to the user, and a context hook must never turn a
 * transient operator blip into a visible failure in someone's turn.
 *
 * ── WE OWN THE TIMEOUT (D-001 invariant 2; plan D-002 §f) ──
 * OMP's only bound on a handler is EXTENSION_HANDLER_TIMEOUT_MS = 30_000
 * (src/extensibility/extensions/runner.ts:72) — 12x the turn-start budget and
 * 20x mid-turn. Worse, that race only ABANDONS the handler; it does not cancel
 * the work. So the real deadline must be enforced here. `core.mjs` applies the
 * per-port HTTP timeout internally; the kill deadline below is deliberately a
 * MARGIN above it, so core's own timeout normally wins and this only fires when
 * the subprocess itself is wedged (a stalled runtime start, a hung pipe).
 *
 * ── ADDITIVE ONLY (P-003, owner standing preference 2026-06-29) ──
 * This module registers two event handlers and nothing else. It sets no model,
 * writes no config, and injects no routing — psu->omp must keep launching with
 * OMP's own default config so the owner picks the model interactively.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** D-001 ports. */
export type InjectionPort = 'turn-start' | 'mid-turn';

/** Per-port HTTP budget (D-001 invariant 2). core.mjs enforces these on the
 *  request; they are duplicated here only to derive the outer kill deadline. */
export const PORT_TIMEOUT_MS: Record<InjectionPort, number> = {
  'turn-start': 2500,
  'mid-turn': 1500,
};

/** Margin above the port budget before we SIGKILL the dispatcher. Large enough
 *  that core's own timeout wins in the normal slow-operator case (so we get its
 *  clean empty result), small enough that a wedged child can never approach
 *  omp's 30s cap. */
export const SUBPROCESS_KILL_MARGIN_MS = 1200;

/** D-001 invariant 4 — per-port kill switch. */
const KILL_SWITCH_ENV: Record<InjectionPort, string> = {
  'turn-start': 'PAPERCUSP_TURN_START_MEMORY',
  'mid-turn': 'PAPERCUSP_MID_TURN_CONTEXT',
};

/** customType for the injected entries. Stable so a session reload can filter
 *  them, and so they are distinguishable from the coord hook's messages. */
const CUSTOM_TYPE = 'papercusp-context';

/**
 * Locate the shared dispatcher entry.
 *
 * Ordered candidates, first hit wins. Exported for tests, and pure apart from
 * the existsSync probe.
 *
 * The explicit env override is first so an installer (or a test) can pin the
 * path without depending on layout. Otherwise we look next to this file — the
 * installed layout mirrors the repo (`hooks/inject/` beside `hooks/omp/`) — then
 * under PAPERCUSP_HOME, then the default ~/.papercusp.
 */
export function resolveDispatcherPath(
  env: NodeJS.ProcessEnv = process.env,
  selfDir?: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const candidates: string[] = [];
  if (env.PAPERCUSP_INJECT_DISPATCHER) candidates.push(env.PAPERCUSP_INJECT_DISPATCHER);
  if (selfDir) candidates.push(resolve(selfDir, '..', 'inject', 'index.mjs'));
  const papercuspHome = env.PAPERCUSP_HOME || join(homedir(), '.papercusp');
  candidates.push(join(papercuspHome, 'hooks', 'inject', 'index.mjs'));
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* unreadable candidate is simply not a hit */
    }
  }
  return null;
}

/** True when this boundary should spend nothing at all (D-001 invariants 3+4).
 *  Exported so the fail-silent invariants are directly assertable. */
export function shouldSkip(port: InjectionPort, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.PAPERCUSP_SID) return true;
  return env[KILL_SWITCH_ENV[port]] === 'off';
}

/**
 * Run the dispatcher for one boundary and return the text to inject.
 *
 * ALWAYS resolves — never rejects, never throws. Every failure mode (no
 * dispatcher installed, spawn error, non-zero exit, timeout, malformed output)
 * resolves to null, which the callers treat as "inject nothing".
 */
export function runDispatcher(
  port: InjectionPort,
  nativeEvent: string,
  event: unknown,
  opts: { env?: NodeJS.ProcessEnv; selfDir?: string; execPath?: string; killAfterMs?: number } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  // Testability seam only. The DEFAULT is the contract (D-001 invariant 2); a
  // caller overriding it does not relax the contract, it just lets the hang
  // path be asserted without burning the real deadline in a unit test.
  const killAfterMs = opts.killAfterMs ?? PORT_TIMEOUT_MS[port] + SUBPROCESS_KILL_MARGIN_MS;

  return new Promise<string | null>(resolvePromise => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    try {
      if (shouldSkip(port, env)) return finish(null);

      const dispatcher = resolveDispatcherPath(env, opts.selfDir);
      if (!dispatcher) return finish(null);

      let payload: string;
      try {
        payload = JSON.stringify(event ?? {});
      } catch {
        // A non-serialisable event (circular tool arguments) is no signal.
        return finish(null);
      }

      // process.execPath is the runtime already executing this hook (bun under
      // omp). Both bun and node execute a plain .mjs, so this avoids depending
      // on `node` being on PATH — which is NOT guaranteed in a desktop-launched
      // session, where PATH is whatever the launcher inherited.
      const child = spawn(opts.execPath ?? process.execPath, [dispatcher, `--client=omp`, `--event=${nativeEvent}`], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env,
      });

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(null);
      }, killAfterMs);
      // Never hold the process open on our account: a pending injection must not
      // delay omp's exit.
      killTimer.unref?.();

      let out = '';
      child.stdout.on('data', chunk => {
        out += String(chunk);
      });
      child.stdout.on('error', () => finish(null));
      child.on('error', () => {
        clearTimeout(killTimer);
        finish(null);
      });
      child.on('close', code => {
        clearTimeout(killTimer);
        // Non-zero is not an error worth surfacing — it is the dispatcher's own
        // fail-silent path reporting that it produced nothing.
        if (code !== 0) return finish(null);
        finish(out.trim() ? out : null);
      });

      try {
        child.stdin.on('error', () => finish(null));
        child.stdin.end(payload);
      } catch {
        finish(null);
      }
    } catch {
      finish(null);
    }
  });
}

/** Minimal structural view of the omp HookAPI surface this module uses. Kept
 *  local so the hook stays self-contained (it is loaded by omp, not by the
 *  operator, and must not import operator or omp types). */
interface OmpHookApi {
  on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown): void;
  sendMessage(
    message: { customType: string; content: string; display?: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' },
  ): void;
}

let selfDir: string | undefined;
try {
  selfDir = dirname(fileURLToPath(import.meta.url));
} catch {
  selfDir = undefined;
}

export default function register(pi: OmpHookApi): void {
  // TURN-START. `before_agent_start` fires after the prompt is submitted and
  // before the agent loop begins, and returning `{ message }` gets the text
  // persisted into the session and shown in the TUI — the omp analogue of
  // claude's UserPromptSubmit additionalContext.
  pi.on('before_agent_start', async (event: unknown) => {
    try {
      const text = await runDispatcher('turn-start', 'before_agent_start', event, { selfDir });
      if (!text) return;
      return { message: { customType: CUSTOM_TYPE, content: text, display: false } };
    } catch {
      // Fail-silent: a context hook must never surface an error into a turn.
      return;
    }
  });

  // MID-TURN. `turn_end` carries the whole turn's toolResults[], matching
  // claude's once-per-BATCH PostToolBatch shape (`tool_result` would fire per
  // individual call). Injected imperatively as a steer so it lands in the
  // running turn, before the agent decides what to do next — the same delivery
  // the coord hook already uses for its mid-turn messages.
  pi.on('turn_end', async (event: unknown) => {
    try {
      const text = await runDispatcher('mid-turn', 'turn_end', event, { selfDir });
      if (!text) return;
      pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: false }, { deliverAs: 'steer' });
    } catch {
      return;
    }
  });
}
