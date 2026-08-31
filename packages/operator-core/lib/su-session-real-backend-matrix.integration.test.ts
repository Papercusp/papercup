/**
 * P-012 — the REAL-BACKEND acceptance matrix for the three SU backends.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT LIKE THE OTHER SU-SESSION TESTS
 * =====================================================================
 * Every other su-session test stubs the one hop that this plan item names as
 * mandatory. Concretely:
 *
 *   - su-session-{claude,codex,omp}-adapter.integration.test.ts inject
 *     `options.openSession` and feed RECORDED native protocol records. They
 *     prove TRANSLATION (native frames -> typed cards) with no process
 *     anywhere.
 *   - su-session-restart-journey.integration.test.ts (P-010) uses a real
 *     fully-migrated Postgres but says so itself: "with no agent process
 *     anywhere". It proves DURABILITY of the bindings.
 *
 * Both properties are real and both are already green. Neither one can fail if
 * the actual `psu` -> agent launch is broken, because neither one runs it. This
 * file runs it.
 *
 * THE FIVE HOPS OF A REAL SESSION (mapped from source, not assumed)
 * ----------------------------------------------------------------
 *   1. CREATE      `openPuiSuSession({ operation:'create', ... })`
 *                  (launch-agent.ts) passes `deferSpawn:true`, so it records
 *                  ONE DEFERRED adv_sessions row and SPAWNS NOTHING.
 *   2. THE ARGV    That row carries `launchArgv` — adv-sessions.ts calls it
 *                  "the exact argv the pui pane runs (a fresh `psu …`)".
 *                  In the product, apps/tui/src/mux.rs opens a pane running it
 *                  and bootstrap ADOPTS THE SAME ROW.
 *   3. MATERIALIZE Only once that process is up does a native session exist.
 *   4. ATTACH      `open<B>SuSession({ operation:'attach', advSessionId })`
 *                  resolves the native runtime and builds the adapter. Before
 *                  hop 2 it returns `native_session_not_ready` with the literal
 *                  message "attach after the deferred pane starts" — which is
 *                  the tell that a matrix skipped the spawn.
 *   5. DRIVE       ownerTurn | interrupt | resume | end.
 *
 * This file performs hop 2 headlessly. That is faithful rather than a
 * shortcut: it runs the SAME argv the pane runs, so bootstrap adopts the same
 * row by the same path. The only thing it drops is the terminal emulator.
 *
 * WHY IT IS NOT HERMETIC, AND WHY THAT IS CORRECT
 * ----------------------------------------------
 * `launch-su` is an HTTP call to the running operator, which writes to the LIVE
 * operator database. So unlike the P-010 journey this file MUST NOT mock
 * `getOrgPg` or use `createOrgTestDb` — it has to read the same rows the
 * operator just wrote. That makes it a live-system acceptance run, which is
 * precisely why it is gated below and can never join the affected/gate suites.
 *
 * RUNNING IT
 * ----------
 *   PAPERCUSP_REAL_BACKEND_MATRIX=1 \
 *   PAPERCUSP_REAL_BACKEND_MATRIX_BACKENDS=omp \
 *   PAPERCUSP_REAL_BACKEND_MATRIX_OMP_ACCOUNT=auto \
 *   PAPERCUSP_REAL_BACKEND_MATRIX_OMP_MODEL=openai-codex/gpt-5.6-terra:xhigh \
 *   PAPERCUSP_REAL_BACKEND_MATRIX_CODEX_ACCOUNT=auto \
 *   PAPERCUSP_TEST_FILE_TIMEOUT_MS=1800000 \
 *   npm run test:file -- packages/operator-core/lib/su-session-real-backend-matrix.integration.test.ts
 *
 * Select a subset with PAPERCUSP_REAL_BACKEND_MATRIX_BACKENDS=claude,codex.
 *
 * THE TIMEOUT IS NOT OPTIONAL, AND OMITTING IT FAILS IN THE WORST WAY
 * ------------------------------------------------------------------
 * scripts/test-files.mjs defaults to a 300s watchdog for the whole FILE
 * (DEFAULT_TEST_FILE_RUN_TIMEOUT_MS). This matrix budgets up to 240s of ready
 * plus 300s of turn PER BACKEND, so any run that actually waits on a slow boot
 * exceeds the default before it can reach a verdict.
 *
 * Measured 2026-08-30 on the codex+omp legs: the watchdog reaped the run at
 * 300s and reported
 *   TEST_FILE_GROUP_RESULT ... status=failed
 * while the line above it said
 *   status=timed-out — owned child tree reaped; NOT MEASURED
 * Both adv rows had by then reached live native sessions (codex
 * waiting-for-owner, omp running), so nothing was wrong with either backend.
 * A reader who takes the `status=failed` at face value concludes the backends
 * are broken; the run in fact produced NO verdict at all. Raise the timeout so
 * a red here always means a red backend.
 *
 * COST NOTE: each leg spawns a real agent and spends real tokens on the
 * configured account. Turns are deliberately single-shot and the matrix ends
 * every session it creates, then asserts the process is gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SU_SESSION_COMMAND_TYPES,
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionBackend,
  type SuSessionCommand,
  type SuSessionCommandResultEvent,
  type SuSessionCommandType,
  type SuSessionDescriptor,
  type SuSessionEvent,
  type SuSessionIdentity,
} from '@papercusp/chat-protocol';
import { launchAgent, openPuiSuSession, type PuiSuSessionBinding } from './launch-agent';
import {
  getAdvSession,
  listPendingWorkbenchLaunches,
  markAdvSessionLaunched,
  markAdvSessionEnded,
} from './adv-sessions';
import { managedSpawn, type ManagedSpawnResult } from './task-manager/managed-spawn';
import { openClaudeSuSession, resolveClaudeSuRuntime } from './su-session-claude-adapter';
import { openCodexSuSession, resolveCodexSuRuntime } from './su-session-codex-adapter';
import { openOmpSuSession, resolveOmpSuRuntime } from './su-session-omp-adapter';

// ── the gate ────────────────────────────────────────────────────────────────
// Deliberately an explicit opt-in rather than a capability probe. A probe
// ("run it if the CLIs happen to be installed") would silently enrol every
// developer machine and the gate box into spending real tokens, and a matrix
// that runs by accident is one nobody trusts the results of.
const ENABLED = process.env.PAPERCUSP_REAL_BACKEND_MATRIX === '1';

const ALL_BACKENDS = ['claude', 'codex', 'omp'] as const;
type MatrixBackend = (typeof ALL_BACKENDS)[number];

const SELECTED: readonly MatrixBackend[] = (() => {
  const raw = process.env.PAPERCUSP_REAL_BACKEND_MATRIX_BACKENDS?.trim();
  if (!raw) return ALL_BACKENDS;
  const picked = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is MatrixBackend => (ALL_BACKENDS as readonly string[]).includes(s));
  if (picked.length === 0) {
    throw new Error(
      `PAPERCUSP_REAL_BACKEND_MATRIX_BACKENDS=${raw} selected no known backend (want: ${ALL_BACKENDS.join(',')})`,
    );
  }
  return picked;
})();

const HARNESS = 'papercusp';
const OMP_MODEL = process.env.PAPERCUSP_REAL_BACKEND_MATRIX_OMP_MODEL?.trim() || 'papercusp-gateway/claude-sonnet-4-6';

/**
 * An OMP gateway model may be backed by either the Claude or Codex account
 * pool. Preserve the historical system-account default while allowing a real
 * acceptance host to select an available routed pool explicitly.
 */
const OMP_ACCOUNT = process.env.PAPERCUSP_REAL_BACKEND_MATRIX_OMP_ACCOUNT?.trim() || 'default';

/**
 * Codex's default/system route requires a local ~/.codex/auth.json. The
 * acceptance host may instead have only a gateway account, so make that route
 * an explicit matrix input while preserving the historical default for
 * provenance. This changes no product default; it only lets a run select the
 * credential path it can actually exercise.
 */
const CODEX_ACCOUNT = process.env.PAPERCUSP_REAL_BACKEND_MATRIX_CODEX_ACCOUNT?.trim() || 'default';

function accountForBackend(backend: MatrixBackend): string {
  if (backend === 'codex') return CODEX_ACCOUNT;
  if (backend === 'omp') return OMP_ACCOUNT;
  return 'default';
}

/** A real agent boot is not fast: psu resolves an account, the CLI starts, and
 *  bootstrap has to adopt the row before a native session exists. */
const READY_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 2_000;

/** The IDLE CONTROL window in the bare-launch disturbance case.
 *
 *  "The managed session was alive before the bare launch and dead after it" is
 *  not on its own evidence that the launch killed it — the session might have
 *  been going to die in that window regardless. So the case first holds it for
 *  this long with NOTHING running, which turns the later check into a
 *  comparison. Sized a little above the observed ~8s bare-launch window so the
 *  control is at least as long as the exposure it is the control FOR; the case
 *  reports both durations when it fails, so an under-sized control is visible
 *  rather than silently weakening the attribution. */
const IDLE_BASELINE_MS = 15_000;

/** A real turn is a real model call plus at least one real tool round-trip, on
 *  a session whose system prompt is the full SU playbook. Budget for that, not
 *  for a stubbed frame replay. */
const TURN_TIMEOUT_MS = 300_000;
const TURN_POLL_INTERVAL_MS = 5_000;

/**
 * The largest gap between two consecutive poll iterations that ordinary
 * slowness can still explain. Anything beyond it means this process was not
 * merely slow, it was STOPPED.
 *
 * WHY A WALL-CLOCK BUDGET IS NOT SAFE HERE (EI-21903376339103215)
 * --------------------------------------------------------------
 * pc-heavy SIGSTOPs an admitted cgroup under memory PSI. The agent pty is
 * spawned IN-PROCESS by this file (managedSpawn below), so it INHERITS that
 * cgroup and is frozen together with the test — while `Date.now()` keeps
 * advancing. The agent therefore writes nothing, the test wakes to an empty
 * transcript, and a budget that was never actually spent reads as expired.
 *
 * Measured 2026-08-30, three times independently: a 191.4s freeze inside a
 * 300s turn budget. Its signature is unmistakable — the 10s progress ticker
 * jumped 180891ms -> 372340ms with ~19 ticks missing. Across every run that
 * day the correlation was exact: the only OWNER TURN successes were in the
 * only runs with ZERO freezes, and turn durations were strictly bimodal
 * (~15s when a transcript appeared, ~300s when none did, nothing between) —
 * which is the shape of a binary was-I-stopped condition, not of load or
 * latency, both of which would smear the distribution.
 *
 * This is the header's own invariant, mechanised: "a red here always means a
 * red backend". A frozen instrument produces NO measurement, so it must
 * report NOT MEASURED — never a red that reads as a broken backend. That
 * misreading is not hypothetical: it cost two agents ~20 minutes and sent
 * them into two different wrong subsystems before the freeze was found.
 *
 * 60s is deliberately far above any legitimate iteration (one pump reads a
 * whole transcript, which under IO pressure can take tens of seconds) and far
 * below the freezes actually observed, so it cannot fire on mere slowness.
 */
const STALL_NOT_MEASURED_MS = 60_000;

/**
 * Watches for the process being STOPPED rather than merely being slow.
 *
 * Deliberately measures the WHOLE iteration (work + sleep) rather than just
 * the sleep: a freeze can land anywhere, including mid-pump, and a watch that
 * only timed its own sleep would miss exactly that case.
 */
function createStallWatch() {
  let last = Date.now();
  let maxGapMs = 0;
  return {
    tick() {
      const now = Date.now();
      const gap = now - last;
      if (gap > maxGapMs) maxGapMs = gap;
      last = now;
    },
    /** The gap only counts as a stall once it exceeds anything slowness explains. */
    stalled(): boolean {
      return maxGapMs >= STALL_NOT_MEASURED_MS;
    },
    maxGapMs(): number {
      return maxGapMs;
    },
  };
}

const RESOLVE_RUNTIME: Record<MatrixBackend, (b: PuiSuSessionBinding) => Promise<unknown | null>> = {
  claude: resolveClaudeSuRuntime,
  codex: resolveCodexSuRuntime,
  omp: resolveOmpSuRuntime,
};

// ── psu-pty discovery ───────────────────────────────────────────────────────
// apps/operator/scripts/psu-pty-host.mjs writes ~/.papercusp/psu-pty/<ownerId>.json
// = { ownerId, advSessionId, pid, ptyPid, sock, command, startedAt } for every
// live managed-pty session. The operator's wake-executor reads this same dir to
// find a session's control socket, so reading it here is the production
// discovery contract rather than a test-only backchannel.
const PSU_PTY_DIR = join(homedir(), '.papercusp', 'psu-pty');

/** This file sits at packages/operator-core/lib/, so the repo root is three up.
 *  Derived from the module URL rather than cwd: vitest's cwd is the workspace
 *  package, not the checkout, and the containment check below must run git
 *  against the checkout the operator was built from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface PsuPtyDiscovery {
  ownerId?: string;
  /** WRITTEN AS A STRING by psu-pty-host ("20811"), not a number. A `===`
   *  comparison against the numeric adv id therefore never matches, and the
   *  symptom is the worst kind: the poll silently never finds the session and
   *  the failure reads "discovery file never appeared" — i.e. it looks like the
   *  session failed to start rather than like the harness failed to look. */
  advSessionId?: number | string;
  pid?: number;
  ptyPid?: number;
  sock?: string;
  command?: string;
  startedAt?: number | string;
}

async function discoverPsuPtyByAdvSessionId(advSessionId: number): Promise<PsuPtyDiscovery | null> {
  let names: string[];
  try {
    names = await readdir(PSU_PTY_DIR);
  } catch {
    return null; // the dir only exists once a managed-pty session has run
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(join(PSU_PTY_DIR, name), 'utf8')) as PsuPtyDiscovery;
      if (Number(parsed.advSessionId) === advSessionId) return parsed;
    } catch {
      // A partially-written discovery file is normal during boot; skip it and
      // let the poll come back.
    }
  }
  return null;
}

/** POSIX single-quote quoting, so an argv element containing a space, a quote
 *  or a shell metacharacter survives the `script -c <string>` round-trip. The
 *  pane argv is machine-generated and currently tame, but silently mangling a
 *  future `--plan="two words"` into two arguments would produce a launch
 *  failure whose cause is invisible in the output. */
function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── attach + drive, as ONE shape over three genuinely different adapters ────
// The three adapters are separate classes with backend-specific runtime types
// and differently-named native readers (`consumeTranscriptSnapshot` for Claude
// and OMP, `consumeRolloutSnapshot` for Codex, over `transcriptPath` vs
// `rolloutPath`). There is no upstream union, and inventing one in production
// code to make a test tidier would be the tail wagging the dog — so the union
// is built here, explicitly, once per backend.
type MatrixCommand =
  | { type: 'owner_turn'; commandId: string; turnId: string; content: string }
  | { type: 'interrupt'; commandId: string; reason?: string }
  | {
      type: 'resume';
      commandId: string;
      cause: 'owner' | 'pui-restart' | 'runtime-replacement' | 'compaction';
    }
  | { type: 'focus'; commandId: string }
  | { type: 'end'; commandId: string; reason?: string };

interface AttachedLeg {
  /** The owner identity PUI bound to this row — the key the runtime's control
   *  socket is discovered under, so it is worth asserting rather than assuming. */
  ownerId: string;
  nativeSessionId: string;
  /** Dispatch a REAL command through the host and await its terminal result. */
  send(value: MatrixCommand): Promise<SuSessionCommandResultEvent<SuSessionBackend>>;
  /** Re-resolve the native runtime and translate whatever it has written so far
   *  into host events. A no-op until the backend has produced its first record,
   *  which is exactly the window this matrix exists to wait through. */
  pump(): Promise<void>;
  events(): readonly SuSessionEvent[];
  /** The live retention window as DATA: the event ids actually retained, plus
   *  the floor/last pair the SSE resume contract publishes. Returned as plain
   *  numbers rather than the host itself because the three hosts are
   *  generically distinct types with no upstream union. */
  retention(): { ids: readonly number[]; floorSequence: number; lastSequence: number };
  /** How many retained events a Last-Event-ID resume from `sequence` replays.
   *  The point of asking is the case where `sequence` is BELOW the floor: the
   *  host must replay only what it still holds, never fabricate the prefix it
   *  dropped. */
  recentSinceCount(sequence: number): number;
  lifecycle(): string;
  /** The full descriptor, so capability visibility and `runtimeGeneration` can
   *  be asserted against the protocol rather than inferred from behaviour. */
  descriptor(): SuSessionDescriptor<SuSessionBackend>;
  /** Re-resolve the native runtime and swap it in under the SAME identity.
   *  Reports WHICH of the three outcomes happened, so a caller can tell
   *  "replacement did not happen" from "replacement happened and changed
   *  nothing" — the two have opposite meanings for the generation assertion
   *  below — and, when it did not happen, WHY. */
  replaceRuntime(reason: string): Promise<ReplaceRuntimeOutcome>;
}

/** Why a runtime replacement did or did not happen.
 *
 *  This was a single `boolean` until 2026-08-30, and the collapse cost real
 *  time: `if (!fresh?.transcriptPath) return false` folded TWO conditions into
 *  one `false`, and the assertion then named only one of them ("no native
 *  runtime resolved"). The condition that actually fired was the OTHER one — a
 *  missing transcript file, which `resolveClaudeSuRuntime` documents as
 *  "normal before the first native turn" — so the red pointed two agents at
 *  runtime resolution, a subsystem that was working. The tell looked like a
 *  paradox: PUI RESTART/REATTACH passed in the SAME leg seconds later,
 *  adopting the very runtime this guard called unresolvable.
 *
 *  A guard that collapses two conditions and then names one of them is a false
 *  alarm, and a false alarm is a bug in the alarm. */
type ReplaceRuntimeOutcome =
  /** The native runtime resolved and was swapped in under the same identity. */
  | 'replaced'
  /** No native runtime could be resolved AT ALL — wrong backend, no
   *  adv-session row, or no materialisable native handle. A real defect in
   *  runtime resolution. */
  | 'no-runtime'
  /** The runtime resolved fine, but its native record file (Claude/OMP
   *  transcript, Codex rollout) is absent on disk. Expected before the
   *  backend's first native turn; NOT a resolution failure. */
  | 'no-record';

type AttachOutcome = { ok: true; leg: AttachedLeg } | { ok: false; code: string; error: string };

function buildCommand<B extends SuSessionBackend>(
  identity: SuSessionIdentity<B>,
  value: MatrixCommand,
): SuSessionCommand<B> {
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    issuedAt: new Date().toISOString(),
    target: identity,
    ...value,
  } as SuSessionCommand<B>;
}

const ATTACH: Record<MatrixBackend, (advSessionId: number, agentChatId: string) => Promise<AttachOutcome>> = {
  claude: async (advSessionId, agentChatId) => {
    const opened = await openClaudeSuSession(
      { operation: 'attach', backend: 'claude', advSessionId, harnessSlug: HARNESS },
      { agentChatId },
    );
    if (!opened.ok) return { ok: false, code: opened.code, error: opened.error };
    const { adapter, binding } = opened;
    return {
      ok: true,
      leg: {
        ownerId: binding.ownerId ?? '',
        nativeSessionId: adapter.host.descriptor().identity.nativeSessionId,
        send: (value) => adapter.host.startCommand(buildCommand(adapter.host.descriptor().identity, value)).terminal,
        pump: async () => {
          const fresh = await resolveClaudeSuRuntime(binding);
          if (!fresh?.transcriptPath) return;
          // replaceRuntime resets the parser, so re-reading the whole transcript
          // each pump is a clean re-translation rather than a double-ingest.
          adapter.replaceRuntime(fresh, 'matrix native pump');
          await adapter.consumeTranscriptSnapshot();
        },
        events: () => adapter.host.recent.map((entry) => entry.event),
        retention: () => {
          const snapshot = adapter.host.snapshot();
          return {
            ids: adapter.host.recent.map((entry) => entry.id),
            floorSequence: snapshot.floorSequence,
            lastSequence: snapshot.lastSequence,
          };
        },
        recentSinceCount: (sequence: number) => adapter.host.recentSince(sequence).length,
        lifecycle: () => adapter.host.descriptor().lifecycle,
        descriptor: () => adapter.host.descriptor(),
        replaceRuntime: async (reason) => {
          const fresh = await resolveClaudeSuRuntime(binding);
          if (!fresh) return 'no-runtime';
          if (!fresh.transcriptPath) return 'no-record';
          adapter.replaceRuntime(fresh, reason);
          return 'replaced';
        },
      },
    };
  },
  codex: async (advSessionId, agentChatId) => {
    const opened = await openCodexSuSession(
      { operation: 'attach', backend: 'codex', advSessionId, harnessSlug: HARNESS },
      { agentChatId },
    );
    if (!opened.ok) return { ok: false, code: opened.code, error: opened.error };
    const { adapter, binding } = opened;
    return {
      ok: true,
      leg: {
        ownerId: binding.ownerId ?? '',
        nativeSessionId: adapter.host.descriptor().identity.nativeSessionId,
        send: (value) => adapter.host.startCommand(buildCommand(adapter.host.descriptor().identity, value)).terminal,
        pump: async () => {
          const fresh = await resolveCodexSuRuntime(binding);
          if (!fresh?.rolloutPath) return;
          adapter.replaceRuntime(fresh, 'matrix native pump');
          await adapter.consumeRolloutSnapshot();
        },
        events: () => adapter.host.recent.map((entry) => entry.event),
        retention: () => {
          const snapshot = adapter.host.snapshot();
          return {
            ids: adapter.host.recent.map((entry) => entry.id),
            floorSequence: snapshot.floorSequence,
            lastSequence: snapshot.lastSequence,
          };
        },
        recentSinceCount: (sequence: number) => adapter.host.recentSince(sequence).length,
        lifecycle: () => adapter.host.descriptor().lifecycle,
        descriptor: () => adapter.host.descriptor(),
        replaceRuntime: async (reason) => {
          const fresh = await resolveCodexSuRuntime(binding);
          if (!fresh) return 'no-runtime';
          if (!fresh.rolloutPath) return 'no-record';
          adapter.replaceRuntime(fresh, reason);
          return 'replaced';
        },
      },
    };
  },
  omp: async (advSessionId, agentChatId) => {
    const opened = await openOmpSuSession(
      { operation: 'attach', backend: 'omp', advSessionId, harnessSlug: HARNESS },
      { agentChatId },
    );
    if (!opened.ok) return { ok: false, code: opened.code, error: opened.error };
    const { adapter, binding } = opened;
    return {
      ok: true,
      leg: {
        ownerId: binding.ownerId ?? '',
        nativeSessionId: adapter.host.descriptor().identity.nativeSessionId,
        send: (value) => adapter.host.startCommand(buildCommand(adapter.host.descriptor().identity, value)).terminal,
        pump: async () => {
          const fresh = await resolveOmpSuRuntime(binding);
          if (!fresh?.transcriptPath) return;
          adapter.replaceRuntime(fresh, 'matrix native pump');
          await adapter.consumeTranscriptSnapshot();
        },
        events: () => adapter.host.recent.map((entry) => entry.event),
        retention: () => {
          const snapshot = adapter.host.snapshot();
          return {
            ids: adapter.host.recent.map((entry) => entry.id),
            floorSequence: snapshot.floorSequence,
            lastSequence: snapshot.lastSequence,
          };
        },
        recentSinceCount: (sequence: number) => adapter.host.recentSince(sequence).length,
        lifecycle: () => adapter.host.descriptor().lifecycle,
        descriptor: () => adapter.host.descriptor(),
        replaceRuntime: async (reason) => {
          const fresh = await resolveOmpSuRuntime(binding);
          if (!fresh) return 'no-runtime';
          if (!fresh.transcriptPath) return 'no-record';
          adapter.replaceRuntime(fresh, reason);
          return 'replaced';
        },
      },
    };
  },
};

/** Text of every transcript delta for one role. The event ring is bounded
 *  (1024) and a pump re-emits the whole native record set, so callers must fold
 *  these into STICKY evidence rather than scanning once at the end. */
function transcriptText(events: readonly SuSessionEvent[], role: 'owner' | 'assistant' | 'system'): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.type !== 'transcript' || event.phase !== 'delta') continue;
    if (event.role !== role || !event.content) continue;
    out.push(event.content);
  }
  return out;
}

function completedTools(events: readonly SuSessionEvent[]): { name: string; output: string; isError: boolean }[] {
  const out: { name: string; output: string; isError: boolean }[] = [];
  for (const event of events) {
    if (event.type !== 'tool' || event.phase !== 'completed') continue;
    out.push({
      name: event.name,
      output: typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? null),
      isError: event.isError,
    });
  }
  return out;
}

// ── per-leg bookkeeping, so teardown can never leak a real agent ────────────
interface LiveLeg {
  backend: MatrixBackend;
  advSessionId: number;
  spawned: ManagedSpawnResult | null;
}
const liveLegs: LiveLeg[] = [];

/**
 * The operator this matrix drives its CREATE hop against.
 *
 * WHY THIS IS PINNED, AND WHY THE DEFAULT IS :3170 RATHER THAN :3070
 * -----------------------------------------------------------------
 * `launchAgent` reaches launch-su over HTTP, and its endpoint list is
 * same-origin -> :3070 -> :3055. Under vitest there is no `window`, so the
 * same-origin branch is skipped and CREATE silently lands on :3070 — the
 * RELEASE checkout, pinned to green `main`. Measured 2026-08-30, with the gate
 * red for ~10 days, :3070 was serving code ~2.5 days behind staging.
 *
 * That made this file a HYBRID and nobody could see it: CREATE ran deployed
 * code over HTTP while SPAWN/ATTACH/OWNER-TURN ran the working tree in-process.
 * The trap is not that it fails — it is that it PASSES. The D-014 parity guard
 * below asserts the selected `--account=` on the argv :3070 produced, so it would
 * have certified a fix that was never in the operator it tested.
 *
 * So: pin the operator, and PROVE it carries this tree's launch-su before
 * spending a single real token.
 */
const MATRIX_OPERATOR_BASE = (process.env.PAPERCUSP_OPERATOR_BASE?.trim() || 'http://localhost:3170').replace(
  /\/+$/,
  '',
);

/** The path whose identity decides whether a CREATE result means anything. */
const CREATE_PATH_UNDER_TEST = 'packages/operator-core/lib/endpoint-route/routes/adv/launch-su.ts';

function gitOut(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  // Fail loudly rather than quietly addressing the wrong database: every hop
  // below reads rows the live operator wrote.
  if (!process.env.PAPERCUSP_WORKSPACE_ID) process.env.PAPERCUSP_WORKSPACE_ID = 'papercusp-workspace';

  // Make launchSuEndpoints() resolve to the pinned operator instead of falling
  // through to :3070. This is the ONLY reason CREATE addresses the tree under
  // test; without it the fallback order decides, silently.
  process.env.PAPERCUSP_OPERATOR_BASE = MATRIX_OPERATOR_BASE;

  const health = await fetch(`${MATRIX_OPERATOR_BASE}/api/health`).catch((e: unknown) => {
    throw new Error(
      `matrix operator ${MATRIX_OPERATOR_BASE} is unreachable (${String(e)}). ` +
        'Start/restart it (dev:restart { target:"staging" }) — do NOT let this fall back to ' +
        ':3070, which serves green `main` and would certify code that is not under test.',
    );
  });
  if (!health.ok) {
    throw new Error(`matrix operator ${MATRIX_OPERATOR_BASE} answered HTTP ${health.status}`);
  }
  const body = (await health.json()) as { sha?: string };
  const servingSha = body.sha?.trim();
  if (!servingSha) {
    throw new Error(`matrix operator ${MATRIX_OPERATOR_BASE} reported no sha; cannot prove what it runs`);
  }

  // CONTAINMENT, not recency: compare the BLOB the serving commit has for the
  // create path against this working tree's. Equal blobs mean the operator is
  // executing the same launch-su this run is about to make claims about. A
  // timestamp or a commit-distance check cannot answer that question.
  const servingBlob = gitOut(['rev-parse', '--verify', '--quiet', `${servingSha}:${CREATE_PATH_UNDER_TEST}`]);
  const treeBlob = gitOut(['hash-object', CREATE_PATH_UNDER_TEST]);
  if (!servingBlob || !treeBlob) {
    throw new Error(
      `cannot resolve ${CREATE_PATH_UNDER_TEST} at serving sha ${servingSha} ` +
        `(serving=${servingBlob ?? 'unresolved'} tree=${treeBlob ?? 'unresolved'}). ` +
        'Refusing to run: an unprovable operator identity is exactly the silent-mismatch case.',
    );
  }
  if (servingBlob !== treeBlob) {
    throw new Error(
      `matrix operator ${MATRIX_OPERATOR_BASE} (sha ${servingSha}) is running a DIFFERENT ` +
        `${CREATE_PATH_UNDER_TEST} than this working tree (serving blob ${servingBlob}, tree blob ${treeBlob}). ` +
        'Its CREATE result would not describe the code under test. Restart that operator onto this tree ' +
        '(dev:restart { target:"staging", confirm:true, authorize:true }) and re-run.',
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[matrix] CREATE hop pinned to ${MATRIX_OPERATOR_BASE} @${servingSha} — ` +
      `${CREATE_PATH_UNDER_TEST} blob ${treeBlob} matches this tree.`,
  );
});

afterAll(async () => {
  // Orphan-freeness is an ASSERTION of this matrix (see the reconciliation
  // test), but it is also a teardown obligation: a leaked leg is a real agent
  // burning real tokens on someone's account until a human notices.
  for (const leg of liveLegs) {
    const child = leg.spawned?.child;
    if (child && child.pid && pidAlive(child.pid)) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  if (liveLegs.length > 0) await delay(1_000);
  for (const leg of liveLegs) {
    const pid = leg.spawned?.child?.pid;
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  // End every row this matrix created. A workbench row left un-ended keeps
  // reading as a LIVE session to the roster and to the next launch's freshness
  // guard, so a failed leg would otherwise poison later runs rather than just
  // failing itself. markAdvSessionEnded only stamps an unset ended_at.
  for (const leg of liveLegs) {
    try {
      await markAdvSessionEnded(leg.advSessionId, null, 'reconciler');
    } catch {
      /* the row may already be terminal */
    }
  }
});

describe.skipIf(!ENABLED)('SU-session real-backend acceptance matrix', () => {
  describe.each(SELECTED)('%s', (backend) => {
    let advSessionId = 0;
    let launchArgv: string[] = [];
    let binding: PuiSuSessionBinding | null = null;
    let spawned: ManagedSpawnResult | null = null;
    /** Last bounded pane output, retained across cases so a later drive failure
     *  reports the native TUI state instead of only "no transcript". */
    let paneOutput = '';
    let leg: LiveLeg;
    let attached: AttachedLeg | null = null;
    /** What the END hop actually returned, so reconciliation can judge the
     *  session against what really happened rather than assuming end worked. */
    let endOutcome: string | null = null;

    it('CREATE: records exactly one deferred row carrying the pane argv, and spawns nothing', async () => {
      const opened = await openPuiSuSession({
        operation: 'create',
        backend: backend as SuSessionBackend,
        carry: 'warm',
        slug: HARNESS,
        account: accountForBackend(backend),
        // The machine's historical OMP default may point at a retired remote
        // model. An acceptance matrix must exercise the session transport, not
        // accidentally certify whichever mutable model id happens to be saved
        // in ~/.omp today. Use the per-session gateway model the launcher
        // already materializes; callers can override it explicitly.
        ...(backend === 'omp' ? { model: OMP_MODEL } : {}),
      });

      // A failure here is an infrastructure verdict, not a flake — say which.
      expect(opened.ok, `launch-su refused to create a ${backend} session: ${opened.ok ? '' : opened.error}`).toBe(
        true,
      );
      if (!opened.ok) return;

      binding = opened.session;
      advSessionId = binding.advSessionId;
      expect(advSessionId).toBeGreaterThan(0);
      expect(binding.backend).toBe(backend);

      leg = { backend, advSessionId, spawned: null };
      liveLegs.push(leg);

      const row = await getAdvSession(advSessionId);
      expect(row, `adv row ${advSessionId} should exist immediately after create`).toBeTruthy();
      expect(row!.agent).toBe(backend);

      // The whole point of hop 1: a deferred create must NOT have a process.
      expect(
        pidAlive(row!.pid),
        `create must not spawn — adv row ${advSessionId} already has live pid ${row!.pid}`,
      ).toBe(false);

      // And it must hand the pane something to run.
      expect(
        Array.isArray(row!.launchArgv) && row!.launchArgv!.length > 0,
        `deferred row ${advSessionId} carries no launchArgv for the pane to run`,
      ).toBe(true);
      launchArgv = row!.launchArgv!;
      expect(launchArgv[0]).toMatch(/psu/);
      expect(
        launchArgv,
        `deferred ${backend} row ${advSessionId} omitted --account=${accountForBackend(backend)}; ` +
          'bootstrap-su may reinterpret the PUI launch through the inference gateway',
      ).toContain(`--account=${accountForBackend(backend)}`);
    }, 120_000);

    it(
      'SPAWN + READY: claiming the row then running the pane argv materialises a native session on the SAME row',
      async () => {
        expect(advSessionId, 'CREATE must have produced a row').toBeGreaterThan(0);
        expect(launchArgv.length, 'CREATE must have produced an argv').toBeGreaterThan(0);

        // THE CLAIM — this is not bookkeeping, it is load-bearing, and running the
        // argv without it is the failure this matrix found on its first real run.
        //
        // bootstrap-su's pre-pinned-owner guard admits a workbench row as a launch
        // PRECURSOR only when PUI has already claimed it (`launched_at` set). An
        // UNCLAIMED workbench row is classified as the split-identity case and
        // refused with a 409:
        //   "owner_id <sid> is already bound to live adv session <id>
        //    — pre-pinned owners must be fresh [live rows: <id>(display=workbench,session=none)]"
        // psu then exits 1 within ~2s. So "the pane runs the row's argv" is only
        // the second half of hop 2; `markAdvSessionLaunched` is the first half, and
        // adv-sessions.test.ts names it exactly: "the server-side claim PUI wins
        // BEFORE opening the pane."
        const claimed = await markAdvSessionLaunched(advSessionId);
        expect(
          claimed,
          `PUI's server-side claim on workbench row ${advSessionId} did not stamp launched_at; ` +
            'psu will refuse the launch as an unclaimed workbench row',
        ).toBe(true);

        // THE PANE ARGV NEEDS A TTY, AND THAT IS NOT AN INCIDENTAL DETAIL.
        //
        // Run this argv with piped stdio and psu gets all the way through the
        // claim, gateway account routing and "session <id>" — then the agent CLI
        // sees a non-TTY stdin, falls back to non-interactive --print mode, and
        // dies immediately:
        //   Warning: no stdin data received in 3s, proceeding without it.
        //   Error: Input must be provided either through stdin or as a prompt
        //          argument when using --print
        // In the product the pane IS a terminal, so the interactive path is the
        // only one that ever runs. `script -qfec` is the faithful headless
        // equivalent: it allocates a real pty and runs the argv inside it, which
        // is what a terminal emulator does and nothing more.
        const ptyCommand = shellQuote(launchArgv);
        spawned = await managedSpawn('script', ['-qfec', ptyCommand, '/dev/null'], {
          class: 'agent-session',
          title: `p012 real-backend matrix — ${backend} adv:${advSessionId}`,
          // Provenance is the point of the ledger: record what is ACTUALLY
          // running (the pty wrapper), and keep the pane argv beside it so a
          // stray row in processes:list is traceable to this matrix and its leg.
          argv: ['script', '-qfec', ptyCommand, '/dev/null'],
          harnessSlug: HARNESS,
          launchedBy: 'test:su-session-real-backend-matrix',
          detail: { backend, advSessionId, planItem: 'P-012', paneArgv: launchArgv },
        });
        leg.spawned = spawned;

        expect(spawned.child.pid, 'the pane argv produced no pid').toBeTruthy();

        // Capture the child's own output. Without this a failed launch reports
        // only "exited (code 1)", which is a symptom with the cause thrown away —
        // and the cause is the entire value of running the real argv.
        paneOutput = '';
        const capture = (chunk: Buffer | string) => {
          paneOutput += String(chunk);
          if (paneOutput.length > 8_000) paneOutput = paneOutput.slice(-8_000);
        };
        spawned.child.stdout?.on('data', capture);
        spawned.child.stderr?.on('data', capture);

        // Poll for the native session to materialise. Two independent signals:
        // the psu-pty discovery file (production wake-path contract) and the
        // adapter's own runtime resolution (what PUI attach actually needs).
        const deadline = Date.now() + READY_TIMEOUT_MS;
        let discovery: PsuPtyDiscovery | null = null;
        let runtime: unknown = null;
        let exited: number | null = null;
        spawned.child.on('exit', (code) => {
          exited = code ?? -1;
        });

        // READINESS IS NOT "THE ROW HAS A SESSION ID".
        //
        // The first version of this test broke on exactly that. psu pre-pins the
        // native session id and writes it to the adv row at launch REGISTRATION —
        // before the agent process is up — so `resolve<B>SuRuntime` returns a
        // runtime almost immediately. The test went green in 2.1s having proved
        // only that psu registered an id: the row showed session_id set, pid null,
        // and ended 2.7s later by this file's own teardown signal. A matrix whose
        // whole purpose is to run the real backend must not accept a registration
        // record as evidence that a backend is running.
        //
        // So readiness here is the operator's OWN definition of an injectable live
        // session: the psu-pty host has published its discovery file AND the pid in
        // it is alive. That is the same signal the wake-executor requires before it
        // will inject a turn, and it cannot be satisfied by a row write.
        let discoveredAlive = false;
        while (Date.now() < deadline) {
          if (exited !== null) break;
          discovery = (await discoverPsuPtyByAdvSessionId(advSessionId)) ?? discovery;
          const row = await getAdvSession(advSessionId);
          if (row) {
            runtime = await RESOLVE_RUNTIME[backend]({
              ...(binding as PuiSuSessionBinding),
              advSessionId,
            });
          }
          discoveredAlive = Boolean(discovery && pidAlive(discovery.pid));
          if (runtime && discoveredAlive) break;
          await delay(POLL_INTERVAL_MS);
        }

        expect(
          exited,
          `the ${backend} pane argv exited (code ${exited}) before a native session materialised.\n` +
            `  argv: ${launchArgv.join(' ')}\n` +
            `  child output (last 8k):\n${paneOutput || '(the child wrote nothing at all)'}`,
        ).toBeNull();

        expect(
          runtime,
          `no native ${backend} runtime resolved on adv row ${advSessionId} within ${READY_TIMEOUT_MS}ms. ` +
            'This is the hop every other su-session test stubs, so a failure here is real.',
        ).toBeTruthy();

        // The load-bearing half. Keep this assertion separate from the runtime one
        // so a failure says WHICH property is missing: "psu registered an id but no
        // live pty host appeared" is a completely different defect from "no runtime
        // resolved at all", and collapsing them is what produced the false green.
        expect(
          discoveredAlive,
          `no LIVE psu-pty host for adv row ${advSessionId} within ${READY_TIMEOUT_MS}ms — ` +
            `discovery file ${discovery ? `found (pid ${discovery.pid}, dead)` : 'never appeared'}. ` +
            'A resolved runtime alone only proves psu REGISTERED a native session id at launch; ' +
            'it does not prove a backend process is up and injectable.',
        ).toBe(true);

        expect(
          pidAlive(spawned.child.pid),
          `the ${backend} pane process died after registering its session; child output:\n${paneOutput}`,
        ).toBe(true);
      },
      READY_TIMEOUT_MS + 60_000,
    );

    it('ATTACH: the canonical PUI attach entry resolves the live native runtime and builds a driveable adapter', async () => {
      expect(advSessionId, 'SPAWN must have produced a row').toBeGreaterThan(0);

      const outcome = await ATTACH[backend](advSessionId, `p012-matrix-${advSessionId}`);
      expect(
        outcome.ok,
        outcome.ok
          ? ''
          : `attach on adv row ${advSessionId} refused with ${outcome.code}: ${outcome.error}. ` +
              'A `native_session_not_ready` here would mean the pane never materialised a native session — ' +
              'i.e. the SPAWN hop went green on something weaker than a running backend.',
      ).toBe(true);
      if (!outcome.ok) return;
      attached = outcome.leg;

      // The owner id PUI bound is the key the runtime's control socket is
      // discovered under, and the owner turn below injects through exactly that
      // key. Assert it here, where a missing identity is one line of output,
      // rather than letting it resurface as an unexplained delivery refusal.
      expect(attached.ownerId, 'attach produced no ownerId to address the runtime by').toBeTruthy();
      expect(attached.nativeSessionId, 'attach produced no native session id').toBeTruthy();
      expect(attached.lifecycle(), 'an attached adapter should present a ready session').toBe('ready');
    }, 120_000);

    it(
      'OWNER TURN: a real turn reaches the agent, streams a response back, and produces a real tool invocation and result',
      async (ctx) => {
        expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
        if (!attached) return;
        const session = attached;

        // THE NONCE IS THE POINT.
        //
        // A session that has just booted writes plenty to its transcript on its
        // own, so "an assistant message exists" and "a tool ran" are both
        // satisfiable by boot noise. Every assertion below is therefore scoped to
        // a value that cannot have existed before this turn was composed — which
        // is what separates "a tool ran" from "the tool WE asked for ran".
        const nonce = `P012-${randomUUID().slice(0, 8).toUpperCase()}`;
        const prompt =
          `Acceptance probe ${nonce}. Do exactly two things and nothing else: ` +
          `(1) run the shell command: echo ${nonce} ` +
          '(2) then reply with only the word ACKNOWLEDGED. ' +
          'Do not claim work items, do not declare intent, do not arm a loop.';

        const result = await session.send({
          type: 'owner_turn',
          commandId: `owner-${nonce}`,
          turnId: `p012-turn-${nonce}`,
          content: prompt,
        });
        expect(
          result.status,
          `the ${backend} runtime refused the owner turn: ${JSON.stringify(result)}. ` +
            'A refusal here is a delivery failure at the control socket — the model never saw the prompt.',
        ).toBe('completed');

        // Fold STICKY evidence. The host event ring is bounded and each pump
        // re-emits the whole native record set, so a single scan at the end can
        // legitimately miss an early record on a long transcript.
        let sawOwnerEcho = false;
        let sawNonceInToolResult = false;
        let assistantText = '';
        let toolsSeen: { name: string; output: string; isError: boolean }[] = [];

        const deadline = Date.now() + TURN_TIMEOUT_MS;
        const stall = createStallWatch();
        let turnComplete = false;
        while (Date.now() < deadline) {
          await session.pump();
          const events = session.events();
          if (!sawOwnerEcho) sawOwnerEcho = transcriptText(events, 'owner').some((text) => text.includes(nonce));
          const assistant = transcriptText(events, 'assistant').join('\n');
          if (assistant.length > assistantText.length) assistantText = assistant;
          const completed = completedTools(events);
          if (completed.length > toolsSeen.length) toolsSeen = completed;
          if (!sawNonceInToolResult) sawNonceInToolResult = completed.some((tool) => tool.output.includes(nonce));
          if (sawOwnerEcho && assistantText && sawNonceInToolResult) {
            turnComplete = true;
            break;
          }
          await delay(TURN_POLL_INTERVAL_MS);
          stall.tick();
        }

        // ── WAS THE INSTRUMENT STOPPED? ────────────────────────────────────────
        // Order matters: this runs BEFORE the assertions, because a frozen run
        // produces exactly the evidence those assertions read as a broken
        // backend — an empty transcript and an expired budget. Asserting first
        // and explaining afterwards is how a stopped instrument gets reported as
        // a product defect.
        //
        // The guard is deliberately narrow. It fires ONLY when the turn did not
        // complete AND a gap appeared that slowness cannot explain, so a freeze
        // during a turn that still succeeded stays a pass, and an ordinary
        // failure on a healthy host stays a red.
        if (!turnComplete && stall.stalled()) {
          const stalledFor = Math.round(stall.maxGapMs() / 1000);
          // console.LOG, not warn. This repo runs `vitest-fail-on-console`, which
          // turns any unasserted console.warn into a hard test FAILURE — including
          // one emitted on the way to ctx.skip(), because the flush runs in an
          // afterEach that a runtime skip does not cancel. A warn here would
          // therefore convert "the host was under memory pressure, so this was not
          // measured" into "the backend is broken": a false RED blaming the
          // product for an instrument outage, which is the exact defect class this
          // guard exists to report. Keep the diagnostic loud in the log and let
          // the skip be a skip.
          // eslint-disable-next-line no-console
          console.log(
            `[matrix] NOT MEASURED — ${backend} OWNER TURN: this process lost ${stalledFor}s to a ` +
              `single stall inside its ${TURN_TIMEOUT_MS}ms budget. The agent pty shares this ` +
              'cgroup, so it was stopped too and could not write a transcript. That is an ' +
              'instrument outage, not a backend failure — re-run when the host is not under ' +
              'memory pressure (EI-21903376339103215).',
          );
          ctx.skip();
          return;
        }

        const diagnostic =
          `\n  tools observed: ${toolsSeen.map((t) => `${t.name}${t.isError ? '(error)' : ''}`).join(', ') || '(none)'}` +
          `\n  assistant text (first 400): ${assistantText.slice(0, 400) || '(none)'}` +
          `\n  pane output (last 8k): ${paneOutput || '(none)'}`;

        // Four separate assertions, because these are four different defects and
        // collapsing them is what produced the earlier false green: a delivered
        // prompt that the agent never persisted, a persisted prompt with no
        // answer, an answer with no tool use, and a tool that ran something other
        // than what was asked, all fail differently and are fixed differently.
        expect(
          sawOwnerEcho,
          `the owner turn was acked by the ${backend} control socket but never appeared in the native ` +
            `transcript within ${TURN_TIMEOUT_MS}ms. The injection reached the pty and stopped there.${diagnostic}`,
        ).toBe(true);

        expect(
          assistantText.length,
          `the ${backend} agent persisted the prompt but streamed no assistant response back.${diagnostic}`,
        ).toBeGreaterThan(0);

        expect(
          toolsSeen.length,
          `the ${backend} agent answered without invoking any tool, so this turn proves nothing about ` +
            `real tool invocation/result translation.${diagnostic}`,
        ).toBeGreaterThan(0);

        expect(
          sawNonceInToolResult,
          `no completed tool result carried ${nonce}, so a tool ran but not the one this turn asked for — ` +
            `the tool-result translation is unproven for ${backend}.${diagnostic}`,
        ).toBe(true);
      },
      TURN_TIMEOUT_MS + 60_000,
    );

    // ── steering and retirement ───────────────────────────────────────────
    // Everything above proves a session can be created, started, attached and
    // driven ONCE. WI-287139 also requires that it can be STEERED and RETIRED.
    // The conditions below deliberately run against the SAME live session, in
    // lifecycle order, because identity stability is only meaningful as a
    // property of one continuous session — asserting it across three freshly
    // created ones would prove nothing and cost three times the tokens.

    it('CAPABILITY VISIBILITY: every protocol command has a declared support state, and an unsupported one is REFUSED rather than silently imitated', async () => {
      expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
      if (!attached) return;
      const session = attached;

      const commands = session.descriptor().capabilities.commands;

      // VISIBILITY: a missing entry is the defect this asserts against. An
      // undefined support state reads as falsy at every call site, so a command
      // silently becomes "not supported" without anyone declaring it so.
      for (const type of SU_SESSION_COMMAND_TYPES) {
        expect(
          commands[type],
          `${backend} declares no capability entry for '${type}'; ` +
            'an absent entry is indistinguishable from an unsupported one at the call site.',
        ).toBeTruthy();
        expect(commands[type].state, `${backend} capability '${type}' has no state`).toMatch(
          /^(supported|conditional|unsupported)$/,
        );
      }

      // NO PROVIDER-ONLY FALLBACK. The protocol deliberately omits a
      // "simulated" support value: "unsupported backend behavior must remain
      // visible instead of being silently imitated". So a command this backend
      // does not support must come back REFUSED — an `accepted`/`completed` for
      // an unsupported command is the fallback this condition forbids.
      const unsupported = (SU_SESSION_COMMAND_TYPES as readonly SuSessionCommandType[]).find(
        (type) => commands[type].state === 'unsupported',
      );

      if (!unsupported) {
        // Nothing to falsify against on this backend — record that explicitly
        // rather than letting a vacuous pass look like a proven refusal path.
        expect(
          Object.values(commands).every((support) =>
            support.state === 'unsupported'
              ? true
              : support.implementation === 'native' || support.implementation === 'host',
          ),
          `${backend} declares a supported command with no native/host implementation`,
        ).toBe(true);
        return;
      }

      // `focus` is the only command with no required payload, so it is the only
      // one that can be probed generically. Anything else would need a
      // backend-specific body and would be testing the payload, not the refusal.
      if (unsupported !== 'focus') return;

      const refusal = await session.send({ type: 'focus', commandId: `cap-${randomUUID().slice(0, 8)}` });
      expect(
        refusal.status,
        `${backend} declares 'focus' unsupported but the host did not refuse it ` +
          `(status=${refusal.status}). An unsupported command that reports success is a ` +
          'provider-only fallback — the exact silent imitation the protocol forbids.',
      ).toBe('refused');
    }, 60_000);

    it('EVENT ORDERING: sequence numbers are strictly increasing across the whole live session', async () => {
      expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
      if (!attached) return;

      await attached.pump();
      const sequences = attached.events().map((event) => event.sequence);
      expect(sequences.length, 'the session produced no events at all, so ordering is unproven').toBeGreaterThan(0);

      // The protocol says "strictly increasing within one durable session,
      // INCLUDING RECONNECTS". A pump re-resolves and replaces the runtime, so
      // this has already survived at least one replacement by the time it runs.
      const outOfOrder: string[] = [];
      for (let i = 1; i < sequences.length; i += 1) {
        if (sequences[i] <= sequences[i - 1]) {
          outOfOrder.push(`index ${i}: ${sequences[i - 1]} -> ${sequences[i]}`);
        }
      }
      expect(
        outOfOrder,
        `${backend} emitted non-increasing sequence numbers: ${outOfOrder.slice(0, 5).join('; ')}. ` +
          'A consumer that de-dupes or resumes on sequence would silently drop or replay events.',
      ).toEqual([]);
    }, 60_000);

    it('EVENT BACKPRESSURE: retention is bounded, and whatever it drops is REPORTED rather than silently missing', async () => {
      expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
      if (!attached) return;
      const session = attached;

      // WHAT BACKPRESSURE MEANS HERE — read from the host, not assumed.
      // su-session-host.ts opens its channel with `ringSize: replaySize ?? 1024`
      // ("Retained events available to Last-Event-ID reconnects") alongside
      // `subscriberQueueSize: 4096` ("Per-live-client queue before the shared
      // SSE layer closes/replays"). So a slow consumer NEVER blocks the live
      // runtime: retention is capped and the OLDEST events fall out.
      //
      // A bounded ring that drops silently is indistinguishable from a lost
      // event, so the property that actually matters is the one the SSE route
      // publishes beside the replay: `resumeBounds: { floorId:
      // snapshot.floorSequence, maxId: snapshot.lastSequence }`. A client
      // resuming below the floor can SEE that its position is unreachable and
      // resync. That legibility is the same contract shape as a conditional
      // command's refusal — loss is permitted, SILENT loss is not.
      //
      // Overflow is forced with pumps rather than turns: a pump re-resolves the
      // runtime and re-emits the WHOLE native record set (see transcriptText),
      // so it costs one transcript re-read and no agent tokens.
      const RING = 1024; // su-session-host.ts: `ringSize: options.replaySize ?? 1024`

      const before = session.retention();
      expect(before.ids.length, 'the session retained no events at all, so retention is unproven').toBeGreaterThan(0);

      // Bounded in BOTH dimensions on purpose: a pump count alone cannot stop a
      // slow backend from eating the whole test budget, and a deadline alone
      // cannot stop a fast one from pumping tens of thousands of times.
      let pumps = 0;
      let stalled = false;
      const pumpDeadline = Date.now() + 90_000;
      while (session.retention().lastSequence <= RING && pumps < 200 && Date.now() < pumpDeadline) {
        const priorLast = session.retention().lastSequence;
        await session.pump();
        pumps += 1;
        if (session.retention().lastSequence === priorLast) {
          // A pump that emits nothing cannot drive the ring any further. That
          // is not a failure — it just means this leg proves the no-drop
          // regime below rather than the overflow regime.
          stalled = true;
          break;
        }
      }

      const after = session.retention();
      const overflowed = after.lastSequence > RING;

      // 1. THE RETAINED WINDOW HAS NO HOLES INSIDE IT. The floor and last the
      //    resume contract publishes must be the real ends of what is held; a
      //    gap here would hand a resuming client a contiguous-looking stream
      //    that is missing events in the middle.
      expect(after.floorSequence, `${backend}: published floor is not the first retained id`).toBe(after.ids[0]);
      expect(after.lastSequence, `${backend}: published last is not the final retained id`).toBe(after.ids.at(-1));
      expect(
        after.lastSequence - after.floorSequence + 1,
        `${backend} retained ${after.ids.length} events spanning ${after.floorSequence}..${after.lastSequence}; ` +
          'the retained window has a hole in it, so a resume inside it would silently skip events.',
      ).toBe(after.ids.length);

      // 2. RETENTION IS BOUNDED — the producer is never blocked into growing it.
      expect(
        after.ids.length,
        `${backend} retained ${after.ids.length} events, above the declared ${RING}-event ring: ` +
          'an unbounded ring is a memory leak, not backpressure.',
      ).toBeLessThanOrEqual(RING);

      // 3. A RESUME BELOW THE FLOOR REPLAYS ONLY WHAT IS STILL HELD. The host
      //    must not invent the prefix it dropped, and must not withhold what it
      //    kept. Asserted in BOTH regimes.
      expect(
        session.recentSinceCount(0),
        `${backend}: a resume from 0 replayed a different count than the host retains`,
      ).toBe(after.ids.length);
      expect(
        session.recentSinceCount(after.floorSequence - 1),
        `${backend}: a resume from just below the floor did not replay the whole retained window`,
      ).toBe(after.ids.length);
      expect(
        session.recentSinceCount(after.lastSequence),
        `${backend}: a resume from the newest event replayed events that do not exist yet`,
      ).toBe(0);

      if (overflowed) {
        // 4a. OVERFLOW REGIME — the drop is REPORTED. floorSequence advancing
        //     past 1 is precisely the signal a client compares its
        //     Last-Event-ID against to learn it must resync instead of
        //     assuming continuity.
        expect(
          after.floorSequence,
          `${backend} emitted ${after.lastSequence} events past a ${RING}-event ring but still publishes floor=1, ` +
            'so a client resuming from an evicted id would be told nothing was lost.',
        ).toBeGreaterThan(1);
        expect(
          after.ids.length,
          `${backend} overflowed the ring but retained ${after.ids.length} events instead of ${RING}`,
        ).toBe(RING);
      } else {
        // 4b. NO-DROP REGIME — reached when this leg's pumps could not drive the
        //     ring past its bound. Nothing was evicted, and that must be equally
        //     visible: the floor is still the first event the session emitted.
        expect(
          after.floorSequence,
          `${backend} retained ${after.ids.length} events without reaching the ${RING}-event bound ` +
            `(pumps=${pumps}, stalled=${stalled}), so nothing was evicted and the floor must still be the first event.`,
        ).toBe(before.ids[0]);
      }
    }, 180_000);

    it('INTERRUPT: the live runtime acknowledges an interrupt rather than dropping it', async () => {
      expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
      if (!attached) return;
      const session = attached;

      const support = session.descriptor().capabilities.commands.interrupt;
      const result = await session.send({
        type: 'interrupt',
        commandId: `int-${randomUUID().slice(0, 8)}`,
        reason: 'P-012 acceptance probe',
      });

      if (support.state === 'unsupported') {
        expect(
          result.status,
          `${backend} declares interrupt unsupported, so it must be refused explicitly, not accepted`,
        ).toBe('refused');
        return;
      }

      // ACKNOWLEDGEMENT is the condition, not cancellation of in-flight work:
      // the turn above has already completed, so there may be nothing to stop.
      // What must not happen is the command vanishing at the control socket.
      if (result.status === 'refused') {
        // claude declares interrupt SUPPORTED, so a refusal there is a real
        // defect. A backend that declares it conditional may decline, but must
        // say why.
        expect(
          support.state,
          `${backend} declares interrupt 'supported' but refused it: ` +
            `${result.refusal?.code} ${result.refusal?.message}. A supported command may not refuse.`,
        ).toBe('conditional');
        expect(result.refusal?.code, `${backend} refused the interrupt without a code`).toBeTruthy();
        return;
      }
      expect(
        result.status,
        `${backend} neither completed nor refused the interrupt (status=${result.status}); ` +
          'an unacknowledged interrupt is a control-socket delivery failure.',
      ).toMatch(/^(completed|accepted)$/);
    }, 120_000);

    it('RUNTIME REPLACEMENT: swapping the runtime bumps runtimeGeneration while identity stays stable', async () => {
      expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
      if (!attached) return;
      const session = attached;

      const before = session.descriptor();
      const outcome = await session.replaceRuntime('P-012 acceptance replacement');
      expect(
        outcome,
        outcome === 'no-runtime'
          ? `${backend} resolved NO native runtime at all (wrong backend, missing adv-session row, or ` +
              'an unmaterialisable native handle), so replacement could not be exercised. This IS a ' +
              'runtime-resolution defect — start there.'
          : outcome === 'no-record'
            ? `${backend} resolved its native runtime fine, but the native record file ` +
              '(Claude/OMP transcript, Codex rollout) is ABSENT on disk, so replacement could not be ' +
              'exercised. This is a filesystem/first-turn condition, NOT a runtime-resolution defect — ' +
              'do not go looking in runtime resolution. Check whether the backend ever wrote a turn ' +
              '(a SIGSTOPped or token-walled agent writes nothing), and whether the OWNER TURN case ' +
              'in this same leg also failed.'
            : `${backend} replacement did not report success`,
      ).toBe('replaced');
      const after = session.descriptor();

      expect(
        after.runtimeGeneration,
        `${backend} replaced its runtime without incrementing runtimeGeneration ` +
          `(${before.runtimeGeneration} -> ${after.runtimeGeneration}); consumers use this to ` +
          'invalidate cached runtime state, so a static generation means they never will.',
      ).toBeGreaterThan(before.runtimeGeneration);

      // STABLE IDENTITY is the other half: durable identity must survive
      // runtime-process replacement, or reconciliation and resume both break.
      expect(after.identity.advSessionId, `${backend} changed advSessionId across a runtime replacement`).toBe(
        before.identity.advSessionId,
      );
      expect(after.identity.nativeSessionId, `${backend} changed nativeSessionId across a runtime replacement`).toBe(
        before.identity.nativeSessionId,
      );
    }, 120_000);

    it('NATIVE RESUME: the runtime accepts a resume for a runtime-replacement cause', async () => {
      expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
      if (!attached) return;
      const session = attached;

      const support = session.descriptor().capabilities.commands.resume;
      const result = await session.send({
        type: 'resume',
        commandId: `res-${randomUUID().slice(0, 8)}`,
        cause: 'runtime-replacement',
      });

      if (support.state === 'unsupported') {
        expect(result.status, `${backend} declares resume unsupported, so it must be refused explicitly`).toBe(
          'refused',
        );
        return;
      }
      // Every backend declares resume CONDITIONAL (claude: "requires the tracked
      // session UUID and a live or P-004-reconciled managed runtime"). So a
      // refusal is in-contract here too — what it may not do is refuse opaquely.
      if (result.status === 'refused') {
        expect(support.state, `${backend} refused resume while declaring it 'supported'`).toBe('conditional');
        expect(
          result.refusal?.code,
          `${backend} refused resume without a code, so a caller cannot tell a declined ` +
            'precondition from a broken control socket.',
        ).toBeTruthy();
        return;
      }
      expect(
        result.status,
        `${backend} dropped a resume command (status=${result.status}); resume is what a PUI ` +
          'restart and a runtime replacement both rely on to re-establish the session.',
      ).toMatch(/^(completed|accepted)$/);
    }, 120_000);

    it('PUI RESTART / REATTACH: a second attach adopts the SAME native session and spawns nothing new', async () => {
      expect(advSessionId, 'SPAWN must have produced a row').toBeGreaterThan(0);
      expect(attached, 'the first attach must have succeeded').toBeTruthy();
      if (!attached) return;

      const pidBefore = spawned?.child?.pid ?? null;
      const firstNativeId = attached.nativeSessionId;

      // A PUI restart is exactly this: the pane process is still alive, and a
      // FRESH attach resolves the same durable row. Nothing about it should
      // start a second agent.
      const outcome = await ATTACH[backend](advSessionId, `p012-reattach-${advSessionId}`);
      expect(
        outcome.ok,
        outcome.ok ? '' : `reattach to adv row ${advSessionId} refused with ${outcome.code}: ${outcome.error}`,
      ).toBe(true);
      if (!outcome.ok) return;

      expect(
        outcome.leg.nativeSessionId,
        `reattach resolved a DIFFERENT native session (${firstNativeId} -> ${outcome.leg.nativeSessionId}); ` +
          'a PUI restart must adopt the running agent, not start a second one.',
      ).toBe(firstNativeId);

      // NO DOUBLE-SPAWN: the row must still point at the one process the SPAWN
      // hop started, and that process must still be the live one.
      const row = await getAdvSession(advSessionId);
      expect(row, `adv row ${advSessionId} vanished across a reattach`).toBeTruthy();
      if (pidBefore) {
        expect(
          pidAlive(pidBefore),
          `the original ${backend} pane process died during reattach; a restart that kills the ` +
            'agent it was meant to re-adopt is the double-spawn defect in its other direction.',
        ).toBe(true);
      }
    }, 120_000);

    it('UNCHANGED BARE-PSU BEHAVIOUR: an ordinary launch still live-spawns its OWN session and neither adopts nor disturbs the managed one', async (ctx) => {
      // WHY THIS BELONGS IN A REAL-BACKEND MATRIX.
      // P-012 added the PUI managed-session path: `deferSpawn`, a deferred adv
      // row, a pane that runs `launchArgv`, and an attach that adopts the row.
      // The risk it creates is not in that path — it is that the ORDINARY human
      // `psu` launch quietly starts travelling through it too. launch-agent.ts
      // already has a unit test for the request body it sends
      // ('ordinary launch remains the live-spawn/bare-psu path'), but that
      // asserts against a mocked fetch: it proves what the caller ASKS FOR, and
      // cannot see what the live operator DOES with the ask. This runs the same
      // call against the running operator and reads the consequence.
      //
      // THE OBSERVABLE DIFFERENCE between the two paths is `display` — NOT the
      // presence of `advSessionId`. Since WI-6376 an ordinary terminal launch
      // ALSO comes back carrying an adv row id (WI-37743 moved that insert above
      // the spawn), so "it returned an id ⇒ it was rerouted onto the deferred
      // path" is a false discriminator. It is written up in full at the
      // "IT IS STILL THE LIVE-SPAWN PATH" note below, including why the id-based
      // and getAdvSession-based readings each produced a false regression report
      // on 2026-08-30 — read that before changing what this case asserts.
      //
      // COST: one extra agent BOOT per backend and no turn, so no provider
      // tokens beyond session init. It is ended immediately below.
      expect(attached, 'the managed leg must exist for the disturbance check to mean anything').toBeTruthy();
      if (!attached || !advSessionId) return;

      // ⚠ ORDERING IS LOAD-BEARING: this case MUST run BEFORE END. It once ran
      // after it, and that single mis-ordering produced four false regression
      // reports in one day against a product that was working correctly.
      //
      // The disturbance half (4) asks whether an unrelated bare launch kills the
      // managed session. That question is only answerable against a session that
      // INTENDS to keep running, and after END it is not one: END's contract is
      // honoured-OR-explicitly-refused, and its teardown is ASYNCHRONOUS either
      // way. (A refusal is the HOST declining to kill a not-agent-launched
      // process; it is not a promise that the session survives.)
      //
      // ⚠ THE DEATHS ARE NOT ACTUALLY EXPLAINED — DO NOT WRITE THAT THEY ARE.
      // An earlier version of this note asserted the session "closes ITSELF —
      // endedBy='self', exitCode=0, endedSignal=null, i.e. a clean voluntary
      // exit, never a kill". That is FALSE reasoning: `self` is the value a row
      // DEGRADES TO when end provenance is not captured, so it is absence of
      // evidence, not evidence of a voluntary exit.
      //
      // ⚠ A SECOND CLAIM WAS HERE AND IT IS ALSO RETRACTED. This note used to say
      // "EVERY codex managed session dies 11.5-49.2s after launch", listing rows
      // 21326/21318/21315/21312/21310/21307/21305. That range was an artifact of
      // the 8h window it was measured in, stated as a property of the population.
      // Over 12h the max is 295.6s (adv 21291). Do not restore it.
      //
      // WHAT IS ACTUALLY MEASURED, by a deliberate no-end control (adv 21328,
      // 2026-08-30): PUI create -> claim -> run the row's launchArgv under a pty,
      // then send NOTHING — no end, no attach, no bare launch — and watch. The
      // session reached "Ready · gpt-5.6-sol default · staging" with both MCP
      // servers up and was STILL OPEN at +130.6s, when the control's own cleanup
      // closed it (ended_by='reconciler', which only stamps an unset ended_at).
      //
      // So an idle READY managed codex session does NOT have a ~30s lifetime, and
      // the disturbance half below IS measurable.
      //
      // WHAT SEPARATES THE TWO POPULATIONS IS BEING ATTACHED AND DRIVEN. The
      // control was never attached and lived 130.6s; the sessions this matrix
      // drives through a real turn die in the tens of seconds. Measured on the
      // 2026-08-30 run that first carried the idle control below: adv 21330 was
      // driven (OWNER TURN passed, with a real tool invocation), and died 63.5s
      // after launch — INSIDE a 15s idle window with no bare launch running.
      //
      // ⚠ DO NOT use adv_sessions.session_id as the "was it driven" marker. A
      // previous version of this note claimed every row that died carries one
      // "which is what driving stamps". That is FALSE: 21330 was driven through
      // a real turn and its session_id is NULL. Driven-ness is not readable from
      // that column, so read it from what the run actually DID, not from the row.
      //
      // Whether the post-drive death is a product defect or expected for a
      // TTY-less codex session is still OPEN, and it is now the thing standing
      // between this leg and green.
      // Tracked as EI-21908787009967815; do not close it by assumption.
      //
      // What this ordering DOES fix is the false causation: that ~30s death
      // overlapped this case's ~8s launch window, so "the managed pid died while
      // an unrelated bare launch ran" came out true at random, and reading that
      // temporal coincidence as causation produced four false regression reports.
      //
      // TWO IN-PLACE REPAIRS WERE TRIED BEFORE THE MOVE AND BOTH WERE WRONG,
      // because each accepted the bad position and tried to gate around it:
      //   - gating on the adv row being OPEN — still raced the async close;
      //   - waiting for the session to SETTLE open+alive for 3s — which after
      //     END is deterministically never true, so the disturbance half
      //     stopped measuring anything at all. That is the false-GREEN twin of
      //     the false-RED it replaced, and it is the worse of the two.
      // The lesson is the general one: when a red keeps returning under
      // successively better gates, the gate is not the bug — the PREDICATE is.
      //
      // Run before END and the ambiguity does not exist. The session has just
      // been driven through a turn, an interrupt, a resume and a reattach, so it
      // is unambiguously meant to be running, and a death across the bare launch
      // can only mean interference. That is what makes the precondition below an
      // ASSERTION rather than a skip: a managed session already gone at THIS
      // point is a real fault, not a scheduling artifact.
      const managedRowBefore = await getAdvSession(advSessionId);
      const managedBefore = await discoverPsuPtyByAdvSessionId(advSessionId);
      // BOTH halves, deliberately: the row states whether the session is meant
      // to be running, the pid states whether it is. The psu-launcher host
      // outlives its session by seconds while tearing down, so the pid alone
      // reports an already-closed session as live.
      expect(
        managedRowBefore != null && managedRowBefore.endedAt == null,
        `the managed ${backend} adv row ${advSessionId} was already closed before END ran — ` +
          'something ended this session out from under the matrix.',
      ).toBe(true);
      expect(
        managedBefore?.pid != null && pidAlive(managedBefore.pid),
        `the managed ${backend} session had no live pid before the bare launch while its adv row ` +
          'was still open, so the disturbance check below would measure nothing.',
      ).toBe(true);

      // ── THE IDLE CONTROL ──────────────────────────────────────────────────
      // The precondition above says the session is open and alive RIGHT NOW.
      // That is necessary but NOT sufficient to blame the bare launch for a
      // later death: by the time this case runs the session has already been
      // driven through a turn, an interrupt, a resume and a reattach, and the
      // deaths cluster in the tens of seconds after that driving. So "alive
      // before, dead after" is also what a death that was going to happen
      // anyway looks like. Reading that coincidence as causation is exactly
      // what produced four false regression reports on 2026-08-30.
      //
      // So hold the session for a window of the same order as the launch about
      // to run, with NOTHING running in it. The disturbance check below then
      // rests on a comparison instead of a bare observation.
      //
      // ⚠ THIS DOES NOT MAKE THE DISTURBANCE CHECK CONDITIONAL, and it must not
      // be turned into one. Both outcomes FAIL — they just fail with the right
      // attribution. Dying with no launch running is its own defect (a driven
      // managed session that will not stay up while its adv row is open and it
      // is meant to be running) and is reported as THAT. An earlier "settle
      // window" repair made this half skip instead, which is the false-GREEN
      // twin of the false-RED and the worse of the two; do not go back to it.
      //
      // The control is not speculative: adv 21328 (the no-end control) sat
      // READY and open for 130.6s with nothing sent to it, so a healthy managed
      // session comfortably survives a window this size.
      const idleControlStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, IDLE_BASELINE_MS));
      const idleControlMs = Date.now() - idleControlStartedAt;
      const rowAfterIdle = await getAdvSession(advSessionId);
      expect(
        rowAfterIdle != null && rowAfterIdle.endedAt == null && pidAlive(managedBefore!.pid),
        `the managed ${backend} session (pid ${managedBefore?.pid}) died during a ` +
          `${Math.round(idleControlMs / 1000)}s IDLE CONTROL window — no bare launch was running ` +
          'and END had not run. This is NOT evidence about the bare launch. It says the driven ' +
          'managed session does not stay up on its own while its adv row is open and it is ' +
          'still meant to be running, which is a defect in its own right (EI-21908787009967815). ' +
          'Fix that first: the disturbance question below cannot be answered until a session ' +
          'survives an idle window of this length. ' +
          (rowAfterIdle
            ? `endedAt=${String(rowAfterIdle.endedAt ?? 'null')} ` +
              `endedBy=${String(rowAfterIdle.endedBy ?? 'null')} ` +
              `endedSignal=${String(rowAfterIdle.endedSignal ?? 'null')}`
            : `adv row ${advSessionId} no longer resolves`) +
          ". NOTE: endedBy='self' is the DEGRADED default, not proof of a voluntary exit.",
      ).toBe(true);

      // Everything from here is the EXPOSURE the control above is the control
      // for. Timed so a failure can state whether the control was actually as
      // long as the exposure it is being compared against.
      const exposureStartedAt = Date.now();

      const bare = await launchAgent({
        agent: backend as 'claude' | 'codex' | 'omp',
        slug: HARNESS,
        // No desktop window: this runs headless on a shared box, and psu's
        // --headless deliberately KEEPS the managed pty and its control socket,
        // so the discovery contract below is the same one a windowed launch
        // uses. It is the window that is dropped, not the launch path.
        headless: true,
        // REQUIRED, not a default: launch-agent.ts states that psu with no
        // --account opens an interactive picker, which would hang this spawn
        // forever behind a prompt no test can answer. Keep Claude/OMP on the
        // system credential; Codex/OMP can opt into an explicit gateway route
        // when the acceptance host has no usable default provider account.
        account: accountForBackend(backend),
        ...(backend === 'omp' ? { model: OMP_MODEL } : {}),
      });

      expect(bare.ok, `an ordinary ${backend} launch was refused: ${bare.error ?? ''}`).toBe(true);
      if (!bare.ok) return;

      // 1. IT IS STILL THE LIVE-SPAWN PATH.
      //
      // ⚠ NOT "the response carries no advSessionId". That was this case's first
      // discriminator and it is WRONG — it produced a confident false regression
      // report the first time this ran (2026-08-30). It came from launch-agent.ts's
      // own comment, "on the terminal path no adv_sessions row exists at launch
      // (psu records one asynchronously once it boots)", which is STALE: WI-6376
      // (owner ask 2026-07-25 — sessions must appear on the board "whether or not
      // they are launched with the new session button or if they are launched with
      // the psu utility") made launch-su record a STARTING row for every launch
      // carrying an ownerId, and WI-37743 moved that insert ABOVE the spawn.
      //
      // That stale prose has since been CORRECTED at its sources
      // (EI-21906395662385960, 2026-08-31) — LaunchAgentResult.advSessionId in
      // launch-agent.ts, launch-su.ts's reply comment, goals/start.ts's
      // agent_owner_id note, and this case's own preamble above. It is quoted
      // here as the historical cause of the false report, NOT as live text to go
      // and find. Do not "fix" the sources again on the strength of this quote.
      //
      // The field the CODE branches on is `display` — but DO NOT read it back
      // through getAdvSession. That produced this case's SECOND false regression
      // report in one day (2026-08-30): the row was stored correctly as
      // display='terminal' (confirmed in Postgres), yet the assertion read null
      // and reported a reroute. mapAdvSessionRow's own input type says why —
      // "optional — only the pending-launch query SELECTs them; every other
      // query omits them and they map to null" — so getAdvSession cannot
      // distinguish NOT-SELECTED from a genuine null, and a working product
      // reads as a regression. (Contrast `last_active_at` three fields below,
      // which maps to `undefined` precisely so that distinction survives.)
      //
      // Both false reports came from trusting PROSE over the query that runs:
      // the first a stale WRITER comment, the second a READER that never selects
      // the column. So assert through the CONSUMER. The pane queue is
      // listPendingWorkbenchLaunches — display='workbench' AND launched_at IS
      // NULL AND ended_at IS NULL — the exact rows the pui reactively panes. A
      // bare launch absent from it was not rerouted onto D-006, and that
      // predicate cannot go stale without breaking the feature itself.
      expect(bare.ownerId, 'launch-su returned no pre-pinned owner id for a bare launch').toBeTruthy();
      expect(
        bare.deferred === true,
        `an ordinary ${backend} launch reported deferred:true — it was routed onto the PUI deferred path`,
      ).toBe(false);
      if (bare.advSessionId != null) {
        const paneQueue = await listPendingWorkbenchLaunches();
        expect(
          paneQueue.some((row) => row.id === bare.advSessionId),
          `an ordinary ${backend} launch left adv row ${bare.advSessionId} sitting in the PUI ` +
            "pane queue (display='workbench', unconsumed) — the bare path has been rerouted " +
            'onto D-006.',
        ).toBe(false);
      }

      const bareOwnerId = bare.ownerId!;
      let bareDiscovery: PsuPtyDiscovery | null = null;
      // Same freeze hazard as the OWNER TURN wait, for the same reason: this
      // poll is wall-clock and the process it waits on shares this test's
      // freezable cgroup, so a pc-heavy SIGSTOP burns the budget without the
      // subject ever getting to run.
      const bootStall = createStallWatch();
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        bootStall.tick();
        try {
          bareDiscovery = JSON.parse(
            await readFile(join(PSU_PTY_DIR, `${bareOwnerId}.json`), 'utf8'),
          ) as PsuPtyDiscovery;
          if (bareDiscovery?.pid && pidAlive(bareDiscovery.pid)) break;
        } catch {
          // not written yet, or written partially — poll again
        }
        bareDiscovery = null;
        await delay(1_000);
      }

      const bareUp = Boolean(bareDiscovery?.pid && pidAlive(bareDiscovery.pid));
      if (!bareUp && bootStall.stalled()) {
        // NOT MEASURED, not red. Cleaned up first: skipping must not leak the
        // process this case may still have started.
        const strandedPid = bareDiscovery?.pid;
        if (strandedPid && pidAlive(strandedPid)) {
          try {
            process.kill(strandedPid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
        // console.LOG, not warn — same reason as the OWNER TURN stall guard
        // above: vitest-fail-on-console would turn this skip into a false red
        // blaming the backend for host memory pressure.
        // eslint-disable-next-line no-console
        console.log(
          `[matrix] NOT MEASURED — ${backend} BARE-PSU: this process lost ` +
            `${Math.round(bootStall.maxGapMs() / 1000)}s to a single stall while waiting for the ` +
            'launch to come up, so the budget expired without the subject being given a chance to ' +
            'run. Re-run when the host is not under memory pressure.',
        );
        ctx.skip();
        return;
      }

      // 2. A REAL PROCESS CAME UP. Without this the assertions above would pass
      //    against a launch that returned ok and then died silently
      //    (EI-18696184925888288 is exactly that failure mode).
      expect(
        bareUp,
        `the ordinary ${backend} launch (owner ${bareOwnerId}) never reached a live managed-pty session ` +
          `within ${Math.round(READY_TIMEOUT_MS / 1000)}s`,
      ).toBeTruthy();

      try {
        // 3. IT DID NOT ADOPT THE MANAGED ROW. A bare launch records its own
        //    session asynchronously; adopting the PUI row would make two
        //    processes claim one identity.
        expect(
          Number(bareDiscovery!.advSessionId),
          `the ordinary ${backend} launch adopted the managed PUI row ${advSessionId} instead of recording its own`,
        ).not.toBe(advSessionId);

        // 4. THE MANAGED SESSION IS UNDISTURBED. UNCONDITIONAL, and that is the
        //    whole point of running before END: the precondition above has
        //    already established that this session is open and alive, so there
        //    is no state in which this check is allowed to quietly skip. If it
        //    ever becomes conditional again, read the ordering note at the top
        //    of this case before "fixing" it — every previous condition here was
        //    a gate papering over the wrong position in the file.
        const managedPid = managedBefore!.pid!;
        // Carry the death's PROVENANCE into the failure, so a future red states
        // how the session died instead of costing the next reader the dig that
        // produced the note above. exitCode 0 alone is not a clean exit —
        // adv-sessions.ts:171 says to read endedBy for that.
        const rowAfter = await getAdvSession(advSessionId);
        const howItDied = rowAfter
          ? `adv row ${advSessionId} now: endedAt=${String(rowAfter.endedAt ?? 'null')} ` +
            `endedBy=${String(rowAfter.endedBy ?? 'null')} ` +
            `exitCode=${String(rowAfter.exitCode ?? 'null')} ` +
            `endedSignal=${String(rowAfter.endedSignal ?? 'null')}`
          : `adv row ${advSessionId} no longer resolves`;
        expect(
          pidAlive(managedPid),
          `the managed ${backend} session (pid ${managedPid}) died during an unrelated bare ` +
            'launch, before END had even run and while its adv row was still OPEN — so it was ' +
            `still meant to be running. ${howItDied}. ` +
            // The idle control is what makes this a disturbance claim rather than a
            // coincidence: the same session was just held ALIVE across a comparable
            // window with nothing running in it. State both durations so a reader can
            // see whether the control was actually as long as the exposure — if the
            // exposure is much the longer of the two, the attribution is weaker than
            // it looks and IDLE_BASELINE_MS should be raised, not the check relaxed.
            `It survived a ${Math.round(idleControlMs / 1000)}s idle control immediately ` +
            `before this, and died within a ${Math.round((Date.now() - exposureStartedAt) / 1000)}s ` +
            'window that contained the bare launch. ' +
            // ⚠ DO NOT re-add "endedBy='self' means it cannot have been killed". That claim
            // was here and it is FALSE: `self` is the value a row DEGRADES TO when the end
            // provenance is not captured, not positive evidence of a voluntary exit.
            // adv-session-ended-provenance.test.ts:199 — "a rejected value degrades to
            // ended_by='self'" — and :222 preserves the reaped rows 14851/14852, killed by a
            // sidecar restart and recorded exit 0 / ended_by 'self'. Reading `self` as
            // exculpatory is absence-of-evidence read as evidence-of-absence, and it cost
            // four false regression reports on 2026-08-30. See EI-21908787009967815.
            "NOTE: endedBy='self' is the DEGRADED default, not proof of a voluntary exit — a " +
            'reaped session whose signal was not captured records exactly this shape. Treat ' +
            "endedBy='signal' as the only positive kill evidence, and 'self' as UNKNOWN.",
        ).toBe(true);
        // Secondary, and only when the record still resolves: a DIFFERENT live
        // pid is the real respawn/adoption signature. An absent record while the
        // pid is alive is a discovery gap, not a disturbance, and must not be
        // reported as one.
        const managedAfter = await discoverPsuPtyByAdvSessionId(advSessionId);
        if (managedAfter?.pid != null) {
          expect(
            managedAfter.pid,
            `the managed ${backend} session was replaced by a different process ` +
              `(${managedPid} -> ${managedAfter.pid}) across an unrelated bare launch`,
          ).toBe(managedPid);
        }
      } finally {
        // 5. NO ORPHAN. This test created a real process; it owns ending it,
        //    whichever way the assertions above resolved. By PID, never by name
        //    or pattern — a pattern kill on this box has twice taken out a
        //    peer's live session.
        const barePid = bareDiscovery?.pid;
        if (barePid && pidAlive(barePid)) {
          try {
            process.kill(barePid, 'SIGTERM');
          } catch {
            // already gone between the check and the signal
          }
          const gone = Date.now() + 20_000;
          while (Date.now() < gone && pidAlive(barePid)) await delay(500);
          if (pidAlive(barePid)) {
            try {
              process.kill(barePid, 'SIGKILL');
            } catch {
              // ditto
            }
          }
        }
      }
    }, 300_000);

    // ⚠ END RUNS LAST, AFTER BARE-PSU, AND MUST STAY THERE. Ending the managed
    // session starts an ASYNCHRONOUS teardown that races any later case reading
    // that session's liveness; BARE-PSU's disturbance check is exactly such a
    // reader, and running it after this case produced four false regression
    // reports in one day. See the ordering note in BARE-PSU above before moving
    // either one.
    it('END: the end command is either honoured and the process exits, or refused EXPLICITLY per its declared contract', async () => {
      expect(attached, 'ATTACH must have produced a driveable session').toBeTruthy();
      if (!attached) return;
      const session = attached;

      const support = session.descriptor().capabilities.commands.end;
      const result = await session.send({
        type: 'end',
        commandId: `end-${randomUUID().slice(0, 8)}`,
        reason: 'P-012 acceptance matrix teardown',
      });
      endOutcome = result.status;

      // WHY THIS IS NOT SIMPLY `expect(status).toBe('completed')`.
      //
      // Every backend declares `end` as CONDITIONAL, not supported — claude's
      // stated reason is "the managed host may refuse to close a human-attended
      // runtime". A refusal is therefore a DECLARED outcome of this command, not
      // a defect, and a matrix that fails on it is asserting past the contract
      // it is supposed to be checking. (It did exactly that on its first run.)
      //
      // What `conditional` DOES promise is that the refusal is explicit and
      // legible — a code and a message — rather than a silent drop or a
      // success that did nothing. That is the assertion worth making.
      if (result.status === 'refused') {
        expect(
          support.state,
          `${backend} refused 'end' while declaring it '${support.state}'. Only a conditional or ` +
            'unsupported command may refuse; a supported one may not.',
        ).toMatch(/^(conditional|unsupported)$/);
        expect(
          result.refusal?.code,
          `${backend} refused 'end' without a refusal code. An opaque refusal is indistinguishable ` +
            'from a dropped command, which is what makes an abandoned agent invisible.',
        ).toBeTruthy();
        expect(result.refusal?.message, `${backend} refused 'end' without a message explaining why`).toBeTruthy();
        return;
      }

      expect(
        result.status,
        `${backend} neither honoured nor refused the end command (status=${result.status}); ` +
          'a silently dropped end is how a real agent is left burning tokens.',
      ).toMatch(/^(completed|accepted)$/);

      // Acknowledgement is not exit. Wait for the process to actually go.
      const pid = spawned?.child?.pid ?? null;
      const deadline = Date.now() + 60_000;
      while (pid && pidAlive(pid) && Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS);
      }
      if (pid) {
        expect(
          pidAlive(pid),
          `the ${backend} agent process ${pid} was still alive 60s after the end command was ` +
            'acknowledged. The command was accepted and the process ignored it.',
        ).toBe(false);
      }
    }, 120_000);

    it('ORPHAN-FREE RECONCILIATION: no live process is left UNTRACKED, whichever way the end hop resolved', async () => {
      expect(advSessionId, 'CREATE must have produced a row').toBeGreaterThan(0);

      // AN ORPHAN IS NOT "A LIVE PROCESS" — IT IS A LIVE PROCESS NOTHING OWNS.
      //
      // The first version of this test asserted the pid was simply dead, which
      // made it fail whenever `end` was (legitimately) refused: a conditional
      // end that declines to close a runtime leaves it alive ON PURPOSE, and
      // that is not an orphan while the row still tracks it. Asserting death
      // here turned one real observation into two false ones.
      //
      // The property that actually matters for reconciliation is that every
      // live process remains REACHABLE — the row knows about it, so the
      // reconciler and the teardown below can still find and reap it. An
      // untracked live agent is the thing that burns tokens until a human
      // notices.
      const pid = spawned?.child?.pid ?? null;
      const alive = pid ? pidAlive(pid) : false;

      const row = await getAdvSession(advSessionId);
      expect(
        row,
        `adv row ${advSessionId} vanished while pid ${pid} is ${alive ? 'STILL ALIVE' : 'gone'} — ` +
          'a live process whose tracking row is gone is unreachable by definition.',
      ).toBeTruthy();

      if (alive) {
        // Still running: that is only acceptable because end was refused, and
        // it must still be tracked. Say which case we are in, so a reader is
        // never left guessing whether this was intentional.
        expect(
          endOutcome,
          `the ${backend} agent ${pid} is still alive but the end command reported ` +
            `'${endOutcome}'. A live process after a HONOURED end is an ignored end, not a ` +
            'conditional refusal.',
        ).toBe('refused');
        expect(
          liveLegs.some((entry) => entry.advSessionId === advSessionId),
          `pid ${pid} is alive and NOT registered in liveLegs, so teardown will not reap it — ` +
            'this is the orphan condition.',
        ).toBe(true);
      }

      // The discovery file is how the operator's wake-executor finds a live
      // session. One pointing at a DEAD pid would make a dead session look
      // injectable to every later reader — the inverse orphan.
      const discovery = await discoverPsuPtyByAdvSessionId(advSessionId);
      if (discovery && !alive) {
        expect(
          pidAlive(discovery.pid),
          `psu-pty discovery for adv row ${advSessionId} still points at pid ${discovery.pid} ` +
            'while the session is gone; the wake-executor would treat this dead session as injectable.',
        ).toBe(false);
      }
    }, 120_000);
  });
});
