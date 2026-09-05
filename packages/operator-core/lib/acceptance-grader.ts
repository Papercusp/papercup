/** Dedicated, frozen acceptance-grader launch for the plan completion gate. */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import launchAgentTool from './agent-tools/capability/launch-agent';
import { resolveAgentIdentity } from './agent-tools/coordination/identity';
import { readPlanBySlug } from './agent-tools/plans/source';
import { resolveAggregatedVettingCritics } from './agent-tools/scorecards/grader-eligibility';
import { areAcceptanceLineageRelated } from './acceptance-author-identity';
import { readAcceptanceGradingSettlement, type AcceptanceGradingSettlement } from './acceptance-grading-authority';
import { getLatestPlanAudit, summarizeCoverage } from './plan-audits';
import { getAcceptanceRubricForPlan } from './rubrics';
import { listWorkItems } from './work-items';
import type { GraderEligibility, GraderEscalation } from './consult/acceptance-grader-select';
// Manual citation checks must use the same subject tree as the frozen audit, and
// the fresh-judge prompt and the assigned-grader briefs must say so identically —
// so the guidance is single-sourced beside the briefs, in grading-cascade.ts.
import { ACCEPTANCE_CITATION_SPOT_CHECK_GUIDANCE, GRADING_CASCADE_FLAVOR } from './consult/grading-cascade';
import { listTasks } from './task-manager/store';
import { killTask } from './task-manager/control';

type LaunchCtx = Parameters<typeof launchAgentTool.handler>[1];

/**
 * Stable in-process principal that owns automatic acceptance-grader recruitment.
 *
 * A rubric author may ask the plan gate to recruit a judge, but a fresh agent
 * launched *by that author* remains in the author's lineage and therefore cannot
 * supply an independent grade.  The gate and the periodic recovery sweep both
 * recruit through this system principal so the spawned judge is outside the
 * author's launch lineage; direct author calls to launchAcceptanceGrader remain
 * fail-closed below.
 */
export const ACCEPTANCE_GRADING_SWEEP_ACTOR = 'system:acceptance-grading-sweep';

/** One entry of the assigned grader MENU, with its selection provenance. */
export type AssignedGrader = {
  ownerId: string;
  score: number;
  liveness: string;
  /** 'floor' = above the relevance floor; 'minimum' = best-available below it
   * (D-002 [owner] minimum-fill). P-004 reads this to stop a 'minimum' card
   * superseding a 'floor' one under the gate's latest-wins pick, so it has to
   * survive out of selection and onto the lifecycle. */
  via: 'floor' | 'minimum';
};

export type AcceptanceGraderLifecycle = {
  /** 'assigned' (P-011/D-009): existing non-excluded, reachable agents were
   * selected by the relevance router — no fresh judge was launched.
   * 'settled' (WI-1699998): nothing was dispatched at all, because this rubric's
   * grading is ALREADY DECIDED at its current revision — see `settlement`. This is
   * a success, not a failure: re-routing a decided grading burns a non-replenishable
   * independent grader. */
  state: 'launched' | 'deduped' | 'failed' | 'assigned' | 'settled';
  idempotencyKey: string;
  label: string;
  launch?: unknown;
  error?: string;
  /**
   * EI-21923986145923904: passthrough of `capability:launch-agent`'s own
   * three-state fresh-launch verdict (see `FreshLaunchVerdict.agentStarted`) —
   * `true` = observed a real turn, `false` = observed silence (booted then
   * never started), `null` = window expired with no session row ever observed
   * (the honest "unconfirmed" case, NOT proof of death). Only set for state
   * 'launched' launches that went through the fresh-launch verification path
   * (the assigned-existing-grader path never launches, so this stays absent
   * there). Previously computed by the launch tool and silently discarded
   * here, so a `plans:set-plan-status` caller reading a 'launched' result had
   * no way to tell a verified launch from one the tool itself could not
   * confirm — the "reports Launched, but the agent never actually starts"
   * failure read as success all the way up to the plan-ship gate. Read this
   * field, not `state === 'launched'` alone, before treating a grader launch
   * as settled; `agentStarted === null` means re-check in ~1 min rather than
   * waiting on it indefinitely.
   */
  agentStarted?: boolean | null;
  /**
   * Discovery outcome (state 'assigned'): the ordered grader MENU, head first.
   * A MENU rather than one grader since
   * unified-responder-selection-critique-and-grading-2026-08-30 D-001/D-003
   * [owner] — bounded by the shared ACCEPTANCE_GRADING_POLICY (see
   * `selection-policies.ts` for the current min/max), and the tail is NOT
   * woken here: grader k+1 is woken by the cascade only after k replies,
   * declines or expires, carrying k's card.
   */
  graders?: AssignedGrader[];
  /** The grading cascade's conversation (state 'assigned') — the thread the
   * graders reply into, and the row whose cursor the cascade advances. */
  conversationId?: string;
  /** D-009 exclusion audit trail (implementers + heavy consult participants +
   * rubric author + shipper) — set whenever discovery ran. */
  excluded?: string[];
  /** D-008 party-collapse audit trail: candidates dropped because a better-ranked
   * candidate was the SAME PARTY (a rebind chain, or a launcher and what it
   * launched). Distinct from `excluded` — these are duplicate faces of an actor
   * already on the menu, not disqualified actors. ABSENT (not empty) when party
   * resolution faulted and selection degraded to raw-ownerId distinctness. */
  partyCollapsed?: string[];
  /** Structured discovery counts, including the known post-exclusion pool. */
  eligibility?: GraderEligibility;
  /** Explicit escalation when the measured post-exclusion pool is empty. */
  escalation?: GraderEscalation;
  /** Why discovery produced an EMPTY menu and fell through to the fresh launch
   * (state launched/deduped). Below-floor is no longer among these reasons —
   * D-002 replaced it with minimum-fill; see acceptance-grader-select.ts. */
  freshReason?: 'no_eligible_non_excluded' | 'all_eligible_unselectable' | 'degraded' | 'discovery_error';
  /** Set only alongside freshReason:'discovery_error' — the caught error's
   * message, truncated, so a discovery throw is distinguishable from a
   * genuinely empty pool instead of presenting identically to a normal
   * fresh-judge launch (EI-21925808460100711). */
  discoveryError?: string;
  /** Wake delivery for the HEAD grader ({ woke: 0 } = parked; they read the
   * grading request on their next turn — the subscribe is durable). */
  notified?: { woke: number };
  /** Why dispatch was skipped (state 'settled'), or — on any other state — the
   * not-settled reading that ALLOWED the dispatch. Recorded on both paths on
   * purpose: a skip nobody can see is how this bug class hides, and so is a
   * dispatch whose settlement read silently failed open. */
  settlement?: AcceptanceGradingSettlement;
  /** A stable launch receipt may outlive the judge mission it originally
   * represented. When that receipt pointed at an ended/over-age task, these
   * are the stale task ids bypassed before a fresh deterministic retry. */
  staleRecovery?: { retiredTaskIds: string[]; attempts: number };
  /** A judge can fail before grading at all (a terminal model-limit response,
   * or a bounded connection-startup stall with no first-turn progress). The
   * launcher retires that failed mission and makes one cross-backend retry on
   * the same system-account route. */
  terminalRecovery?: {
    retiredTaskIds: string[];
    attempts: number;
    codes: AcceptanceGraderTerminalFailureCode[];
    fallback: { agent: 'codex'; model: 'gpt-5.6-sol'; effort: 'high'; account: 'default' };
  };
};

export const ACCEPTANCE_GRADER_STALE_AFTER_MS = 2 * 60 * 60_000;
const ACCEPTANCE_GRADER_MAX_STALE_RETRIES = 4;
const ACCEPTANCE_GRADER_LOG_TAIL_BYTES = 16_000;
const ACCEPTANCE_GRADER_MAX_TERMINAL_FALLBACKS = 1;
/**
 * A fresh headless launch returns after its spawn/boot verifier, not after the
 * first bytes from the child have necessarily reached its log file. Keep the
 * reconciliation window deliberately small and finite: it catches a terminal
 * first-turn response that races the launch receipt without turning the
 * acceptance path into a background watcher.
 */
export const ACCEPTANCE_GRADER_TERMINAL_LOG_RECHECK_DELAY_MS = 250;
export const ACCEPTANCE_GRADER_TERMINAL_LOG_MAX_RECHECKS = 4;
/**
 * Only an exact connection-startup candidate enters this slower window. A
 * normal launch therefore keeps the one-second terminal-response check above,
 * while a judge that remains on `/rc connecting…` gets one bounded minute to
 * show first-turn progress before the launcher retires it. This is far below
 * the two-hour stale-receipt ceiling without treating an ordinary slow model
 * turn as a connection failure.
 */
export const ACCEPTANCE_GRADER_STARTUP_STALL_RECHECK_DELAY_MS = 2_000;
export const ACCEPTANCE_GRADER_STARTUP_STALL_MAX_RECHECKS = 30;
const ACCEPTANCE_GRADER_FALLBACK = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol' as const,
  effort: 'high' as const,
  account: 'default' as const,
};

export type AcceptanceGraderTerminalFailureCode = 'model_quota_exhausted' | 'startup_connection_stalled';

export interface AcceptanceGraderTerminalFailure {
  code: AcceptanceGraderTerminalFailureCode;
  evidence: string;
}

type AcceptanceGraderLogTailReader = (path: string) => string | Promise<string>;

/**
 * Read a launch receipt's log more than once, but only inside a bounded
 * post-launch window. `capability:launch-agent` returns when the process is
 * spawned/verified, while a headless CLI can write its first-turn quota screen
 * shortly afterwards. A single read therefore creates a race where a dead
 * judge is left running until the quiet-task reaper. The bounded retry is
 * intentionally local to this launch transaction and stops after a fixed
 * number of reads.
 */
export async function detectAcceptanceGraderTerminalFailure(
  logPath: string | null,
  {
    readLogTail,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    delayMs = ACCEPTANCE_GRADER_TERMINAL_LOG_RECHECK_DELAY_MS,
    maxRechecks = ACCEPTANCE_GRADER_TERMINAL_LOG_MAX_RECHECKS,
    startupStallDelayMs = ACCEPTANCE_GRADER_STARTUP_STALL_RECHECK_DELAY_MS,
    startupStallMaxRechecks = ACCEPTANCE_GRADER_STARTUP_STALL_MAX_RECHECKS,
  }: {
    readLogTail: AcceptanceGraderLogTailReader;
    sleep?: (ms: number) => Promise<void>;
    delayMs?: number;
    maxRechecks?: number;
    startupStallDelayMs?: number;
    startupStallMaxRechecks?: number;
  },
): Promise<AcceptanceGraderTerminalFailure | null> {
  if (!logPath) return null;
  const boundedRechecks = Math.max(0, Math.floor(maxRechecks));
  const boundedDelay = Math.max(0, Math.floor(delayMs));
  let latestRawLog = '';
  for (let recheck = 0; recheck <= boundedRechecks; recheck += 1) {
    latestRawLog = await readLogTail(logPath);
    const terminalFailure = classifyAcceptanceGraderTerminalFailure(latestRawLog);
    if (terminalFailure) return terminalFailure;
    if (recheck < boundedRechecks) await sleep(boundedDelay);
  }

  let startupStall = classifyAcceptanceGraderStartupStall(latestRawLog);
  if (!startupStall) return null;

  const boundedStartupRechecks = Math.max(0, Math.floor(startupStallMaxRechecks));
  const boundedStartupDelay = Math.max(0, Math.floor(startupStallDelayMs));
  for (let recheck = 0; recheck < boundedStartupRechecks; recheck += 1) {
    await sleep(boundedStartupDelay);
    latestRawLog = await readLogTail(logPath);
    const terminalFailure = classifyAcceptanceGraderTerminalFailure(latestRawLog);
    if (terminalFailure) return terminalFailure;
    startupStall = classifyAcceptanceGraderStartupStall(latestRawLog);
    if (!startupStall) return null;
  }
  return {
    ...startupStall,
    evidence:
      `${startupStall.evidence}; no first-turn progress after ` +
      `${boundedStartupRechecks * boundedStartupDelay}ms bounded recheck`,
  };
}

function normalizeAcceptanceGraderLog(rawLog: string): string {
  return rawLog
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

/**
 * A bounded, exact detector for a terminal first turn that can never satisfy the
 * acceptance mission. Keep this narrower than a generic "error" scan: the frozen
 * plan evidence is rendered in the same log, so broad words would create false
 * positives from the material the judge was asked to inspect.
 */
export function classifyAcceptanceGraderTerminalFailure(rawLog: string): AcceptanceGraderTerminalFailure | null {
  const normalized = normalizeAcceptanceGraderLog(rawLog);
  const legacyQuota = normalized.match(
    /You've reached your [^\n]{1,120} limit\.[\s\S]{0,240}?Run \/usage-credits to continue or switch models with \/model\./i,
  );
  // EI-22453936824523023: Claude's newer session-limit screen no longer uses
  // the legacy "reached ... limit / switch models" copy. Keep both the exact
  // terminal headline AND one of its recovery prompts in the match: the
  // headline alone can appear in frozen incident evidence, while the paired
  // screen copy is the observable that this running judge cannot grade.
  const sessionQuota = normalized.match(
    /You've hit your session limit\s*·\s*resets [^\n]{1,120}[\s\S]{0,480}?(?:\/usage-credits to finish what you(?:'|’)re working on\.|\/limit-reset to reset your session limit now)/i,
  );
  const quota = legacyQuota ?? sessionQuota;
  if (!quota) return null;
  return {
    code: 'model_quota_exhausted',
    evidence: quota[0].replace(/\s+/g, ' ').trim().slice(0, 400),
  };
}

/**
 * Candidate-only classifier for the exact Claude startup wedge observed in
 * EI-21646725695632868. Duration is deliberately owned by
 * `detectAcceptanceGraderTerminalFailure`; this pure helper only says whether
 * the current tail is still the connection screen and has no evidence that the
 * judge entered its first turn. False negatives are safer than broad matching:
 * frozen plan evidence shares the same log, so generic "connecting" prose must
 * never retire a healthy judge.
 */
export function classifyAcceptanceGraderStartupStall(rawLog: string): AcceptanceGraderTerminalFailure | null {
  const normalized = normalizeAcceptanceGraderLog(rawLog);
  const connecting = normalized.match(/(?:^|\n)\s*\/rc\s+connecting(?:…|\.{3})/i);
  if (!connecting) return null;

  const hasFirstTurnProgress =
    /scorecards:emit|rubrics:get|plans:get|work_items:get|papercusp(?:\.tools:invoke|\/tools:invoke)|\bmcp__|PostToolUse hook|\btool(?:_use| call| invocation)\b/i.test(
      normalized,
    ) ||
    /\b(?:Thinking|Working)\s*(?:\(|·)/.test(normalized) ||
    /^\s*[•└├]\s+/m.test(normalized);
  if (hasFirstTurnProgress) return null;

  const overload = normalized.match(/the MCP proxy is overloaded; retrying[^\n]{0,160}/i);
  const evidence = [connecting[0], overload?.[0]]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return { code: 'startup_connection_stalled', evidence };
}

function readAcceptanceGraderLogTail(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, ACCEPTANCE_GRADER_LOG_TAIL_BYTES);
    if (length <= 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

const trim = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** Shared label algebra: scorecards:emit uses this exact prefix to reap the judge. */
export function acceptanceGraderLabelPrefix(rubricRef: string): string {
  const safe = rubricRef
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `acceptance-grader:${safe || 'rubric'}:`;
}

export function compactSnapshot(input: {
  plan: NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>;
  rubric: NonNullable<Awaited<ReturnType<typeof getAcceptanceRubricForPlan>>>;
  audit: NonNullable<Awaited<ReturnType<typeof getLatestPlanAudit>>>;
  workItems: Awaited<ReturnType<typeof listWorkItems>>;
}) {
  const { row } = input.plan;
  const rubric = input.rubric as unknown as Record<string, unknown>;
  const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  return {
    frozenAt: new Date().toISOString(),
    plan: {
      slug: row.planSlug,
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug,
      version: row.version,
      contentHash: row.contentHash,
      items: row.items.map((i) => ({ id: i.id, status: i.status, text: trim(i.text, 180) })),
      decisions: row.decisions.map((d) => ({ id: d.id, title: trim(d.title, 120), body: trim(d.body, 260) })),
    },
    rubric: {
      rubricId: rubric.rubricId,
      title: trim(rubric.title, 180),
      proposedBy: rubric.proposedBy ?? rubric.createdBy ?? null,
      criteria: criteria.map((raw) => {
        const c = (raw ?? {}) as Record<string, unknown>;
        return { key: c.key, title: trim(c.title ?? c.label, 120), description: trim(c.description, 260) };
      }),
    },
    audit: {
      auditSeq: input.audit.auditSeq,
      createdBy: input.audit.createdBy,
      auditedSha: input.audit.auditedSha,
      summary: trim(input.audit.summary, 500),
      coverage: summarizeCoverage(input.audit.items),
      items: input.audit.items.map((i) => ({
        itemId: i.itemId,
        verdict: i.verdict,
        citations: i.citations.map((c) => ({ kind: c.kind, path: c.path, line: c.line, symbol: c.symbol })),
      })),
    },
    terminalWork: input.workItems.map((w) => ({
      id: w.id,
      state: w.state,
      title: trim(w.title, 140),
      terminalOwner: w.terminalOwner,
      completionRef: trim(w.terminalCompletionRef, 220),
      evidence: w.terminalCompletionEvidence,
    })),
  };
}

export const ACCEPTANCE_SNAPSHOT_CAP_CHARS = 5_800;

/**
 * What a truncated package MUST tell the judge. Without it a judge cannot tell
 * "this field is empty" from "this field was deleted to fit a cap", so it stalls
 * instead of reporting the gap (EI-21615102901369580).
 */
const DEGRADED_SNAPSHOT_NOTICE =
  'TRUNCATED EVIDENCE PACKAGE. Every field named in droppedFields is ABSENT FROM THIS SNAPSHOT. ' +
  'That absence is a limit of this package, NOT evidence that the underlying record is empty. ' +
  'Do NOT rate a criterion from that absence. Follow recovery before returning NOT GRADED; if a ' +
  'canonical read fails or its identity differs from frozenIdentity, name that exact gap and grade the rest.';

/**
 * Fit the frozen evidence package under the size cap.
 *
 * Degrades PROGRESSIVELY and BY VALUE — stopping at the first stage that fits — and
 * always stamps `contextIntegrity` when anything was surrendered.
 *
 * EI-21615102901369580: the previous implementation jumped straight from "full" to a
 * maximally-stripped shape that deleted `audit.items[].citations`, plan item text,
 * decision bodies and terminal-work evidence in a single blanket step, with no marker
 * of any kind. Those are exactly the bytes a grader needs — the class rubrics require
 * it to spot-check the implementer's audit citations — so a judge over the cap got a
 * package that looked complete, carried no evidence, and could only stall. Citations
 * are therefore surrendered LAST, and never silently.
 */
export function boundedSnapshotJson(snapshot: ReturnType<typeof compactSnapshot>): string {
  const cap = ACCEPTANCE_SNAPSHOT_CAP_CHARS;
  const full = JSON.stringify(snapshot);
  if (full.length <= cap) return full;

  const working: Record<string, unknown> = { ...snapshot };
  const dropped: string[] = [];
  const plan = () => working.plan as Record<string, unknown>;
  const audit = () => working.audit as Record<string, unknown>;
  const recovery = {
    frozenIdentity: {
      planVersion: snapshot.plan.version,
      planContentHash: snapshot.plan.contentHash,
      auditSeq: snapshot.audit.auditSeq,
    },
    rule:
      'Before NOT GRADED, recover only with these read-only Papercusp tools. Use recovered evidence only ' +
      'when plans:get still reports frozenIdentity and the completion audit sequence matches.',
    reads: {
      plan: {
        tool: 'plans:get',
        args: {
          slug: snapshot.plan.slug,
          harness: snapshot.plan.harnessSlug,
          mode: 'full',
          shipReadiness: true,
        },
      },
      specEvidence: {
        tool: 'plans:get-spec-evidence',
        args: { slug: snapshot.plan.slug, harness: snapshot.plan.harnessSlug, limit: 500 },
      },
      terminalWork: {
        tool: 'work_items:get',
        args: { harness: snapshot.plan.harnessSlug, detail: true, threadLimit: 10 },
        idsFrom: 'terminalWork[].id',
        payloadTier: "pass 'full' through tools:invoke",
      },
    },
  };
  const render = (): string =>
    JSON.stringify({
      ...working,
      contextIntegrity: {
        degraded: true,
        fullChars: full.length,
        capChars: cap,
        droppedFields: [...dropped],
        notice: DEGRADED_SNAPSHOT_NOTICE,
        recovery,
      },
    });

  // Least decision-relevant bytes first; the grader's spot-check material last.
  const steps: Array<{ label: string; apply: () => void }> = [
    {
      label: 'terminalWork[].evidence',
      apply: () => {
        working.terminalWork = snapshot.terminalWork.map((w) => ({
          id: w.id,
          state: w.state,
          title: w.title,
          terminalOwner: w.terminalOwner,
          completionRef: w.completionRef,
        }));
      },
    },
    {
      label: 'plan.decisions[].body shortened to 120 chars',
      apply: () => {
        working.plan = {
          ...plan(),
          decisions: snapshot.plan.decisions.map((d) => ({ ...d, body: trim(d.body, 120) })),
        };
      },
    },
    {
      label: 'plan.items[].text shortened to 90 chars',
      apply: () => {
        working.plan = { ...plan(), items: snapshot.plan.items.map((i) => ({ ...i, text: trim(i.text, 90) })) };
      },
    },
    {
      label: 'audit.summary shortened to 200 chars',
      apply: () => {
        working.audit = { ...audit(), summary: trim(snapshot.audit.summary, 200) };
      },
    },
    {
      label: 'rubric.criteria[].description shortened to 120 chars',
      apply: () => {
        working.rubric = {
          ...(working.rubric as Record<string, unknown>),
          criteria: snapshot.rubric.criteria.map((c) => ({ ...c, description: trim(c.description, 120) })),
        };
      },
    },
    {
      label: 'terminalWork[].title',
      apply: () => {
        working.terminalWork = snapshot.terminalWork.map((w) => ({
          id: w.id,
          state: w.state,
          terminalOwner: w.terminalOwner,
          completionRef: w.completionRef,
        }));
      },
    },
    {
      label: 'plan.decisions[].body',
      apply: () => {
        working.plan = { ...plan(), decisions: snapshot.plan.decisions.map((d) => ({ id: d.id, title: d.title })) };
      },
    },
    {
      label: 'plan.items[].text',
      apply: () => {
        working.plan = { ...plan(), items: snapshot.plan.items.map((i) => ({ id: i.id, status: i.status })) };
      },
    },
    {
      label: 'terminalWork[].terminalOwner/completionRef',
      apply: () => {
        working.terminalWork = snapshot.terminalWork.map((w) => ({ id: w.id, state: w.state }));
      },
    },
    {
      label: 'audit.items[].citations — LAST RESORT: the grader can no longer spot-check the audit',
      apply: () => {
        working.audit = {
          ...audit(),
          items: snapshot.audit.items.map((i) => ({ itemId: i.itemId, verdict: i.verdict })),
        };
      },
    },
  ];

  for (const step of steps) {
    const candidate = render();
    if (candidate.length <= cap) return candidate;
    step.apply();
    dropped.push(step.label);
  }
  return render();
}

/**
 * D-009 (get-feedback-relevance-consults-2026-08-16, P-011) — discovery-FIRST
 * grader resolution: route the plan + acceptance rubric through the relevance
 * router with the independence exclusion set (implementers + heavy consult
 * participants + rubric author + shipper).
 *
 * SUPERSEDED IN ONE RESPECT by
 * unified-responder-selection-critique-and-grading-2026-08-30 D-001/D-002/D-003
 * [owner]: this no longer resolves ONE above-floor grader. It resolves a MENU
 * bounded by the shared ACCEPTANCE_GRADING_POLICY (see `selection-policies.ts`
 * for the current min/max), below-floor MINIMUM-FILLS rather than minting a
 * fresh session, and delivery is a cascade —
 * only the head is woken here. Fresh-mint survives strictly for an EMPTY menu
 * (nobody eligible, nobody reachable, or relevance unmeasurable). Discovery is
 * still a service, never a new failure mode: any discovery fault falls through
 * to the fresh launch.
 *
 * Same signature as launchAcceptanceGrader so the set-plan-status seam can use
 * either interchangeably (its tests inject their own).
 */
type GraderDiscoveryResult = {
  verdict: 'assigned' | 'fresh';
  /** The ordered menu, head first. Empty exactly when verdict is 'fresh'. */
  graders: AssignedGrader[];
  /** The snapshot to persist on the cascade row (menu provenance + fill pool).
   * Absent when the menu is empty — there is no cascade to open. */
  routing?: unknown;
  excluded: string[];
  /** D-008 party-collapse audit trail; absent when party resolution faulted. */
  partyCollapsed?: string[];
  eligibility?: GraderEligibility;
  escalation?: GraderEscalation;
  freshReason?: 'no_eligible_non_excluded' | 'all_eligible_unselectable' | 'degraded';
};

/**
 * Discovery must exclude the same current-revision vetting critics that the
 * scorecard writer later refuses. The shared resolver covers both supported
 * vetting channels (consult and work-item), so routing cannot select a critic
 * merely because their critique was recorded on a work item instead of in a
 * consult conversation.
 */
export async function resolveAcceptanceGraderDiscoveryExtraExclusions(
  rubric: {
    rubricId: string;
    revision?: number | null;
    proposedBy?: string | null;
    createdBy?: string | null;
  },
  shipperId: string | null,
  readVettingCritics: typeof resolveAggregatedVettingCritics = resolveAggregatedVettingCritics,
): Promise<string[]> {
  const { critics } = await readVettingCritics(rubric.rubricId, rubric.revision ?? null);
  return [
    ...new Set(
      [rubric.proposedBy, rubric.createdBy, shipperId, ...critics]
        .filter((identity): identity is string => typeof identity === 'string')
        .map((identity) => identity.trim())
        .filter(Boolean),
    ),
  ];
}

/** Prod discovery wiring: the P-002 router + embedder + liveness oracle behind
 * selectAcceptanceGrader. Injected as `deps.discover` in tests — this default
 * reaches the org PG, which a unit test must never do. */
async function prodDiscoverGrader(
  plan: NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>,
  rubric: NonNullable<Awaited<ReturnType<typeof getAcceptanceRubricForPlan>>>,
  ctx: LaunchCtx,
): Promise<GraderDiscoveryResult> {
  const [{ getOrgPg }, { routeConsult }, { buildQueryEmbedder }, { resolveSessionStates }, { selectAcceptanceGrader }] =
    await Promise.all([
      import('@papercusp/db-org'),
      import('./consult/relevance-router'),
      import('./agent-tools/search/embedder'),
      import('./agent-tools/coordination/liveness-oracle'),
      import('./consult/acceptance-grader-select'),
    ]);
  const { lineagePartyKeys } = await import('./acceptance-author-identity');
  const embed = await buildQueryEmbedder();
  const r = rubric as unknown as {
    rubricId: string;
    revision?: number | null;
    title?: string;
    proposedBy?: string | null;
    createdBy?: string | null;
    criteria?: Array<{ key?: string; title?: string; model?: string }>;
  };
  const rubricText = [
    r.title ?? r.rubricId,
    ...(Array.isArray(r.criteria)
      ? r.criteria.map((c) => `${c.key ?? ''}: ${c.title ?? ''} ${c.model ?? ''}`.trim())
      : []),
  ].join('\n');
  let shipperId: string | null = null;
  try {
    const { resolveAgentIdentity } = await import('./agent-tools/coordination/identity');
    shipperId = resolveAgentIdentity(ctx as never).ownerId;
  } catch {
    /* unattributable shipper — the computed set still excludes implementers */
  }
  const extraExclusions = await resolveAcceptanceGraderDiscoveryExtraExclusions(r, shipperId);
  const selection = await selectAcceptanceGrader(
    {
      workspaceId: plan.row.workspaceId,
      planSlug: plan.row.planSlug,
      planContent: plan.row.content,
      rubricText,
      extraExclusions,
    },
    {
      getSql: () => getOrgPg().sql,
      getCandidateRoles: async (workspaceId, ownerIds) => {
        if (ownerIds.length === 0) return new Map<string, string | null>();
        // coord:send admits only COORD_ROLES. Resolve the durable role in the
        // same workspace before allowing the router to assign a blocking ask;
        // absent rows/roles remain absent and are rejected by the selector.
        const rows = await getOrgPg().sql<Array<{ owner_id: string; agent_role: string | null }>>`
          SELECT owner_id, agent_role
            FROM harness_shared.coord_presence
           WHERE workspace_id = ${workspaceId}
             AND owner_id = ANY(${ownerIds}::text[])
        `;
        return new Map(rows.map((row) => [row.owner_id, row.agent_role] as const));
      },
      // D-008: one agent can hold several coordination identities, so the menu
      // has to be distinct by PARTY, not by ownerId. Same ledger the acceptance
      // gate already resolves scorecard authors through.
      getPartyKeys: (workspaceId, ownerIds) => lineagePartyKeys(ownerIds, { sql: getOrgPg().sql, workspaceId }),
      route: (params) =>
        routeConsult(params, {
          getSql: () => getOrgPg().sql,
          embed,
          getLiveness: async (ownerIds) => {
            const verdicts = await resolveSessionStates(
              ownerIds.map((ownerId) => ({ ownerId })),
              { hydratePerId: true },
            );
            return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, v.sessionState]));
          },
        }),
    },
  );
  return {
    verdict: selection.verdict,
    graders: selection.graders.map((selected) => ({
      ownerId: selected.candidate.ownerId,
      score: selected.candidate.score,
      liveness: selected.candidate.liveness,
      via: selected.via,
    })),
    ...(selection.routing ? { routing: selection.routing } : {}),
    excluded: selection.excluded,
    ...(selection.partyCollapsed ? { partyCollapsed: selection.partyCollapsed } : {}),
    eligibility: selection.eligibility,
    ...(selection.escalation ? { escalation: selection.escalation } : {}),
    ...(selection.freshReason ? { freshReason: selection.freshReason } : {}),
  };
}

// The grader briefs live in consult/grading-cascade.ts alongside the CASCADE
// copy, so the first grader and the ones the cascade wakes cannot drift into
// being told different things. Re-exported here because this module is where
// every existing importer looks for them.
export { buildAssignedAcceptanceGraderBrief, buildMinimumFillAcceptanceGraderBrief } from './consult/grading-cascade';

/** What opening the grading cascade has to be told, and what it reports back. */
export interface OpenGradingCascadeParams {
  /** The PLAN's workspace, not the shipper's ambient context: the cascade row is
   * workspace-partitioned and every later trigger (the expiry sweep especially)
   * finds it by that partition. */
  workspaceId: string;
  planSlug: string;
  harnessSlug: string | null;
  rubricId: string;
  /** The ordered menu. Only the HEAD is woken; the tail is persisted for the
   * cascade to reach when the head replies, declines or expires. */
  graders: AssignedGrader[];
  /** The routing snapshot to persist (menu provenance + the refill pool). */
  routing: unknown;
}
export interface OpenGradingCascadeResult {
  conversationId: string;
  woke: number;
}

/**
 * Open the grading cascade (D-003 + D-005 [owner]). Injected as
 * `deps.openCascade` in tests — this default reaches the org PG.
 *
 * The cascade is a REAL consult row, not a grading-shaped lookalike, and that is
 * the whole point of D-005: `cascade-core`'s advance, the decline verb and the
 * expiry sweep are all already CAS-guarded against exactly this row, so grading
 * inherits every one of them instead of growing a second advance loop that would
 * have to re-derive the same three-way concurrency guard. What makes the row a
 * GRADING cascade is the `cascade` block on its routing snapshot, which is what
 * every trigger reads to render grader-shaped wake copy.
 *
 * The head grader is woken with the brief matching HOW they were selected: an
 * above-floor pick is told the router matched them; a minimum-fill pick is told
 * plainly that it did not (D-002 — a below-floor grader who believes they were
 * matched on expertise grades with unearned confidence).
 */
async function prodOpenGradingCascade(
  params: OpenGradingCascadeParams,
  ctx: LaunchCtx,
): Promise<OpenGradingCascadeResult> {
  const [{ getOrgPg }, { notifyAgents }, { resolveAgentIdentity }, conversations, { PROCEED_EXPIRY_MS }, briefs] =
    await Promise.all([
      import('@papercusp/db-org'),
      import('./agent-tools/coordination/notify-agents'),
      import('./agent-tools/coordination/identity'),
      import('./agent-tools/coordination/conversations'),
      import('./consult/get-feedback-core'),
      import('./consult/grading-cascade'),
    ]);
  const identity = resolveAgentIdentity(ctx as never);
  const sql = getOrgPg().sql;

  // IDEMPOTENT. `resolveAcceptanceGrader` is re-dispatched by the
  // acceptance-grading sweep for any plan still waiting on a grade, and that was
  // harmless while assignment was a single notification — re-notifying the same
  // grader costs nothing. Opening a cascade is NOT harmless: a second row means
  // two cursors over two menus, two independent expiry windows, and a card that
  // advances one chain while the other silently waits. An already-open cascade
  // for this rubric IS the live dispatch, and its own expiry sweep is what
  // retries a silent grader — so re-dispatch reports it rather than duplicating
  // it. (`woke: 0` is honest: nobody was woken by THIS call.)
  const existing = (await sql`
    SELECT conversation_id
      FROM harness_shared.consult_state
     WHERE workspace_id = ${params.workspaceId}
       AND closed_at IS NULL
       AND routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
       AND routing -> 'cascade' ->> 'rubricId' = ${params.rubricId}
     LIMIT 1
  `) as unknown as Array<{ conversation_id: string }>;
  if (existing[0]) return { conversationId: existing[0].conversation_id, woke: 0 };

  const head = params.graders[0]!;
  const brief =
    head.via === 'minimum'
      ? briefs.buildMinimumFillAcceptanceGraderBrief(params.planSlug, params.harnessSlug, params.rubricId)
      : briefs.buildAssignedAcceptanceGraderBrief(params.planSlug, params.harnessSlug, params.rubricId);

  const opened = await conversations.openConversation(identity, {
    kind: 'consult',
    title: `Acceptance grading — ${params.planSlug} (${params.rubricId})`,
    body: brief,
    ...(params.harnessSlug ? { harness_slug: params.harnessSlug } : {}),
    direct_to: [head.ownerId],
    producer: 'acceptance-gate:grading-cascade',
  });
  const conversationId = opened.conversation.id;

  // The persisted snapshot carries the flavour block, so a decline or an expiry
  // — neither of which knows anything about grading — still wakes grader 2 with
  // grading copy rather than consult copy.
  const routing = {
    ...(params.routing as Record<string, unknown>),
    cascade: {
      flavor: briefs.GRADING_CASCADE_FLAVOR,
      planSlug: params.planSlug,
      rubricId: params.rubricId,
      harnessSlug: params.harnessSlug,
    },
  };
  const expiresAt = new Date(Date.now() + PROCEED_EXPIRY_MS).toISOString();
  await sql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, origin_task_ref, routing, expires_at, wakes_used, cascade_cursor)
    VALUES
      (${params.workspaceId}, ${conversationId}, ${identity.ownerId}, ${head.ownerId},
       ${'awaiting_responder'}, ${brief}, ${'proceed'}, ${params.planSlug},
       ${sql.json(routing as never)}, ${expiresAt}::timestamptz, 1, 0)
  `;

  const res = await notifyAgents(identity, {
    addressees: [head.ownerId],
    objectRef: { kind: 'conversation', ref: conversationId },
    summary: `⚖️ acceptance grading (grader 1/${params.graders.length}): plan ${params.planSlug}`,
    body: brief,
    planSlug: params.planSlug,
    ...(params.harnessSlug ? { harnessSlug: params.harnessSlug } : {}),
    wake: true,
  });
  return { conversationId, woke: res.woke };
}

/**
 * A FILED grading card advances the grading cascade (D-003 [owner]: grader k+1
 * is woken holding grader k's card).
 *
 * WHY THE CARD, AND NOT ONLY A CONSULT REPLY. The cascade already advances on
 * reply, decline and expiry, and a grader who replies gets that for free. But
 * the ACT that discharges a grading is `scorecards:emit`, not a consult reply —
 * a grader who files their card and forgets to reply would otherwise leave the
 * chain parked until the 4h expiry, and grader 2 would then be woken with an
 * EMPTY digest, silently losing the carry that makes latest-wins coherent. So
 * the card itself is a fourth trigger into the SAME advance (D-005 — the
 * mechanism is not duplicated, only entered from one more place).
 *
 * IDEMPOTENT BY CONSTRUCTION, TWICE OVER: it advances only when the emitter is
 * the row's CURRENT responder (the rubric author's later acceptance re-emit, and
 * a card from a grader the cursor has already moved past, both no-op), and
 * `advanceCascade`'s CAS then makes a race with the reply verb or the expiry
 * sweep a clean `raced` no-op rather than a double wake.
 *
 * FAIL-SOFT: the card is the durable truth. Any fault here is swallowed — a
 * missed advance costs the carry and delays grader 2 to the expiry sweep; a
 * throw would fail a scorecard write that already succeeded.
 */
export async function advanceGradingCascadeOnCard(input: {
  workspaceId: string;
  rubricRef: string;
  graderOwnerId: string;
  /** What grader k concluded — carried verbatim (bounded) to grader k+1. */
  cardSummary: string;
}): Promise<{ advanced: boolean; next?: string; reason?: string }> {
  try {
    const [{ getOrgPg }, { advanceCascade, makeDigestEntry }, { notifyAgents }] = await Promise.all([
      import('@papercusp/db-org'),
      import('./consult/cascade-core'),
      import('./agent-tools/coordination/notify-agents'),
    ]);
    const sql = getOrgPg().sql;
    const rows = (await sql`
      SELECT conversation_id, requester_id, responder_id, question, latency_contract,
             routing, cascade_cursor, cascade_digest
        FROM harness_shared.consult_state
       WHERE workspace_id = ${input.workspaceId}
         AND closed_at IS NULL
         AND routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
         AND routing -> 'cascade' ->> 'rubricId' = ${input.rubricRef}
       ORDER BY created_at DESC
       LIMIT 1
    `) as unknown as Array<{
      conversation_id: string;
      requester_id: string;
      responder_id: string | null;
      question: string;
      latency_contract: string;
      routing: unknown;
      cascade_cursor: number;
      cascade_digest: unknown;
    }>;
    const row = rows[0];
    if (!row) return { advanced: false, reason: 'no_open_grading_cascade' };
    if (row.responder_id !== input.graderOwnerId) {
      return { advanced: false, reason: 'not_current_grader' };
    }
    const nowIso = new Date().toISOString();
    const result = await advanceCascade(
      {
        workspaceId: input.workspaceId,
        conversationId: row.conversation_id,
        question: row.question,
        latencyContract: row.latency_contract,
        requesterId: row.requester_id,
        routing: row.routing,
        cascadeCursor: row.cascade_cursor,
        digest: row.cascade_digest,
        event: makeDigestEntry(input.graderOwnerId, 'answer', nowIso, input.cardSummary),
        // A grader engaged, so the row stays 'active' exactly as a reply leaves it.
        stateOnAdvance: 'active',
        nowIso,
      },
      sql,
      async (opts) => {
        const res = await notifyAgents({ ownerId: row.requester_id } as never, {
          addressees: [opts.responder],
          objectRef: { kind: 'conversation', ref: opts.conversationId },
          summary: opts.summary,
          body: opts.body,
          wake: true,
        });
        return { woke: res.woke };
      },
    );
    return {
      advanced: result.advanced,
      ...(result.next ? { next: result.next.ownerId } : {}),
      ...(result.raced ? { reason: 'raced' } : result.exhausted ? { reason: 'menu_exhausted' } : {}),
    };
  } catch (err) {
    return { advanced: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function resolveAcceptanceGrader(
  planSlug: string,
  ctx: LaunchCtx,
  deps: Parameters<typeof launchAcceptanceGrader>[2] & {
    discover?: typeof prodDiscoverGrader;
    openCascade?: typeof prodOpenGradingCascade;
    readSettlement?: typeof readAcceptanceGradingSettlement;
  } = {},
): Promise<AcceptanceGraderLifecycle> {
  let settlement: AcceptanceGradingSettlement | undefined;
  let discovery:
    | {
        excluded: string[];
        partyCollapsed?: string[];
        eligibility?: GraderEligibility;
        escalation?: GraderEscalation;
        freshReason: NonNullable<AcceptanceGraderLifecycle['freshReason']>;
        discoveryError?: string;
      }
    | undefined;
  let discoveryRubricId: string | undefined;
  try {
    const plan = await (deps.readPlan ?? readPlanBySlug)(planSlug, {
      ...(ctx.harnessSlug && ctx.harnessSlug !== '*' ? { harnessSlug: ctx.harnessSlug } : {}),
      ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
    });
    const rubric = plan ? await (deps.getRubric ?? getAcceptanceRubricForPlan)(planSlug) : null;
    const rubricId = rubric ? String((rubric as unknown as { rubricId: string }).rubricId) : null;
    if (rubricId != null) discoveryRubricId = rubricId;
    // `rubric` truthy ⟺ `rubricId != null`, so this is the same condition as before
    // — the extra conjunct only narrows the id for the settlement read below.
    if (plan && rubric && rubricId != null) {
      // ── ALREADY-DECIDED GRADINGS ARE NOT RE-ROUTED (WI-1699998) ──
      // This runs BEFORE discovery, not merely before the cascade open, because
      // selection is the expensive half: it walks the eligible pool and, when it
      // opens a cascade, WAKES a fresh independent grader who is thereafter a
      // party to the plan. D-009 independence makes that pool non-replenishable,
      // so every redundant dispatch permanently shrinks it.
      //
      // The other guard in this file (`prodOpenGradingCascade`'s `closed_at IS
      // NULL` dedup) cannot cover this: it asks whether a cascade is OPEN, and a
      // grading that already COMPLETED has no open row — its evidence lives in
      // scorecards. Two different questions; both guards are needed.
      settlement = await (deps.readSettlement ?? readAcceptanceGradingSettlement)(rubricId).catch(
        // Fail OPEN: a settlement read that throws must not suppress a grading.
        // But RECORD the fault rather than returning undefined — a dispatch that
        // happened because the guard could not run must not be indistinguishable
        // from one that happened because nothing was graded yet. That silence is
        // the same shape as the bug this guard exists to fix.
        () => ({ settled: false, reason: 'read_threw' }) as const,
      );
      if (settlement?.settled) {
        return { state: 'settled', idempotencyKey: '', label: '', settlement };
      }
      const selection = await (deps.discover ?? prodDiscoverGrader)(plan, rubric, ctx);
      if (selection.verdict === 'assigned' && selection.graders.length > 0) {
        // Opening the cascade is BEST-EFFORT in exactly the way the single wake
        // it replaces was: a failure here must not turn a resolvable grading
        // into a failed ship. The difference is that a failure now costs the
        // cascade, not just a notification — so it is reported as woke:0 with no
        // conversation rather than silently looking like a delivered assignment.
        const opened = await (deps.openCascade ?? prodOpenGradingCascade)(
          {
            workspaceId: plan.row.workspaceId,
            planSlug,
            harnessSlug: plan.row.harnessSlug ?? null,
            rubricId,
            graders: selection.graders,
            routing: selection.routing,
          },
          ctx,
        ).catch(() => null);
        // { woke: 0 } is fine: the subscribe is durable — a parked grader reads
        // the grading request on its next turn.
        return {
          state: 'assigned',
          idempotencyKey: '',
          label: '',
          graders: selection.graders,
          ...(opened ? { conversationId: opened.conversationId } : {}),
          excluded: selection.excluded,
          ...(selection.partyCollapsed ? { partyCollapsed: selection.partyCollapsed } : {}),
          eligibility: selection.eligibility,
          ...(selection.escalation ? { escalation: selection.escalation } : {}),
          notified: { woke: opened?.woke ?? 0 },
          ...(settlement ? { settlement } : {}),
        };
      }
      discovery = {
        excluded: selection.excluded,
        ...(selection.partyCollapsed ? { partyCollapsed: selection.partyCollapsed } : {}),
        eligibility: selection.eligibility,
        ...(selection.escalation ? { escalation: selection.escalation } : {}),
        freshReason: selection.freshReason ?? 'no_eligible_non_excluded',
      };
    }
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.warn(
      `[acceptance-grader] discovery failed for plan ${planSlug}` +
        (discoveryRubricId ? ` (rubric ${discoveryRubricId})` : '') +
        `: ${msg}`,
    );
    discovery = { excluded: [], freshReason: 'discovery_error', discoveryError: msg };
  }
  const launched = await launchAcceptanceGrader(planSlug, ctx, deps);
  return { ...launched, ...(discovery ?? {}), ...(settlement ? { settlement } : {}) };
}

export async function launchAcceptanceGrader(
  planSlug: string,
  ctx: LaunchCtx,
  deps: {
    readPlan?: typeof readPlanBySlug;
    getRubric?: typeof getAcceptanceRubricForPlan;
    getAudit?: typeof getLatestPlanAudit;
    listWork?: typeof listWorkItems;
    /** Injectable for unit tests; production uses the canonical lineage reader. */
    lineageRelated?: typeof areAcceptanceLineageRelated;
    launch?: typeof launchAgentTool.handler;
    listTasks?: typeof listTasks;
    killTask?: typeof killTask;
    readLogTail?: AcceptanceGraderLogTailReader;
    sleep?: (ms: number) => Promise<void>;
    terminalLogRecheckDelayMs?: number;
    terminalLogMaxRechecks?: number;
    startupStallLogRecheckDelayMs?: number;
    startupStallLogMaxRechecks?: number;
    nowMs?: () => number;
    staleAfterMs?: number;
  } = {},
): Promise<AcceptanceGraderLifecycle> {
  const plan = await (deps.readPlan ?? readPlanBySlug)(planSlug, {
    ...(ctx.harnessSlug && ctx.harnessSlug !== '*' ? { harnessSlug: ctx.harnessSlug } : {}),
    ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
  });
  if (!plan) return { state: 'failed', idempotencyKey: '', label: '', error: `plan '${planSlug}' not found` };
  const [rubric, audit, workItems] = await Promise.all([
    (deps.getRubric ?? getAcceptanceRubricForPlan)(planSlug),
    (deps.getAudit ?? getLatestPlanAudit)(planSlug),
    (deps.listWork ?? listWorkItems)({
      harness: plan.row.harnessSlug,
      sourcePlanSlug: planSlug,
      includeChildren: true,
      limit: 2_000,
    }),
  ]);
  if (!rubric)
    return { state: 'failed', idempotencyKey: '', label: '', error: `acceptance rubric missing for '${planSlug}'` };
  if (!audit) return { state: 'failed', idempotencyKey: '', label: '', error: `plan audit missing for '${planSlug}'` };

  const rubricRecord = rubric as unknown as {
    rubricId: string;
    proposedBy?: string | null;
    createdBy?: string | null;
  };
  // A fresh judge must not be launched by the rubric's own author (or an
  // identity in that author's launch/rebind lineage). Acceptance rubrics
  // written before proposedBy was persisted only have createdBy, so retain
  // that legacy value as the explicit fallback rather than silently disabling
  // the guard for those rows.
  const rubricAuthor = rubricRecord.proposedBy ?? rubricRecord.createdBy ?? null;
  if (rubricAuthor) {
    try {
      const callerOwnerId = resolveAgentIdentity(ctx).ownerId;
      const related = await (deps.lineageRelated ?? areAcceptanceLineageRelated)(rubricAuthor, callerOwnerId, {
        workspaceId: plan.row.workspaceId,
      });
      if (related) {
        return {
          state: 'failed',
          idempotencyKey: '',
          label: '',
          error:
            `acceptance grader launch refused: caller '${callerOwnerId}' is related to ` +
            `rubric author '${rubricAuthor}'`,
        };
      }
    } catch (err) {
      return {
        state: 'failed',
        idempotencyKey: '',
        label: '',
        error:
          `acceptance grader launch refused: could not verify caller lineage: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const rubricRef = String(rubricRecord.rubricId);
  const identity = createHash('sha256')
    .update(
      [plan.row.workspaceId, plan.row.harnessSlug, planSlug, rubricRef, plan.row.version, plan.row.contentHash].join(
        '\0',
      ),
    )
    .digest('hex');
  const idempotencyKey = `acceptance-grader:${identity}`;
  const label = `${acceptanceGraderLabelPrefix(rubricRef)}${identity.slice(0, 12)}`;
  const snapshot = boundedSnapshotJson(compactSnapshot({ plan, rubric, audit, workItems }));
  const testPaths = audit.items.flatMap((i) =>
    i.citations.filter((c) => c.kind === 'test' && c.path).map((c) => c.path!),
  );
  const rerun = testPaths.length
    ? `npx vitest run ${[...new Set(testPaths)].join(' ')}`
    : 'No test citations were recorded; inspect the frozen audit evidence directly.';
  const brief = [
    `You are the dedicated acceptance judge for plan ${planSlug}. Grade rubric ${rubricRef} as a fresh non-implementer.`,
    'Do not modify implementation files, run shell commands, recruit peers, or broaden scope. Inspect the frozen evidence below, spot-check cited source/tests with read-only tools, and emit exactly one complete scorecards:emit verdict with concrete evidence for every criterion. After a successful create or unchanged-evidence result, the scorecard writer terminates this task automatically.',
    'If FROZEN_ACCEPTANCE_CONTEXT has contextIntegrity.degraded, follow its recovery recipe with read-only Papercusp tools BEFORE returning NOT GRADED. Recovered evidence is admissible only when plans:get still matches frozenIdentity.planVersion/planContentHash and the completion audit still matches frozenIdentity.auditSeq; on a read or identity mismatch, mark only the affected criteria unknown and name the exact gap.',
    ACCEPTANCE_CITATION_SPOT_CHECK_GUIDANCE,
    `Recorded rerun command (for provenance; your judge policy forbids executing Bash): ${rerun}`,
    `FROZEN_ACCEPTANCE_CONTEXT=${snapshot}`,
  ].join('\n\n');

  try {
    const launch = deps.launch ?? launchAgentTool.handler;
    const readTasks = deps.listTasks ?? listTasks;
    const terminateTask = deps.killTask ?? killTask;
    const readLogTail = deps.readLogTail ?? readAcceptanceGraderLogTail;
    const sleep = deps.sleep;
    const nowMs = deps.nowMs ?? Date.now;
    const staleAfterMs = deps.staleAfterMs ?? ACCEPTANCE_GRADER_STALE_AFTER_MS;
    const staleTaskIds: string[] = [];
    const terminalTaskIds: string[] = [];
    const terminalCodes: AcceptanceGraderTerminalFailureCode[] = [];
    let currentIdempotencyKey = idempotencyKey;
    let launchBackend: 'claude' | 'codex' = 'claude';
    let terminalFallbacks = 0;

    const recoveryFields = (attempts: number) => ({
      ...(staleTaskIds.length ? { staleRecovery: { retiredTaskIds: staleTaskIds, attempts } } : {}),
      ...(terminalTaskIds.length
        ? {
            terminalRecovery: {
              retiredTaskIds: terminalTaskIds,
              attempts,
              codes: terminalCodes,
              fallback: ACCEPTANCE_GRADER_FALLBACK,
            },
          }
        : {}),
    });

    for (let attempt = 0; attempt <= ACCEPTANCE_GRADER_MAX_STALE_RETRIES; attempt += 1) {
      const useFallback = launchBackend === ACCEPTANCE_GRADER_FALLBACK.agent;
      const result = (await launch(
        {
          brief,
          harness: plan.row.harnessSlug,
          headless: true,
          account: 'default',
          agent: launchBackend,
          count: 1,
          independent: true,
          members: [
            useFallback
              ? {
                  role: 'judge',
                  agent: ACCEPTANCE_GRADER_FALLBACK.agent,
                  model: ACCEPTANCE_GRADER_FALLBACK.model,
                  effort: ACCEPTANCE_GRADER_FALLBACK.effort,
                }
              : { role: 'judge' },
          ],
          label,
          idempotencyKey: currentIdempotencyKey,
        } as never,
        ctx,
      )) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        data?: { deduped?: boolean; launch?: unknown };
      };
      const launchData = result.data?.launch as
        | {
            tasks?: Array<{ taskId?: unknown; logPath?: unknown }>;
            // EI-21923986145923904: present only when the fresh-launch verification
            // path ran (see FreshLaunchVerdict.agentStarted); absent for a discovery
            // 'assigned' launch, which never spawns.
            agentStarted?: boolean | null;
          }
        | undefined;
      const launchedTask = launchData?.tasks?.[0];
      const taskId = typeof launchedTask?.taskId === 'string' ? launchedTask.taskId : null;
      const logPath = typeof launchedTask?.logPath === 'string' ? launchedTask.logPath : null;
      const terminalFailure = logPath
        ? await detectAcceptanceGraderTerminalFailure(logPath, {
            readLogTail,
            ...(sleep ? { sleep } : {}),
            ...(deps.terminalLogRecheckDelayMs !== undefined ? { delayMs: deps.terminalLogRecheckDelayMs } : {}),
            ...(deps.terminalLogMaxRechecks !== undefined ? { maxRechecks: deps.terminalLogMaxRechecks } : {}),
            ...(deps.startupStallLogRecheckDelayMs !== undefined
              ? { startupStallDelayMs: deps.startupStallLogRecheckDelayMs }
              : {}),
            ...(deps.startupStallLogMaxRechecks !== undefined
              ? { startupStallMaxRechecks: deps.startupStallLogMaxRechecks }
              : {}),
          })
        : null;

      if (terminalFailure) {
        if (!taskId) {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data?.launch,
            error:
              `acceptance grader ended on ${terminalFailure.code}, but its launch receipt carried no task id; ` +
              'refusing an untracked fallback',
            ...recoveryFields(attempt + 1),
          };
        }
        const killed = await terminateTask(taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (!killed.ok && killed.error !== 'not_live' && killed.error !== 'task_not_found') {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data?.launch,
            error:
              `acceptance grader '${taskId}' ended on ${terminalFailure.code}, but its failed mission ` +
              `could not be retired: ${killed.error}`,
            ...recoveryFields(attempt + 1),
          };
        }
        terminalTaskIds.push(taskId);
        terminalCodes.push(terminalFailure.code);
        if (terminalFallbacks >= ACCEPTANCE_GRADER_MAX_TERMINAL_FALLBACKS) {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data?.launch,
            error:
              `acceptance grader fallback also ended on ${terminalFailure.code}; ` +
              'the one-retry ceiling stopped another launch',
            ...recoveryFields(attempt + 1),
          };
        }
        terminalFallbacks += 1;
        launchBackend = ACCEPTANCE_GRADER_FALLBACK.agent;
        const retryIdentity = createHash('sha256')
          .update(`${currentIdempotencyKey}\0${taskId}\0${terminalFailure.code}\0${launchBackend}`)
          .digest('hex')
          .slice(0, 16);
        currentIdempotencyKey = `${idempotencyKey}:recovery:${retryIdentity}`;
        continue;
      }

      if (result.isError) {
        return {
          state: 'failed',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data?.launch,
          error: result.content?.[0]?.text ?? 'acceptance grader launch failed',
          ...recoveryFields(attempt + 1),
        };
      }

      if (!result.data?.deduped) {
        return {
          state: 'launched',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data?.launch,
          ...(launchData && 'agentStarted' in launchData ? { agentStarted: launchData.agentStarted } : {}),
          ...recoveryFields(attempt + 1),
        };
      }

      if (!taskId) {
        return {
          state: 'deduped',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data.launch,
          ...recoveryFields(attempt + 1),
        };
      }
      const task = (await readTasks({ rootTaskId: taskId, includeEnded: true, limit: 50 })).find(
        (row) => row.taskId === taskId,
      );
      if (!task) {
        return {
          state: 'deduped',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data.launch,
          ...recoveryFields(attempt + 1),
        };
      }
      const live = task.endedAt == null && (task.state === 'pending' || task.state === 'running');
      const startedAtMs = Date.parse(task.startedAt);
      const overAge = Number.isFinite(startedAtMs) && nowMs() - startedAtMs >= staleAfterMs;
      if (live && !overAge) {
        return {
          state: 'deduped',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data.launch,
          ...recoveryFields(attempt + 1),
        };
      }
      if (live) {
        const killed = await terminateTask(taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (!killed.ok) {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data.launch,
            error: `stale acceptance grader '${taskId}' could not be retired: ${killed.error}`,
            ...recoveryFields(attempt + 1),
          };
        }
      }
      staleTaskIds.push(taskId);
      const retryIdentity = createHash('sha256')
        .update(`${currentIdempotencyKey}\0${taskId}`)
        .digest('hex')
        .slice(0, 16);
      currentIdempotencyKey = `${idempotencyKey}:retry:${retryIdentity}`;
    }

    return {
      state: 'failed',
      idempotencyKey: currentIdempotencyKey,
      label,
      error: `acceptance grader stale-dedupe recovery exceeded ${ACCEPTANCE_GRADER_MAX_STALE_RETRIES} retries`,
      staleRecovery: { retiredTaskIds: staleTaskIds, attempts: ACCEPTANCE_GRADER_MAX_STALE_RETRIES + 1 },
      ...(terminalTaskIds.length
        ? {
            terminalRecovery: {
              retiredTaskIds: terminalTaskIds,
              attempts: ACCEPTANCE_GRADER_MAX_STALE_RETRIES + 1,
              codes: terminalCodes,
              fallback: ACCEPTANCE_GRADER_FALLBACK,
            },
          }
        : {}),
    };
  } catch (error) {
    return { state: 'failed', idempotencyKey, label, error: error instanceof Error ? error.message : String(error) };
  }
}
