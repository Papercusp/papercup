/**
 * Pipeline stall incidents (WI-6554700010048238, plan pipeline-stall-resilience-2026-11-14).
 *
 * THE PROBLEM THIS SOLVES: a ~4-day git-sync freeze produced a dozen unowned `nit` rows from
 * different agents minutes apart, each describing the same stall, and nothing ever escalated.
 * The fix extends the existing detectors instead of adding a parallel incident system:
 *
 *   1. ONE incident per stall. Agent sightings filed through `improvements:capture` without a
 *      key get the per-harness default key from {@link defaultStallCaptureConditionKey}
 *      (stored as `payload.watchdogKey`), so the first sighting opens the incident and every
 *      later one attaches to it through the keyed coalesce instead of opening a new row.
 *      NOT YET: the watchdog's own alarm does not mint an incident. `git-sync-stall:` is not in
 *      the condition bridge's actionable catalog (`coord/actionable-conditions.ts`), so the
 *      bridge skips it as `not-actionable`. Minting from the alarm is WI-6554700010048637.
 *   2. SEVERITY RISES WITH DURATION. While a stall persists, the watchdog calls
 *      {@link raiseStallIncidentSeverity} each sweep. {@link stallSeverityRaise} maps the stall's
 *      age to minor / major / critical and only ever raises. The incident gets one comment per
 *      tier crossing, keyed so concurrent watchdog hosts cannot post it twice.
 *
 * The rules are pure; the raiser takes its reads and writes as injected deps so it is unit-testable.
 */

export type StallTier = 'minor' | 'major' | 'critical';

/** A stall becomes `major` after one hour. */
export const STALL_TIER_MAJOR_MS = 60 * 60_000;
/** A stall becomes `critical` after six hours. */
export const STALL_TIER_CRITICAL_MS = 6 * 60 * 60_000;

/** Severity tier for a stall that has lasted `durationMs`. Negative/NaN durations read as `minor`. */
export function stallTierFor(durationMs: number): StallTier {
  if (!Number.isFinite(durationMs) || durationMs < STALL_TIER_MAJOR_MS) return 'minor';
  if (durationMs < STALL_TIER_CRITICAL_MS) return 'major';
  return 'critical';
}

/** Work-item severity ranks. A missing or unknown severity ranks as `nit`. */
const SEVERITY_RANK: Readonly<Record<string, number>> = { nit: 0, minor: 1, major: 2, critical: 3 };

function severityRank(severity: string | null | undefined): number {
  return SEVERITY_RANK[(severity ?? '').trim().toLowerCase()] ?? 0;
}

/**
 * The severity an open stall incident should be RAISED to once the stall has lasted
 * `stallDurationMs`, or null when it already sits at or above that tier. Raise-only: a row
 * someone already set to critical is never lowered, and a recovered stall never de-escalates
 * an incident (recovery settles the incident instead).
 */
export function stallSeverityRaise(current: string | null | undefined, stallDurationMs: number): StallTier | null {
  const target = stallTierFor(stallDurationMs);
  return SEVERITY_RANK[target]! > severityRank(current) ? target : null;
}

export interface OpenStallIncident {
  id: string;
  severity: string | null;
}

export interface StallSeverityDeps {
  /** Open, non-observation incident rows holding any of `keys` (condition_key or payload.watchdogKey). */
  findOpenIncidents: (keys: string[]) => Promise<OpenStallIncident[]>;
  /** Write the new severity. Resolve false when the row is gone or the write was refused. */
  bumpSeverity: (id: string, to: StallTier) => Promise<boolean>;
  /** Post a system comment. `idempotencyKey` makes a repeat post from another host a no-op. */
  comment: (id: string, body: string, idempotencyKey: string) => Promise<unknown>;
}

export interface StallSeverityRaised {
  id: string;
  from: string | null;
  to: StallTier;
}

const TIER_THRESHOLD_TEXT: Record<StallTier, string> = {
  minor: 'confirmed by the watchdog',
  major: 'over 1h',
  critical: 'over 6h',
};

/**
 * The comment posted on a tier crossing. It must be IDENTICAL for every host that posts the same
 * (incident, tier): `commentIssue` refuses an idempotent replay whose body differs
 * (`comment_idempotency_conflict`). So it names the tier window and never a live duration.
 */
export function stallSeverityComment(subject: string, from: string | null, to: StallTier): string {
  return (
    `Severity raised ${from ?? 'unset'} → ${to}: the stall on ${subject} is ${TIER_THRESHOLD_TEXT[to]}. ` +
    `Severity rises with stall duration (major after 1h, critical after 6h) and never drops ` +
    `while the incident is open.`
  );
}

/**
 * Raise every open incident for this stall to the tier its duration has reached. Returns the
 * raises it made. Each incident is raised and commented on at most once per tier: the raise
 * is skipped once the row is at the tier, and the comment carries a per-(incident, tier)
 * idempotency key so a second watchdog host racing the same sweep posts nothing.
 */
export async function raiseStallIncidentSeverity(
  input: { keys: string[]; subject: string; stallDurationMs: number },
  deps: StallSeverityDeps,
): Promise<StallSeverityRaised[]> {
  const keys = [...new Set(input.keys.map((k) => k.trim()).filter((k) => k !== ''))];
  if (keys.length === 0 || !Number.isFinite(input.stallDurationMs)) return [];
  const seen = new Set<string>();
  const raised: StallSeverityRaised[] = [];
  for (const incident of await deps.findOpenIncidents(keys)) {
    if (seen.has(incident.id)) continue;
    seen.add(incident.id);
    const to = stallSeverityRaise(incident.severity, input.stallDurationMs);
    if (to === null) continue;
    if (!(await deps.bumpSeverity(incident.id, to))) continue;
    await deps.comment(
      incident.id,
      stallSeverityComment(input.subject, incident.severity, to),
      `stall-severity:${incident.id}:${to}`,
    );
    raised.push({ id: incident.id, from: incident.severity, to });
  }
  return raised;
}

export const GIT_SYNC_STALL_PREFIX = 'git-sync-stall:' as const;
export const STAGING_SYNC_STALL_PREFIX = 'staging-sync-stall:' as const;

/**
 * The harness a git-sync install belongs to. Submodule installs are slugged
 * `<harness>/<submodule path>` (e.g. `papercusp/libs/papercusp-db`), which is not a harness
 * slug the condition bridge can store a row under.
 */
export function gitSyncInstallHarness(installSlug: string): string {
  return installSlug.trim().split('/')[0] ?? installSlug.trim();
}

/**
 * Keyed by HARNESS, not install: a stall usually hits the superproject and all of its
 * submodule installs at once, and that is ONE incident, not one per submodule.
 */
export function gitSyncStallConditionKey(installSlug: string): string {
  return `${GIT_SYNC_STALL_PREFIX}${gitSyncInstallHarness(installSlug)}`;
}

export function stagingSyncStallConditionKey(harness: string): string {
  return `${STAGING_SYNC_STALL_PREFIX}${harness.trim()}`;
}

export type StallKind = 'git-sync' | 'staging-sync';

/**
 * Match an UNKEYED capture's text to a stall incident kind, so `improvements:capture` can
 * default its conditionKey and coalesce it onto the open incident instead of filing a new row.
 * Deliberately narrow: it needs both the subsystem name and a stall word.
 */
export function stallKindMentioned(text: string): StallKind | null {
  const t = text.toLowerCase();
  const stallWord = /\b(stall(ed|s|ing)?|frozen|freeze|wedged|stuck|not (committing|pushing|advancing)|no (commits?|push(es)?))\b/.test(t);
  if (!stallWord) return null;
  if (/\bstaging[- ]sync\b/.test(t)) return 'staging-sync';
  if (/\bgit[- ]sync\b/.test(t)) return 'git-sync';
  return null;
}

/**
 * The DEFAULT conditionKey for an unkeyed `improvements:capture` that reports a pipeline stall.
 *
 * THE FLOOD (WI-6554700010048238): every agent that notices a stalled git-sync files its own row,
 * so one stall became a dozen open bugs. With a shared key the keyed coalesce attaches each later
 * report to the first open row instead. Only bugs and observations qualify: a change or feature
 * that merely MENTIONS a stall is a design proposal, not a sighting of the incident. Only the
 * TITLE is matched (or the first body line when the title is omitted): a body that cites a stall
 * as context for a different bug must not be folded onto the stall incident. An explicit
 * conditionKey always wins at the call site.
 */
export function defaultStallCaptureConditionKey(input: {
  kind?: string | null;
  lane?: string | null;
  title?: string | null;
  body?: string | null;
  harness: string;
}): string | undefined {
  if (input.kind !== 'bug' && input.lane !== 'observation') return undefined;
  const headline = input.title?.trim()
    || (input.body ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '')
    || '';
  const kind = stallKindMentioned(headline);
  if (kind === null) return undefined;
  return kind === 'git-sync'
    ? gitSyncStallConditionKey(input.harness)
    : stagingSyncStallConditionKey(input.harness);
}
