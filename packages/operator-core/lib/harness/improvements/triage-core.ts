/**
 * triage-core.ts — the PERSISTENCE edge of Queen-turn triage
 * (learning-system-audit-improvements-2026-06-09 P-010/P-011; self-learning P-020).
 *
 * Before this existed, `improvements:triage` computed a decision and returned it
 * as JSON — and threw it away (the literal "(In a real implementation, this would
 * write to the DB)" gap). This module is the missing write:
 *
 *   - `applyTriageDecision` — record ONE decision durably on the item:
 *       · writes `payload.ideaLifecycle` → state 'triaged' + decision + reason
 *         (+ ideaType from the classifier), validated against the state machine;
 *       · `reject` ALSO closes the issue with `payload.decidedReason`, so a
 *         rejected idea leaves the open queue AND the "already decided: <reason>"
 *         recall fires on the next same-signature capture (queue-as-memory, D-004).
 *   - `selectUntriaged` — the pure batch picker the scheduled
 *     `system:improvement-triage` routine uses: open items with no lifecycle yet
 *     (or sitting in 'open'/'recurred'), highest digest score first.
 *
 * Deps are injectable so every branch is unit-testable without PG (the
 * resolve-core pattern).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getIssue,
  setIssueState,
  commentIssue,
  mergeIssuePayload,
  type EngineerIssue,
} from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import type { ScoredItem } from './digest';
import type { TriageDecision } from './triage';
import { classifyIdeaType, extractCitedIds } from './triage';
import { issueToCandidate } from './read-items';
import { integrationRoot } from '../../release-deploy-launch';
import {
  initializeIdeaLifecycle,
  updateIdeaLifecycle,
  isValidTransition,
  type IdeaLifecyclePayload,
} from './lifecycle';

// Lazily promisified (NOT `const pexecFile = promisify(execFile)` at module scope):
// this module is reachable via a long, easy-to-hit transitive import chain from test
// files that narrowly mock `node:child_process` (e.g. `{ spawn }` only) for their own
// subprocess assertions — under such a mock the `execFile` import binding resolves to
// `undefined`, and eagerly calling `promisify(undefined)` at module-eval time throws
// for every such suite, even ones that never call `defaultSearchTree`
// (lint:no-eager-execfile-promisify / EI-10161; same pattern as watchdog.ts's
// `execFileP`). Deferring the promisify to first actual call means a transitive
// importer that never exercises this function never pays the cost.
type PexecFile = (
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let cachedPexecFile: PexecFile | null = null;
function pexecFile(file: string, args: string[], opts?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  if (!cachedPexecFile) cachedPexecFile = promisify(execFile) as unknown as PexecFile;
  return cachedPexecFile(file, args, opts);
}

export interface ApplyTriageInput {
  id: string;
  decision: TriageDecision;
  reason: string;
  /** Who decided ('Queen', 'improvement-triage' for the scheduled pass, a human id). */
  by?: string;
  /** Write an audit comment on the issue (default true; the scheduled batch
   *  passes false so a 25-item pass doesn't spray 25 thread posts). */
  comment?: boolean;
}

export interface ApplyTriageResult {
  ok: boolean;
  id: string;
  decision?: TriageDecision;
  lifecycle?: IdeaLifecyclePayload;
  /** True when decision='reject' closed the issue (it left the open queue). */
  closed?: boolean;
  /** Present when an evidence guard downgraded an incoming place→gate.
   *  `requestedDecision` is what the caller asked for. Unresolved and same-role
   *  citations are integrity failures; stale citations are the older staleness
   *  guard's contradiction signal. */
  evidenceDowngrade?: {
    requestedDecision: TriageDecision;
    citedIds: string[];
    staleIds: string[];
    unresolvedIds?: string[];
    circularIds?: string[];
  };
  /** Present when the CODE-EXISTENCE GUARD downgraded an incoming place→gate
   *  (EI-18801316749542776). `requestedDecision` is what the caller asked for. */
  existenceDowngrade?: { requestedDecision: TriageDecision; tokens: string[]; matches: CodeExistenceMatch[] };
  error?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface TriageCoreDeps {
  getIssue: (id: string) => Promise<EngineerIssue | null>;
  setIssueState: (
    id: string,
    state: 'open' | 'resolved' | 'closed',
    by?: string,
    completionRef?: string,
    opts?: { skipCompletionGate?: boolean },
  ) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  /** EI-18801316749542776: search the live tree for a vocabulary token, returning the
   *  repo-relative paths it occurs in (best-effort, capped). Optional — an omitted
   *  dep silently skips the code-existence guard (never blocks a decision). Production
   *  default: `defaultSearchTree` (grep over the integration root). */
  searchTree?: (token: string) => Promise<string[]>;
  mergeIssuePayload: (id: string, patch: Record<string, unknown>) => Promise<EngineerIssue | null>;
}

const defaultDeps: TriageCoreDeps = {
  getIssue,
  setIssueState,
  commentIssue,
  mergeIssuePayload,
  searchTree: defaultSearchTree,
};

const TERMINAL_ISSUE_STATES = new Set(['resolved', 'closed']);

/**
 * Evidence-staleness pre-check (EI-18696839552593260): a Scout-idea batch filed
 * 12 near-duplicate ideas, each citing a slightly different subset of the same
 * underlying evidence cluster, and every one of those cited items ALREADY
 * carried a terminal state + completion ref that contradicted the idea's own
 * premise — a single cheap check would have caught every one before it was
 * auto-triaged 'place' and burned a claim+investigate+reject cycle.
 *
 * Best-effort + narrow by design: a lookup failure or an idea citing nothing
 * never blocks anything (returns stale:false); it only ever recommends a
 * place→gate DOWNGRADE (never a reject — mirrors the scheduled triage pass's
 * existing "never reject automatically" conservatism, improvement-actions.ts),
 * and only when EVERY citation resolves to terminal-with-evidence. An
 * unresolved citation keeps the premise unverified rather than being silently
 * ignored; citation integrity is enforced by the companion inspection below.
 */
type EvidenceIssue = Pick<EngineerIssue, 'id' | 'title' | 'body'> & { payload?: EngineerIssue['payload'] };

interface EvidenceCitationInspection {
  citedIds: string[];
  staleIds: string[];
  unresolvedIds: string[];
  circularIds: string[];
  lookupFailedIds: string[];
  stale: boolean;
}

function sourceRoleOf(issue: { payload?: EngineerIssue['payload'] }): string | undefined {
  const payload = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  return typeof payload.sourceRole === 'string' ? payload.sourceRole : undefined;
}

/**
 * Resolve every cited work-item before a place decision can treat the citations
 * as evidence. A missing row is a concrete integrity failure; a resolver error
 * remains fail-open because transient datastore blindness is not proof of a
 * missing incident. Same-role generated ideas are circular evidence rather than
 * incidents, even when they happen to be terminal.
 */
async function inspectEvidenceCitations(
  issue: EvidenceIssue,
  deps: Pick<TriageCoreDeps, 'getIssue'>,
): Promise<EvidenceCitationInspection> {
  const citedIds = extractCitedIds(`${issue.title ?? ''} ${issue.body ?? ''}`).filter((id) => id !== issue.id);
  const staleIds: string[] = [];
  const unresolvedIds: string[] = [];
  const circularIds: string[] = [];
  const lookupFailedIds: string[] = [];
  const resolvedIds: string[] = [];
  const sourceRole = sourceRoleOf(issue);

  for (const id of citedIds) {
    let cited: EngineerIssue | null = null;
    try {
      cited = await deps.getIssue(id);
    } catch {
      lookupFailedIds.push(id);
      continue; // best-effort — a lookup failure never blocks the decision
    }
    if (!cited) {
      unresolvedIds.push(id);
      continue;
    }
    resolvedIds.push(id);
    if (sourceRole && sourceRole !== 'human' && sourceRoleOf(cited) === sourceRole) {
      circularIds.push(id);
    }
    if (TERMINAL_ISSUE_STATES.has(cited.state) && cited.terminalCompletionRef) {
      staleIds.push(id);
    }
  }

  // A stale verdict is meaningful only when the complete citation set was
  // resolved. Otherwise the missing/failed lookup is itself the uncertainty.
  const stale =
    resolvedIds.length > 0 &&
    unresolvedIds.length === 0 &&
    lookupFailedIds.length === 0 &&
    staleIds.length === resolvedIds.length;
  return { citedIds, staleIds, unresolvedIds, circularIds, lookupFailedIds, stale };
}

export async function evidenceStalenessCheck(
  issue: EvidenceIssue,
  deps: Pick<TriageCoreDeps, 'getIssue'>,
): Promise<{ stale: boolean; citedIds: string[]; staleIds: string[] }> {
  const check = await inspectEvidenceCitations(issue, deps);
  return { stale: check.stale, citedIds: check.citedIds, staleIds: check.staleIds };
}

/* ─── Code-existence pre-check (EI-18801316749542776) ──────────────────────────── *
 *
 * Two consecutive Scout analogical-lens ideas (EI-8167, EI-8337) proposed a whole
 * escalation ladder — bare-CF-429 vs quota classification, per-IP egress rotation,
 * per-account throttling — that was ALREADY FULLY IMPLEMENTED (`edgeThrottled`,
 * `egressPool`, `edgeThrottleBare429Streak`, …), costing a claim+investigate+drop
 * cycle each. The generator reads a friction/gap in the digest as a description of
 * a missing capability without checking whether the capability already exists.
 *
 * Mirrors evidenceStalenessCheck's shape exactly: best-effort, place→gate DOWNGRADE
 * ONLY (never a reject), a failed/skipped check never blocks a decision. The one
 * new ingredient is a `searchTree` dependency (grep over the live tree) rather than
 * `getIssue` — vocabulary EXISTENCE is a codebase fact, not a DB fact.
 */

/** One distinctive-vocabulary token that already occurs in the tree. */
export interface CodeExistenceMatch {
  token: string;
  /** Repo-relative paths it was found in (best-effort, capped). */
  files: string[];
}

const BACKTICK_TOKEN_RE = /`([A-Za-z_][A-Za-z0-9_.]{3,60})`/g;
const CAMEL_TOKEN_RE = /\b([a-zA-Z][a-zA-Z0-9]*)\b/g;
const MAX_TOKENS = 8;

/**
 * Distinctive code-like vocabulary from an idea's title+body: backtick-quoted
 * identifiers first (an idea proposing/describing a capability overwhelmingly names
 * it in backticks — exactly `edgeThrottled`, `egressPool` in the incident), then
 * bare camelCase/PascalCase identifiers with a length + mixed-case floor to keep
 * out ordinary English prose. Deduped, capped at `MAX_TOKENS` so a long idea body
 * can never turn this into an unbounded scan.
 */
export function extractDistinctiveVocabulary(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (!seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };
  for (const m of text.matchAll(BACKTICK_TOKEN_RE)) add(m[1]);
  for (const m of text.matchAll(CAMEL_TOKEN_RE)) {
    const t = m[1];
    // Mixed-case (an internal uppercase after the first char) + length floor is what
    // separates a real identifier ("edgeThrottled", "SendOptions") from ordinary prose
    // ("Scout", "already", "ALL") — a bare capitalized/uppercase word has no internal
    // case transition and is excluded.
    if (t.length >= 8 && /[a-z]/.test(t) && /[A-Z]/.test(t.slice(1)) && /^[a-zA-Z]/.test(t)) add(t);
  }
  return tokens.slice(0, MAX_TOKENS);
}

export interface CodeExistenceCheckResult {
  /** Distinctive vocabulary tokens extracted from the idea's title+body. */
  tokens: string[];
  /** The subset of `tokens` confirmed to already occur in the tree, with hit paths. */
  matches: CodeExistenceMatch[];
}

/**
 * Does the idea's OWN distinctive vocabulary already occur in the tree? Report-only
 * (D-005 conservatism, same as evidenceStalenessCheck): a search failure for one
 * token, or the absence of `searchTree` entirely, never blocks — it just narrows
 * what gets checked.
 */
export async function codeExistenceCheck(
  issue: Pick<EngineerIssue, 'id' | 'title' | 'body'>,
  searchTree: (token: string) => Promise<string[]>,
): Promise<CodeExistenceCheckResult> {
  const tokens = extractDistinctiveVocabulary(`${issue.title ?? ''} ${issue.body ?? ''}`);
  const matches: CodeExistenceMatch[] = [];
  for (const token of tokens) {
    try {
      const files = await searchTree(token);
      if (files.length) matches.push({ token, files: files.slice(0, 5) });
    } catch {
      // best-effort — a search failure for one token never blocks the rest
    }
  }
  return { tokens, matches };
}

/**
 * Production `searchTree`: a bounded `grep` over the integration root's `packages`,
 * `apps`, and `libs` trees. Fails soft — grep exits non-zero on "no match", which
 * this reads as `[]`, not an error; a genuinely broken invocation (bad root, no
 * grep) also degrades to `[]` via the outer try/catch in `codeExistenceCheck`.
 */
export async function defaultSearchTree(token: string): Promise<string[]> {
  const root = integrationRoot();
  const dirs = ['packages', 'apps', 'libs'];
  try {
    const { stdout } = await pexecFile(
      'grep',
      [
        '-rl',
        '--include=*.ts',
        '--include=*.tsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '-F',
        '-m',
        '1',
        '-e',
        token,
        ...dirs,
      ],
      { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    // grep exits 1 (no match) or 2 (a named dir doesn't exist in a smaller test
    // fixture root) — both are a clean "found nothing", not a failure to surface.
    const err = e as { code?: number; stdout?: string };
    if (typeof err?.code === 'number' && err.stdout) {
      return err.stdout
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean);
    }
    return [];
  }
}

function lifecycleOf(issue: EngineerIssue): IdeaLifecyclePayload | null {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const l = p.ideaLifecycle;
  return l && typeof l === 'object' && typeof (l as { state?: unknown }).state === 'string'
    ? (l as IdeaLifecyclePayload)
    : null;
}

export async function applyTriageDecision(
  input: ApplyTriageInput,
  deps: TriageCoreDeps = defaultDeps,
): Promise<ApplyTriageResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { ok: false, id: input.id, error: `issue ${input.id} not found` };
  if (issue.state !== 'open') {
    return { ok: false, id: input.id, error: `issue ${input.id} is ${issue.state} — only OPEN items are triaged` };
  }

  // Legacy items (captured before the lifecycle landed) start at 'open' here.
  const current = lifecycleOf(issue) ?? initializeIdeaLifecycle();
  if (!isValidTransition(current.state, 'triaged')) {
    return {
      ok: false,
      id: input.id,
      error: `cannot triage from lifecycle state '${current.state}' (already ${current.state})`,
    };
  }

  // Evidence-staleness guard (EI-18696839552593260): a 'place' recommendation whose
  // OWN cited evidence is already terminal-with-completion-ref gets downgraded to
  // 'gate' before it ever reaches the auto-implement lane. Best-effort — never
  // throws, never touches a non-'place' decision.
  let decision: TriageDecision = input.decision;
  let reason = input.reason;
  let evidenceDowngrade: ApplyTriageResult['evidenceDowngrade'];
  if (decision === 'place') {
    try {
      const check = await inspectEvidenceCitations(issue, deps);
      const integrityFailure = check.unresolvedIds.length > 0 || check.circularIds.length > 0;
      if (check.stale || integrityFailure) {
        evidenceDowngrade = {
          requestedDecision: decision,
          citedIds: check.citedIds,
          staleIds: check.staleIds,
          ...(check.unresolvedIds.length ? { unresolvedIds: check.unresolvedIds } : {}),
          ...(check.circularIds.length ? { circularIds: check.circularIds } : {}),
        };
        decision = 'gate';
        const guardReasons: string[] = [];
        if (check.unresolvedIds.length) {
          guardReasons.push(
            `EVIDENCE-INTEGRITY GUARD (EI-19450720466036446): cited item(s) ` +
              `(${check.unresolvedIds.join(', ')}) did not resolve to work items`,
          );
        }
        if (check.circularIds.length) {
          guardReasons.push(
            `EVIDENCE-INTEGRITY GUARD (EI-19450720466036446): same-role generated idea(s) ` +
              `(${check.circularIds.join(', ')}) are circular evidence, not incident records`,
          );
        }
        if (check.stale) {
          guardReasons.push(
            `EVIDENCE-STALENESS GUARD (EI-18696839552593260): every cited item ` +
              `(${check.staleIds.join(', ')}) is already resolved/closed with a completion ref; this idea's ` +
              `premise may already be contradicted by its own cited evidence`,
          );
        }
        reason =
          `${input.reason} — ${guardReasons.join('; ')}. Downgraded place→gate for ` +
          `human/Queen re-verification before auto-implementing.`;
      }
    } catch {
      // best-effort — a guard failure never blocks a normal triage decision
    }
  }

  // Full-fidelity classification (D-005): the candidate view carries paths +
  // watchdogKey + kind, which the taxonomy keys off — never a scope-only call.
  const ideaType = classifyIdeaType(issueToCandidate(issue)).type;
  const lifecycle = updateIdeaLifecycle(current, 'triaged', {
    triageDecision: decision,
    triageReason: reason,
    ideaType,
  });

  const by = input.by ?? 'improvement-triage';
  const patch: Record<string, unknown> = { ideaLifecycle: lifecycle };
  // Reject = a DECIDED idea: record the durable reason for the recall matcher
  // ("already decided: <reason>") and close it so it leaves the open queue.
  if (decision === 'reject') patch.decidedReason = reason;
  // Gate = a HUMAN-REVIEW verdict, so it must ALSO be written to the field the claim
  // floor actually reads (EI-18812833212023413). The verdict used to live ONLY in
  // payload.ideaLifecycle.triageDecision, while issue-family admission keys on
  // payload.needsHuman — so a gated item stayed fully claimable and scheduler:get_next
  // served it like any other work. Measured when found: 917 items ever gated, 125 open,
  // 51 of them claimable RIGHT NOW with no needsHuman and no _claimHold, including
  // protected-path items ("touches apps/operator/lib/release/** → human") and
  // "process/prompt change needs human gate" items — precisely what the gate exists to
  // stop. The gate was computing a correct verdict and writing it somewhere nothing
  // enforced.
  //
  // Mirrored HERE, at the write side, in the SAME merge as the lifecycle patch, for the
  // same reason work-item-topic-tags.ts mirrors topics into the claim-visible tag field
  // (EI-18654138087054247): two slots that must agree cannot be kept in sync by
  // remembering to write both. Nothing on the read/claim path changes — the floor keeps
  // reading exactly the field it reads today, and now that field is populated.
  if (decision === 'gate') patch.needsHuman = true;
  await deps.mergeIssuePayload(input.id, patch);

  if (input.comment !== false) {
    await deps.commentIssue(input.id, `Triage (${by}): ${decision} — ${reason}`, by);
  }

  let closed = false;
  if (decision === 'reject') {
    // Completion-integrity gate (WI-1403, contract C-1): a triage reject is a genuine,
    // reasoned DECISION by a principal (`by`) — the durable rejection reason IS the
    // completion evidence, so it carries a real completionRef rather than a skip.
    await deps.setIssueState(input.id, 'closed', by, `Triage decision: reject — ${reason}`);
    closed = true;
  }

  // Push the Learning tab's improvements feed (lazy + fire-and-forget — the
  // capture-core pattern; a missing SSE bus is a no-op).
  void import('../../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.improvements'))
    .catch(() => {});
  // Push-on-write for the Health tab's improvements panel
  // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007) —
  // same lazy fire-and-forget discipline as the invalidate above.
  void import('../../system-health/compute')
    .then((m) => m.refreshHealthPanel('improvements'))
    .catch(() => {});

  return { ok: true, id: input.id, decision, lifecycle, closed, ...(evidenceDowngrade ? { evidenceDowngrade } : {}) };
}

/**
 * Pure batch picker for the scheduled triage pass: OPEN scored items whose
 * lifecycle has not been triaged yet ('open', 'recurred', or no lifecycle at
 * all — legacy captures), highest score first, capped at `max`.
 */
export function selectUntriaged(scored: ScoredItem[], max: number): ScoredItem[] {
  if (max <= 0) return [];
  return scored
    .filter((i) => {
      const s = i.ideaLifecycleState;
      return s === undefined || s === 'open' || s === 'recurred';
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
