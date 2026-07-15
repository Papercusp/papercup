/**
 * cold-boot-drill-live — P-020's opt-in chaos actuator + mechanical grader.
 *
 * This deliberately REUSES the P-018 carry-respawn host instead of introducing
 * another lifecycle mechanism. `startColdBootDrill` builds the same deterministic
 * carry, crosses the same flush/open-owner gates, and queues the same clean-boundary
 * `carry-respawn`; drill metadata merely lets the host record which fresh Claude
 * transcript belongs to the sample. `gradeColdBootDrill` then parses that native
 * transcript through the replay parser and extracts only explicit state-recovery
 * tool calls. No LLM judges its own carry.
 *
 * Destructive behavior is DEFAULT-OFF: nothing runs on a timer or watcher. A caller
 * must explicitly invoke `session:carry-drill { op:'start' }`, and the durable drill
 * ledger rate-limits one owner to one cut per 30 minutes.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { buildCarryBrief, type CarryBrief } from './carry-brief';
import { buildOwnerRespawnLaunchSpec, type RespawnLaunchSpec } from './carry-respawn';
import {
  DEFAULT_SUFFICIENCY_PARAMS,
  extractRecoveryLookups,
  gradeColdBootDrills,
  type CarrySufficiencyReport,
  type DrillSample,
  type RecoveryLookup,
} from './cold-boot-drill';
import { resolveSessionRef, resolveModelSpecForOwner } from './compaction-usage';
import { runFlushGate, type FlushGateOutcome } from './enforcement-gate-io';
import {
  PSU_PTY_DIR,
  findLiveHost,
  hostSupports,
  injectIntoHost,
  sanitizeKey,
  type PsuPtyHost,
} from './events/await/psu-pty-discovery';
import { modelWindowForSpec } from './agent-config-constants';
import { findSessionTranscript, newestTranscriptUnderOwner } from './claude-sessions';
import { parseTranscriptJsonl } from './replay/transcript';
import type { ReplayTranscript } from './replay/types';

export const DEFAULT_COLD_BOOT_DRILL_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS = 200_000;
const DRILL_LEDGER_MAX_BYTES = 1024 * 1024;
const DRILL_LEDGER_FILE = 'carry-drills.events.jsonl';
const CARRY_ROOT = join(homedir(), '.papercusp', 'launch-context');

export type ColdBootDrillLedgerKind =
  | 'carry-drill-requested'
  | 'carry-drill-queued'
  | 'carry-drill-request-failed'
  | 'carry-drill-graded'
  // Host-side lifecycle kinds mirrored into the shared ledger by psu-pty-host's
  // appendSharedDrillLedgerEvent (EI-12655): previously these lived ONLY in the
  // per-owner host event log, so the shared-ledger report saw an eternally
  // pending requested/queued pair for every drill whose grade never landed.
  | 'carry-drill-respawned'
  | 'carry-drill-respawn-failed'
  | 'carry-drill-carry-delivered'
  | 'carry-drill-carry-dropped';

export interface ColdBootDrillLedgerEvent {
  ts: string;
  kind: ColdBootDrillLedgerKind;
  drillId: string;
  ownerId: string;
  sessionClass: string;
  detail?: string;
  lookups?: RecoveryLookup[];
  transcriptPath?: string;
  /** Host-mirrored terminal rows (EI-12655): why a carry was dropped / a respawn failed. */
  reason?: string;
  /** Host-mirrored respawn rows (EI-12655): the successor's fresh native session id. */
  nativeId?: string | null;
}

export interface ColdBootDrillHostEvent {
  ts?: string;
  kind?: string;
  drillId?: string;
  sessionClass?: string;
  nativeId?: string | null;
  launchContextPath?: string | null;
  reason?: string;
}

export function coldBootDrillLedgerPath(dir: string = PSU_PTY_DIR): string {
  return join(dir, DRILL_LEDGER_FILE);
}

export function ownerHostEventPath(ownerId: string, dir: string = PSU_PTY_DIR): string {
  return join(dir, `${sanitizeKey(ownerId)}.events.jsonl`);
}

function parseJsonl<T>(body: string): T[] {
  const out: T[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row as T);
    } catch {
      // A host can be appending while the reader snapshots the file. A partial
      // final row is not a drill failure; the next grade/report sees it.
    }
  }
  return out;
}

export async function readColdBootDrillLedger(dir: string = PSU_PTY_DIR): Promise<ColdBootDrillLedgerEvent[]> {
  try {
    return parseJsonl<ColdBootDrillLedgerEvent>(await fs.readFile(coldBootDrillLedgerPath(dir), 'utf8'));
  } catch {
    return [];
  }
}

export async function readOwnerHostEvents(
  ownerId: string,
  dir: string = PSU_PTY_DIR,
): Promise<ColdBootDrillHostEvent[]> {
  try {
    return parseJsonl<ColdBootDrillHostEvent>(await fs.readFile(ownerHostEventPath(ownerId, dir), 'utf8'));
  } catch {
    return [];
  }
}

/** Bounded append in the existing psu-pty event directory. Unlike the host's
 * per-owner log, this small roll-up contains only drill lifecycle/sample rows so
 * a class report never scans thousands of unrelated owner files. */
export async function appendColdBootDrillLedgerEvent(
  event: ColdBootDrillLedgerEvent,
  dir: string = PSU_PTY_DIR,
): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const path = coldBootDrillLedgerPath(dir);
    try {
      const stat = await fs.stat(path);
      if (stat.size > DRILL_LEDGER_MAX_BYTES) {
        const body = await fs.readFile(path, 'utf8');
        await fs.writeFile(path, body.slice(Math.floor(body.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      // First append creates the file.
    }
    await fs.appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await fs.chmod(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

function latestActiveDrill(
  events: readonly ColdBootDrillLedgerEvent[],
  ownerId: string,
): ColdBootDrillLedgerEvent | null {
  const terminal = new Set(
    events
      .filter((event) => event.ownerId === ownerId && event.kind === 'carry-drill-request-failed')
      .map((event) => event.drillId),
  );
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event.ownerId === ownerId &&
      (event.kind === 'carry-drill-requested' || event.kind === 'carry-drill-queued') &&
      !terminal.has(event.drillId)
    ) return event;
  }
  return null;
}

async function defaultTranscriptPath(ownerId: string): Promise<string | null> {
  const ref = await resolveSessionRef(ownerId);
  if (!ref || (ref.agent != null && ref.agent !== 'claude')) return null;
  return (
    (ref.sessionId ? await findSessionTranscript(ref.sessionId, { owner: ownerId }) : null) ??
    newestTranscriptUnderOwner(ownerId)
  );
}

async function defaultEffectiveWindow(ownerId: string): Promise<number> {
  try {
    const spec = await resolveModelSpecForOwner(ownerId);
    return spec ? modelWindowForSpec(spec) : DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS;
  } catch {
    return DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS;
  }
}

export interface StartColdBootDrillInput {
  ownerId: string;
  ownerLabel: string;
  workspaceId?: string | null;
  sessionClass?: string;
  effectiveWindowTokens?: number;
  minIntervalMs?: number;
}

export interface StartColdBootDrillDeps {
  now: () => number;
  newId: () => string;
  findHost: (ownerId: string) => PsuPtyHost | null;
  resolveTranscriptPath: (ownerId: string) => Promise<string | null>;
  resolveEffectiveWindow: (ownerId: string) => Promise<number>;
  buildBrief: (ownerId: string, workspaceId?: string) => Promise<CarryBrief | null>;
  flushGate: (input: Parameters<typeof runFlushGate>[0]) => Promise<FlushGateOutcome>;
  buildSpec: (
    ownerId: string,
    input: Parameters<typeof buildOwnerRespawnLaunchSpec>[1],
  ) => Promise<RespawnLaunchSpec | null>;
  inject: typeof injectIntoHost;
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  appendLedger: (event: ColdBootDrillLedgerEvent) => Promise<boolean>;
}

function startDeps(overrides: Partial<StartColdBootDrillDeps>): StartColdBootDrillDeps {
  return {
    now: Date.now,
    newId: randomUUID,
    findHost: findLiveHost,
    resolveTranscriptPath: defaultTranscriptPath,
    resolveEffectiveWindow: defaultEffectiveWindow,
    buildBrief: async (ownerId, workspaceId) => {
      try { return await buildCarryBrief(ownerId, { workspaceId }); } catch { return null; }
    },
    flushGate: runFlushGate,
    buildSpec: buildOwnerRespawnLaunchSpec,
    inject: injectIntoHost,
    readLedger: readColdBootDrillLedger,
    appendLedger: appendColdBootDrillLedgerEvent,
    ...overrides,
  };
}

export type StartColdBootDrillResult =
  | { ok: true; drillId: string; sessionClass: string; queued: true; nextAllowedAt: string }
  | { ok: false; error: string; note: string; retryAt?: string; tripwires?: unknown[] };

export async function startColdBootDrill(
  input: StartColdBootDrillInput,
  overrides: Partial<StartColdBootDrillDeps> = {},
): Promise<StartColdBootDrillResult> {
  const deps = startDeps(overrides);
  const ownerId = input.ownerId.trim();
  const sessionClass = input.sessionClass?.trim() || 'claude-interactive';
  const now = deps.now();
  const interval = Math.max(60_000, input.minIntervalMs ?? DEFAULT_COLD_BOOT_DRILL_INTERVAL_MS);
  if (!ownerId) return { ok: false, error: 'owner_required', note: 'A drill must target the calling session owner.' };

  const host = deps.findHost(ownerId);
  if (!host || !hostSupports(host, 'carry-respawn')) {
    return {
      ok: false,
      error: host ? 'host_missing_carry_respawn_capability' : 'no_live_pty_host',
      note: 'P-020 drills require a live Claude psu host advertising carry-respawn; no process was cut.',
    };
  }

  const active = latestActiveDrill(await deps.readLedger(), ownerId);
  const activeAt = active ? Date.parse(active.ts) : NaN;
  if (active && Number.isFinite(activeAt) && now - activeAt < interval) {
    const retryAt = new Date(activeAt + interval).toISOString();
    return {
      ok: false,
      error: 'drill_rate_limited',
      note: `The last live cut for this owner is inside the ${Math.round(interval / 60_000)}-minute chaos interval.`,
      retryAt,
    };
  }

  const transcriptPath = await deps.resolveTranscriptPath(ownerId);
  if (!transcriptPath) {
    return { ok: false, error: 'transcript_unavailable', note: 'The current Claude transcript could not be resolved; no process was cut.' };
  }

  const workspaceId = input.workspaceId ?? '*';
  const brief = await deps.buildBrief(ownerId, input.workspaceId ?? undefined);
  const gate = await deps.flushGate({
    boundary: 'compaction',
    ownerId,
    workspaceId,
    sessionId: ownerId,
    sinceIso: new Date(now - 30 * 60_000).toISOString(),
    brief,
    nowMs: now,
  });
  if (gate.verdict === 'refuse') {
    return {
      ok: false,
      error: 'flush_required',
      note: gate.refusalText ?? 'Flush the named state, then explicitly start the drill again.',
      tripwires: gate.tripwires,
    };
  }

  const effectiveWindowTokens =
    typeof input.effectiveWindowTokens === 'number' && input.effectiveWindowTokens > 0
      ? input.effectiveWindowTokens
      : await deps.resolveEffectiveWindow(ownerId);
  const spec = await deps.buildSpec(ownerId, {
    effectiveWindowTokens,
    buildOpts: {
      workspaceId: input.workspaceId ?? undefined,
      ownerLabel: input.ownerLabel,
      transcriptPath,
      transcriptSourceKind: 'claude',
      boundaryDeliberate: true,
    },
  });
  if (!spec) {
    return { ok: false, error: 'carry_build_failed', note: 'The deterministic carry could not be assembled; the current process remains alive.' };
  }
  if (spec.openOwnerQuestion.crossesOpenOwnerMessage) {
    return {
      ok: false,
      error: 'open_owner_message',
      note: 'The last owner message is unanswered. This deliberate chaos cut refuses rather than crossing it.',
    };
  }

  const drillId = deps.newId();
  const requested: ColdBootDrillLedgerEvent = {
    ts: new Date(now).toISOString(),
    kind: 'carry-drill-requested',
    drillId,
    ownerId,
    sessionClass,
  };
  if (!(await deps.appendLedger(requested))) {
    return { ok: false, error: 'drill_ledger_unavailable', note: 'The drill could not be durably registered, so no process was cut.' };
  }

  const firstPrompt = [
    `⟦carry-drill:${drillId}⟧`,
    'This is an opt-in P-020 cold-boot carry-sufficiency drill on a fresh process.',
    'First run coord:orient { afterCompaction: true }, then continue the carried work.',
    'Do not search/read your prior self session unless the carry is actually insufficient; ordinary source reads are fine.',
    `At the next clean boundary call session:carry-drill { op: "grade", drillId: "${drillId}" } exactly once.`,
  ].join('\n');
  const injected = await deps.inject(host.sock, {
    mode: 'carry-respawn',
    data: firstPrompt,
    systemPromptAddendum: spec.systemPromptAddendum,
    drillId,
    sessionClass,
  });
  if (!injected) {
    await deps.appendLedger({
      ...requested,
      ts: new Date(deps.now()).toISOString(),
      kind: 'carry-drill-request-failed',
      detail: 'control socket did not acknowledge the request',
    });
    return { ok: false, error: 'carry_respawn_inject_failed', note: 'The host did not acknowledge the cut; the current process remains available.' };
  }
  await deps.appendLedger({ ...requested, ts: new Date(deps.now()).toISOString(), kind: 'carry-drill-queued' });
  return {
    ok: true,
    drillId,
    sessionClass,
    queued: true,
    nextAllowedAt: new Date(now + interval).toISOString(),
  };
}

function reportFromLedger(events: readonly ColdBootDrillLedgerEvent[]): CarrySufficiencyReport {
  const samples = new Map<string, DrillSample>();
  for (const event of events) {
    if (event.kind !== 'carry-drill-graded' || !Array.isArray(event.lookups)) continue;
    samples.set(event.drillId, { sessionClass: event.sessionClass, lookups: event.lookups });
  }
  return gradeColdBootDrills([...samples.values()], DEFAULT_SUFFICIENCY_PARAMS);
}

async function safeReadCarry(path: string, root: string = CARRY_ROOT): Promise<string | null> {
  try {
    const [realRoot, realPath] = await Promise.all([fs.realpath(root), fs.realpath(path)]);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) return null;
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return await fs.readFile(realPath, 'utf8');
  } catch {
    return null;
  }
}

export interface GradeColdBootDrillDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  appendLedger: (event: ColdBootDrillLedgerEvent) => Promise<boolean>;
  readHostEvents: (ownerId: string) => Promise<ColdBootDrillHostEvent[]>;
  readCarry: (path: string) => Promise<string | null>;
  loadTranscript: (ownerId: string, nativeId: string | null) => Promise<ReplayTranscript | null>;
  now: () => number;
}

function gradeDeps(overrides: Partial<GradeColdBootDrillDeps>): GradeColdBootDrillDeps {
  return {
    readLedger: readColdBootDrillLedger,
    appendLedger: appendColdBootDrillLedgerEvent,
    readHostEvents: readOwnerHostEvents,
    readCarry: safeReadCarry,
    loadTranscript: async (ownerId, nativeId) => {
      const path =
        (nativeId ? await findSessionTranscript(nativeId, { owner: ownerId }) : null) ??
        newestTranscriptUnderOwner(ownerId);
      if (!path) return null;
      try { return parseTranscriptJsonl(await fs.readFile(path, 'utf8'), path); } catch { return null; }
    },
    now: Date.now,
    ...overrides,
  };
}

export type GradeColdBootDrillResult =
  | {
      ok: true;
      drillId: string;
      sample: DrillSample;
      report: CarrySufficiencyReport;
      transcriptPath: string;
      alreadyGraded: boolean;
    }
  | { ok: false; error: string; note: string };

export async function gradeColdBootDrill(
  ownerId: string,
  drillId: string,
  overrides: Partial<GradeColdBootDrillDeps> = {},
): Promise<GradeColdBootDrillResult> {
  const deps = gradeDeps(overrides);
  const ledger = await deps.readLedger();
  const requested = ledger.find((event) => event.drillId === drillId && event.ownerId === ownerId);
  if (!requested) return { ok: false, error: 'unknown_drill', note: 'No durable drill request matches this owner and id.' };

  const existing = ledger.find(
    (event) => event.drillId === drillId && event.ownerId === ownerId && event.kind === 'carry-drill-graded',
  );
  if (existing?.lookups) {
    const sample = { sessionClass: existing.sessionClass, lookups: existing.lookups };
    return {
      ok: true,
      drillId,
      sample,
      report: reportFromLedger(ledger),
      transcriptPath: existing.transcriptPath ?? '',
      alreadyGraded: true,
    };
  }

  const hostEvents = await deps.readHostEvents(ownerId);
  const respawn = [...hostEvents].reverse().find(
    (event) => event.kind === 'carry-drill-respawned' && event.drillId === drillId,
  );
  if (!respawn) {
    const failure = [...hostEvents].reverse().find(
      (event) => event.kind === 'carry-drill-respawn-failed' && event.drillId === drillId,
    );
    if (failure) {
      return {
        ok: false,
        error: 'respawn_failed',
        note: `The host kept the current process alive because drill respawn preparation failed (${failure.reason ?? 'unknown reason'}).`,
      };
    }
    return { ok: false, error: 'respawn_not_observed', note: 'The host has not durably recorded this drill successor yet.' };
  }
  if (!respawn.launchContextPath) {
    return { ok: false, error: 'carry_path_missing', note: 'The host event lacks the delivered carry-file path; refusing to guess.' };
  }
  const carryText = await deps.readCarry(respawn.launchContextPath);
  if (carryText == null) {
    return { ok: false, error: 'carry_unreadable', note: 'The recorded carry file is absent, unsafe, or unreadable.' };
  }
  const transcript = await deps.loadTranscript(ownerId, respawn.nativeId ?? null);
  if (!transcript) {
    return { ok: false, error: 'successor_transcript_unavailable', note: 'The fresh native transcript is not readable yet; grade at the next clean boundary.' };
  }

  const marker = `⟦carry-drill:${drillId}⟧`;
  const markerAt = transcript.turns.findIndex((turn) => turn.text.includes(marker));
  if (markerAt < 0) {
    return { ok: false, error: 'drill_marker_missing', note: 'The successor transcript does not contain the exact drill marker.' };
  }
  const gradeAt = transcript.turns.findIndex((turn, index) => {
    if (index <= markerAt || turn.role !== 'tool_use') return false;
    return (turn.toolName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').endsWith('sessioncarrydrill') && turn.text.includes(drillId);
  });
  const window = transcript.turns.slice(markerAt + 1, gradeAt >= 0 ? gradeAt + 1 : undefined);
  const sample: DrillSample = {
    sessionClass: requested.sessionClass,
    lookups: extractRecoveryLookups(window, carryText),
  };
  const graded: ColdBootDrillLedgerEvent = {
    ts: new Date(deps.now()).toISOString(),
    kind: 'carry-drill-graded',
    drillId,
    ownerId,
    sessionClass: requested.sessionClass,
    lookups: sample.lookups,
    transcriptPath: transcript.ref,
  };
  if (!(await deps.appendLedger(graded))) {
    return { ok: false, error: 'grade_persist_failed', note: 'The mechanical sample was computed but could not be durably recorded.' };
  }
  return {
    ok: true,
    drillId,
    sample,
    report: reportFromLedger([...ledger, graded]),
    transcriptPath: transcript.ref,
    alreadyGraded: false,
  };
}

export async function reportColdBootDrills(
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]> = readColdBootDrillLedger,
): Promise<CarrySufficiencyReport> {
  return reportFromLedger(await readLedger());
}
