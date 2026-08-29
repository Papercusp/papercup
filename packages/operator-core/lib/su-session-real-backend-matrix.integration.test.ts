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
 *   npm run test:file -- packages/operator-core/lib/su-session-real-backend-matrix.integration.test.ts
 *
 * Select a subset with PAPERCUSP_REAL_BACKEND_MATRIX_BACKENDS=claude,codex.
 *
 * COST NOTE: each leg spawns a real agent and spends real tokens on the
 * configured account. Turns are deliberately single-shot and the matrix ends
 * every session it creates, then asserts the process is gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SuSessionBackend } from '@papercusp/chat-protocol';
import { openPuiSuSession, type PuiSuSessionBinding } from './launch-agent';
import { getAdvSession, markAdvSessionLaunched, markAdvSessionEnded } from './adv-sessions';
import { managedSpawn, type ManagedSpawnResult } from './task-manager/managed-spawn';
import { resolveClaudeSuRuntime } from './su-session-claude-adapter';
import { resolveCodexSuRuntime } from './su-session-codex-adapter';
import { resolveOmpSuRuntime } from './su-session-omp-adapter';

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

/** A real agent boot is not fast: psu resolves an account, the CLI starts, and
 *  bootstrap has to adopt the row before a native session exists. */
const READY_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 2_000;

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

// ── per-leg bookkeeping, so teardown can never leak a real agent ────────────
interface LiveLeg {
  backend: MatrixBackend;
  advSessionId: number;
  spawned: ManagedSpawnResult | null;
}
const liveLegs: LiveLeg[] = [];

beforeAll(() => {
  if (!ENABLED) return;
  // Fail loudly rather than quietly addressing the wrong database: every hop
  // below reads rows the live operator wrote.
  if (!process.env.PAPERCUSP_WORKSPACE_ID) process.env.PAPERCUSP_WORKSPACE_ID = 'papercusp-workspace';
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
    let leg: LiveLeg;

    it('CREATE: records exactly one deferred row carrying the pane argv, and spawns nothing', async () => {
      const opened = await openPuiSuSession({
        operation: 'create',
        backend: backend as SuSessionBackend,
        carry: 'warm',
        slug: HARNESS,
      });

      // A failure here is an infrastructure verdict, not a flake — say which.
      expect(
        opened.ok,
        `launch-su refused to create a ${backend} session: ${opened.ok ? '' : opened.error}`,
      ).toBe(true);
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
    }, 120_000);

    it('SPAWN + READY: claiming the row then running the pane argv materialises a native session on the SAME row', async () => {
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
      let captured = '';
      const capture = (chunk: Buffer | string) => {
        captured += String(chunk);
        if (captured.length > 8_000) captured = captured.slice(-8_000);
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
          `  child output (last 8k):\n${captured || '(the child wrote nothing at all)'}`,
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
        `the ${backend} pane process died after registering its session; child output:\n${captured}`,
      ).toBe(true);
    }, READY_TIMEOUT_MS + 60_000);
  });
});
