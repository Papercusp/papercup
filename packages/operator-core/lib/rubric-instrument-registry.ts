/**
 * Rubric instrument registry (test-rubric-unification-2026-10-12 P-005 / R-5, plan D-006).
 *
 * A rubric criterion that binds an instrument (`check: { kind:'instrument', instrumentKey }`
 * or the legacy criterion-level `instrumentKey` / trailing `[instrumentKey: …]` model token)
 * claims that SOMETHING measures it. Before this registry that claim was free text: a live
 * census (2026-10-13, D-006) found ~60 distinct keys across stored rubrics with no evaluator
 * behind them, so a grader read the key, found nothing to run, and rated by hand.
 *
 * This module is the single answer to "is this key measurable, and how":
 *
 *   - COMMAND instruments run an argv (no shell) on the host and parse one number out of
 *     stdout, optionally as the rate between two samples. Seeded with the performance
 *     audit's host instruments, whose names (`host:psi-cpu-some-avg10-pct`, …) are reused
 *     VERBATIM from docs/audits/application-performance-reliability-audit-2026-10-01-evidence.json
 *     so a rubric can bind the same key the audit recorded.
 *   - PLATFORM instruments are the keys scorecards.ts already resolves in-process into
 *     platform-computed instrument snapshots (goal-mode, holder-behavior, gate-reuse audit).
 *     They are registered here so authoring accepts them; scorecards.ts derives its resolver
 *     set from {@link platformComputedInstrumentKeys} instead of a second hand-kept list.
 *   - `none` is the explicit MANUAL contract and is never looked up.
 *
 * Authoring (rubrics:propose / rubrics:amend) refuses a NEW or CHANGED binding to a key
 * that is not registered; a key carried unchanged from the stored revision of the same
 * criterion is grandfathered and reported, so the ~60 legacy rubrics stay amendable.
 */
import { execFile } from 'node:child_process';
import { effectiveCriterionInstrumentKey } from './rubrics';
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';
import { HOLDER_BEHAVIOR_INSTRUMENT_KEYS } from './goal-holder-behavior-metrics';
import { GOAL_MODE_INSTRUMENT_KEYS } from './goal-mode-computed-instruments';
import { GATE_REUSE_AUDIT_INSTRUMENT_KEY } from './release/gate-fire-ledger';

/** The explicit manual binding: the criterion is deliberately graded by a person. */
export const MANUAL_INSTRUMENT_KEY = 'none';

export type InstrumentUnit = '%' | 'cores' | 's' | 'count';

export interface InstrumentParseContext {
  /** Epoch ms at which the sample was taken (for age-style instruments). */
  now: number;
}

export interface CommandInstrument {
  key: string;
  evaluator: 'command';
  description: string;
  unit: InstrumentUnit;
  /** Executable + arguments, run WITHOUT a shell. */
  argv: readonly [string, ...string[]];
  timeoutMs: number;
  /** One number from stdout, or null when stdout does not carry the expected shape. */
  parse(stdout: string, ctx: InstrumentParseContext): number | null;
  /**
   * Two-sample instruments (a cumulative counter): the argv runs twice `intervalMs` apart
   * and the reading is `combine(first, second, elapsedMs)`.
   */
  sample?: { intervalMs: number; combine(first: number, second: number, elapsedMs: number): number };
}

export interface PlatformInstrument {
  key: string;
  evaluator: 'platform';
  description: string;
  /** Where the in-process resolver lives; these keys are never executed here. */
  resolvedBy: 'scorecards:instrument-snapshots';
}

export type RegisteredInstrument = CommandInstrument | PlatformInstrument;

/** `/proc/pressure/<resource>` → the avg10 percentage of the `some` or `full` line. */
export function parsePsiAvg10(stdout: string, line: 'some' | 'full'): number | null {
  for (const raw of stdout.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(`${line} `)) continue;
    const match = /(?:^|\s)avg10=(\d+(?:\.\d+)?)(?:\s|$)/.exec(trimmed);
    return match ? Number(match[1]) : null;
  }
  return null;
}

/** cgroup v2 `cpu.stat` → cumulative `usage_usec`. */
export function parseCgroupUsageUsec(stdout: string): number | null {
  const match = /^usage_usec\s+(\d+)\s*$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

/** `df --output=pcent <path>` → the used percentage on the data line. */
export function parseDfPercent(stdout: string): number | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const data = lines.find((l) => /^\d+%$/.test(l));
  return data ? Number(data.slice(0, -1)) : null;
}

/** `/proc/loadavg` → the 1-minute load average (the first field). */
export function parseLoadavg1(stdout: string): number | null {
  const first = stdout.trim().split(/\s+/)[0];
  return first && /^\d+(?:\.\d+)?$/.test(first) ? Number(first) : null;
}

/**
 * `docker ps --format '{{.CreatedAt}}'` lines (`2026-10-12 21:03:11 -0400 EDT`) → the age in
 * seconds of the OLDEST container at `now`; 0 when no container matched; null when any line
 * fails to parse (a format change must not read as "no stale containers").
 */
export function parseOldestDockerAgeSec(stdout: string, ctx: InstrumentParseContext): number | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})\b/.exec(line);
    if (!match) return null;
    const created = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
    if (Number.isNaN(created)) return null;
    oldest = Math.min(oldest, created);
  }
  return Math.max(0, Math.round((ctx.now - oldest) / 1000));
}

function psi(resource: 'cpu' | 'io' | 'memory', line: 'some' | 'full'): CommandInstrument {
  return {
    key: `host:psi-${resource}-${line}-avg10-pct`,
    evaluator: 'command',
    description:
      `Linux pressure-stall ${resource} '${line}' avg10: percent of the last 10s in which ` +
      `${line === 'some' ? 'at least one task' : 'all non-idle tasks'} stalled on ${resource}.`,
    unit: '%',
    argv: ['cat', `/proc/pressure/${resource}`],
    timeoutMs: 5_000,
    parse: (stdout) => parsePsiAvg10(stdout, line),
  };
}

const COMMAND_INSTRUMENTS: readonly CommandInstrument[] = Object.freeze([
  psi('cpu', 'some'),
  psi('cpu', 'full'),
  psi('io', 'some'),
  psi('io', 'full'),
  psi('memory', 'some'),
  psi('memory', 'full'),
  {
    key: 'host:cgroup-cpu-delta-cores',
    evaluator: 'command',
    description:
      'Host-wide CPU actually consumed, in cores: the delta of the root cgroup v2 cpu.stat ' +
      'usage_usec over a 2s window (two samples, never a lifetime average).',
    unit: 'cores',
    argv: ['cat', '/sys/fs/cgroup/cpu.stat'],
    timeoutMs: 5_000,
    parse: (stdout) => parseCgroupUsageUsec(stdout),
    sample: {
      intervalMs: 2_000,
      combine: (first, second, elapsedMs) =>
        elapsedMs > 0 ? Math.round(((second - first) / (elapsedMs * 1000)) * 1000) / 1000 : 0,
    },
  },
  {
    key: 'host:df-root-used-pct',
    evaluator: 'command',
    description: 'Used space on the root filesystem, percent (df --output=pcent /).',
    unit: '%',
    argv: ['df', '--output=pcent', '/'],
    timeoutMs: 10_000,
    parse: (stdout) => parseDfPercent(stdout),
  },
  {
    key: 'host:docker-test-container-max-age-s',
    evaluator: 'command',
    description:
      'Age in seconds of the oldest running Testcontainers container (label ' +
      'org.testcontainers=true); 0 when none is running. A large value is a leaked test container.',
    unit: 's',
    argv: ['docker', 'ps', '--filter', 'label=org.testcontainers=true', '--format', '{{.CreatedAt}}'],
    timeoutMs: 15_000,
    parse: (stdout, ctx) => parseOldestDockerAgeSec(stdout, ctx),
  },
  {
    key: 'host:loadavg1-not-authoritative',
    evaluator: 'command',
    description:
      '1-minute load average, recorded by the performance audit as CONTEXT ONLY: load counts ' +
      'idle and uninterruptible waiters, so it is never by itself evidence of a bottleneck.',
    unit: 'count',
    argv: ['cat', '/proc/loadavg'],
    timeoutMs: 5_000,
    parse: (stdout) => parseLoadavg1(stdout),
  },
]);

/**
 * Every key scorecards.ts resolves in-process into a platform-computed instrument snapshot.
 * A function (not a module constant) so an import cycle through scorecards/rubrics can never
 * observe a half-initialised value.
 */
export function platformComputedInstrumentKeys(): string[] {
  return [
    'woe.goal-mode-base-scorecard',
    GATE_REUSE_AUDIT_INSTRUMENT_KEY,
    ...Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS),
    ...Object.values(GOAL_MODE_INSTRUMENT_KEYS),
  ];
}

/** The full registry, keyed by instrumentKey. */
export function instrumentRegistry(): ReadonlyMap<string, RegisteredInstrument> {
  const registry = new Map<string, RegisteredInstrument>();
  for (const instrument of COMMAND_INSTRUMENTS) registry.set(instrument.key, instrument);
  for (const key of platformComputedInstrumentKeys()) {
    if (registry.has(key)) continue;
    registry.set(key, {
      key,
      evaluator: 'platform',
      description: 'Resolved in-process by scorecards:emit / scorecards:evaluate as a platform-computed snapshot.',
      resolvedBy: 'scorecards:instrument-snapshots',
    });
  }
  return registry;
}

export function isManualInstrumentKey(key: string | null | undefined): boolean {
  return (key ?? '').trim().toLowerCase() === MANUAL_INSTRUMENT_KEY;
}

export function getRegisteredInstrument(key: string): RegisteredInstrument | null {
  return instrumentRegistry().get(key.trim()) ?? null;
}

export function registeredInstrumentKeys(): string[] {
  return [...instrumentRegistry().keys()].sort();
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface InstrumentReading {
  key: string;
  unit: InstrumentUnit;
  /** null when the command failed or its output did not parse — never a silent 0. */
  value: number | null;
  measuredAt: string;
  argv: readonly string[];
  error?: string;
}

export interface InstrumentRunDeps {
  /** Runs argv without a shell; resolves stdout. Defaults to child_process.execFile. */
  exec?: (argv: readonly [string, ...string[]], timeoutMs: number) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultExec(argv: readonly [string, ...string[]], timeoutMs: number): Promise<string> {
  const [file, ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * Measure one registered COMMAND instrument. Platform instruments and unknown keys throw:
 * the caller asked to run something this module does not execute.
 */
export async function runInstrument(key: string, deps: InstrumentRunDeps = {}): Promise<InstrumentReading> {
  const instrument = getRegisteredInstrument(key);
  if (!instrument) {
    throw new Error(`unregistered instrument '${key}' — registered: ${registeredInstrumentKeys().join(', ')}`);
  }
  if (instrument.evaluator !== 'command') {
    throw new Error(`instrument '${key}' is platform-computed (${instrument.resolvedBy}); it is not run as a command`);
  }
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = { key: instrument.key, unit: instrument.unit, argv: instrument.argv };
  const sampleOnce = async (): Promise<{ value: number | null; at: number }> => {
    const stdout = await exec(instrument.argv, instrument.timeoutMs);
    const at = now();
    return { value: instrument.parse(stdout, { now: at }), at };
  };
  try {
    const first = await sampleOnce();
    if (first.value === null) {
      return { ...base, value: null, measuredAt: new Date(first.at).toISOString(), error: 'output did not parse' };
    }
    if (!instrument.sample) {
      return { ...base, value: first.value, measuredAt: new Date(first.at).toISOString() };
    }
    await sleep(instrument.sample.intervalMs);
    const second = await sampleOnce();
    if (second.value === null) {
      return { ...base, value: null, measuredAt: new Date(second.at).toISOString(), error: 'second sample did not parse' };
    }
    return {
      ...base,
      value: instrument.sample.combine(first.value, second.value, second.at - first.at),
      measuredAt: new Date(second.at).toISOString(),
    };
  } catch (error) {
    return {
      ...base,
      value: null,
      measuredAt: new Date(now()).toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Authoring guard ──────────────────────────────────────────────────────────

export interface InstrumentBindingCriterion {
  key: string;
  model?: string;
  instrumentKey?: string;
  check?: RubricCriterionCheck;
}

export interface InstrumentBindingAudit {
  /** New or changed bindings to unregistered keys — the authoring call is refused. */
  refused: Array<{ criterion: string; instrumentKey: string; priorInstrumentKey: string | null }>;
  /** Unregistered keys carried unchanged from the stored revision — accepted and reported. */
  grandfathered: Array<{ criterion: string; instrumentKey: string }>;
}

/**
 * PURE: classify every instrument binding in `next` against the registry and the stored
 * revision `prior` (empty for a brand-new rubric). Manual (`none`) and registered keys pass.
 */
export function auditInstrumentBindings(input: {
  prior: readonly InstrumentBindingCriterion[];
  next: readonly InstrumentBindingCriterion[];
}): InstrumentBindingAudit {
  const registry = instrumentRegistry();
  const priorByKey = new Map(input.prior.map((c) => [c.key, effectiveCriterionInstrumentKey(c)]));
  const audit: InstrumentBindingAudit = { refused: [], grandfathered: [] };
  for (const criterion of input.next) {
    const bound = effectiveCriterionInstrumentKey(criterion);
    if (!bound || isManualInstrumentKey(bound) || registry.has(bound)) continue;
    const prior = priorByKey.get(criterion.key) ?? null;
    if (prior === bound) audit.grandfathered.push({ criterion: criterion.key, instrumentKey: bound });
    else audit.refused.push({ criterion: criterion.key, instrumentKey: bound, priorInstrumentKey: prior });
  }
  return audit;
}

// A type alias, not an interface: tool handlers return it as `Record<string, unknown>`, and an
// interface has no implicit index signature (TS2322 in rubrics:amend's executeAmend).
export type UnregisteredInstrumentRefusal = {
  ok: false;
  code: 'unregistered_instrument';
  error: string;
  refused: InstrumentBindingAudit['refused'];
  registeredKeys: string[];
  next: string;
};

/** The authoring refusal for an audit with refused bindings, or null when there are none. */
export function unregisteredInstrumentRefusal(audit: InstrumentBindingAudit): UnregisteredInstrumentRefusal | null {
  if (audit.refused.length === 0) return null;
  const named = audit.refused
    .map((r) => `${r.criterion} → '${r.instrumentKey}'${r.priorInstrumentKey ? ` (was '${r.priorInstrumentKey}')` : ''}`)
    .join('; ');
  return {
    ok: false,
    code: 'unregistered_instrument',
    error:
      `instrument binding refused: ${named}. An instrumentKey must name a registered instrument ` +
      `(something that can actually measure the criterion) or be '${MANUAL_INSTRUMENT_KEY}' for a deliberately manual check.`,
    refused: audit.refused,
    registeredKeys: registeredInstrumentKeys(),
    next:
      `Bind one of registeredKeys, use a structured check (kind:'tests'|'sql'|…) instead, or set ` +
      `instrumentKey:'${MANUAL_INSTRUMENT_KEY}'. A new measurable instrument is added to ` +
      `packages/operator-core/lib/rubric-instrument-registry.ts first.`,
  };
}
