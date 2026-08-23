/**
 * workflows-landing-model — the pure derivation behind the Workflows tab landing (the Blend).
 *
 * Plan: external-triggers-gmail-slack-2026-08-22 (P-027), governed by D-018.
 * Layout: /tmp/workflows-builder/Main.dc.html.
 *
 * D-018 asks for four regions, and the FIRST one carries the decision's actual bite:
 *
 *   1. a needs-you strip rendered ONLY when non-empty   ← the part D-018 is about
 *   2. an agent composer hero with source-derived suggestion chips
 *   3. active-now cards
 *   4. an all-workflows ledger
 *
 * ── WHY "ONLY WHEN NON-EMPTY" IS A MODEL CONCERN, NOT A CSS ONE ─────────────────────────
 * An always-present strip that renders "All good" trains the operator to ignore the one
 * region meant to interrupt them — which is exactly what D-018 rejects. So `buildNeedsYou`
 * returns a plain array and the empty case is `[]`. There is deliberately no "all clear"
 * item to render: the caller's contract is to render nothing at all for an empty list, and
 * a test below pins that the empty case produces zero items rather than a reassuring one.
 *
 * ── THE CHIPS ARE SOURCE-DERIVED, WHICH IS WHY THEY ARE NOT A CONSTANT LIST ─────────────
 * A fixed four-chip list would offer "When someone mentions me in Slack…" to an operator
 * with no Slack connected — an invitation to a workflow that cannot be built. Chips are
 * emitted per CONNECTED source kind, so the hero can only ever suggest something wirable.
 *
 * ── WHAT IS DELIBERATELY NOT DERIVED ────────────────────────────────────────────────────
 * The artboard shows "Gmail token expires in 3 days". No credential-expiry field exists on
 * ExternalTriggerSourceAdminRow today (`credentialRef` is an opaque ref; `config`/`cursor`
 * are opaque records), so this module does NOT emit an expiry warning. Inventing a
 * countdown from a field we do not have would be a fabricated alarm in the one strip whose
 * entire value is that it only fires when something is really wrong.
 */

/** What the operator is being asked to do about it. */
export type NeedsYouKind = 'reconnect' | 'review-runs';

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  /** The sentence shown in the strip. */
  message: string;
  /** Label for the strip's action control. */
  actionLabel: string;
  severity: 'warn' | 'bad';
}

export interface SuggestionChip {
  id: string;
  /** Placeholder-style prompt seeded into the agent composer. */
  text: string;
  /** The source kind this chip was derived from — never a hardcoded menu. */
  sourceKind: string;
}

export interface WorkflowLedgerRow {
  id: string;
  label: string;
  /** Short chain summary, e.g. "gmail → plan → tool". */
  chain: string;
  /** Relative time of the last fire, or null when it has never fired. */
  lastLabel: string | null;
  spendLabel: string;
  needsAttention: boolean;
  running: boolean;
  paused: boolean;
}

export interface ActiveNowSummary {
  rows: WorkflowLedgerRow[];
  /** Total fires counted in the supplied activity window; null when not measured. */
  firesToday: number | null;
}

/**
 * The source fields this model reads — a structural subset of
 * `ExternalTriggerSourceAdminRow`. Declared structurally so the pure model stays out of the
 * operator-core import graph; a test pins that a real row still satisfies it.
 */
export interface LandingSourceInput {
  id: string;
  kind: string;
  status: string;
  lastError: string | null;
  failedDeliveries24h: number;
  bindingCount: number;
}

/** The workflow fields the ledger and active-now regions read. */
export interface LandingWorkflowInput {
  id: string;
  label: string;
  running: boolean;
  paused: boolean;
  needsAttention: boolean;
  lastAt: number | null;
  spendLabel: string;
  /** Ordered node kinds of this workflow's chain (from the topology model). */
  chainKinds: readonly string[];
}

/** A source is healthy only when it says so AND is not carrying an error. */
function sourceConnected(source: LandingSourceInput): boolean {
  return source.status === 'connected' && !source.lastError;
}

/**
 * Build the needs-you strip.
 *
 * Returns `[]` when nothing needs the operator — the caller renders NOTHING in that case
 * (D-018). Never returns an "all clear" item.
 */
export function buildNeedsYou(input: {
  sources: readonly LandingSourceInput[];
  workflows: readonly LandingWorkflowInput[];
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];

  for (const source of input.sources) {
    // A source with no bindings is not a problem to escalate — nothing depends on it yet.
    if (!sourceConnected(source) && source.bindingCount > 0) {
      items.push({
        id: `needs-you:source:${source.id}`,
        kind: 'reconnect',
        message: source.lastError
          ? `${prettyKind(source.kind)} is failing: ${source.lastError}`
          : `${prettyKind(source.kind)} is ${source.status}`,
        actionLabel: 'Reconnect',
        severity: 'bad',
      });
    }
    if (source.failedDeliveries24h > 0) {
      items.push({
        id: `needs-you:dead-letter:${source.id}`,
        kind: 'review-runs',
        message: `${prettyKind(source.kind)} has ${source.failedDeliveries24h} failed ${
          source.failedDeliveries24h === 1 ? 'delivery' : 'deliveries'
        } in the last 24h`,
        actionLabel: 'Review runs',
        severity: 'warn',
      });
    }
  }

  for (const workflow of input.workflows) {
    if (workflow.needsAttention) {
      items.push({
        id: `needs-you:workflow:${workflow.id}`,
        kind: 'review-runs',
        message: `${workflow.label} needs attention`,
        actionLabel: 'Review runs',
        severity: 'warn',
      });
    }
  }

  return items;
}

/** Prompt text per source kind — the vocabulary the hero suggests in. */
const CHIP_TEXT: Record<string, string> = {
  'google-gmail': 'When an email from a client arrives…',
  gmail: 'When an email from a client arrives…',
  'google-calendar': 'Before my next meeting…',
  'google-workspace': 'When something changes in Workspace…',
  slack: 'When someone mentions me in Slack…',
  schedule: 'Every morning at 9…',
};

function prettyKind(kind: string): string {
  const named: Record<string, string> = {
    'google-gmail': 'Gmail',
    gmail: 'Gmail',
    'google-calendar': 'Calendar',
    'google-workspace': 'Workspace',
    slack: 'Slack',
    schedule: 'Schedule',
  };
  return named[kind] ?? kind.replaceAll('-', ' ');
}

/**
 * Derive the composer's suggestion chips from the sources that are actually connected.
 *
 * A source kind we have no prompt for is SKIPPED rather than rendered as its raw slug: a
 * chip is a suggestion in the operator's language, and "google-pubsub…" is not one.
 */
export function buildSuggestionChips(sources: readonly LandingSourceInput[]): SuggestionChip[] {
  const chips: SuggestionChip[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!sourceConnected(source)) continue;
    const text = CHIP_TEXT[source.kind];
    if (!text || seen.has(source.kind)) continue;
    seen.add(source.kind);
    chips.push({ id: `chip:${source.kind}`, text, sourceKind: source.kind });
  }
  return chips;
}

/** Render a chain of node kinds as the artboard's "gmail → plan → tool" summary. */
export function formatChain(kinds: readonly string[]): string {
  return kinds.length === 0 ? 'not wired' : kinds.join(' → ');
}

/**
 * Split workflows into the "active now" set and shape every workflow into a ledger row.
 *
 * "Active" means running OR fired recently — a workflow that has never fired is installed,
 * not active, and putting it under "Active now" would overstate what the system is doing.
 */
export function buildActiveNow(
  workflows: readonly LandingWorkflowInput[],
  opts: { nowMs?: number; activeWindowMs?: number; firesToday?: number | null } = {},
): ActiveNowSummary {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.activeWindowMs ?? 24 * 60 * 60 * 1000;
  const rows = workflows
    .filter((w) => w.running || (w.lastAt != null && nowMs - w.lastAt <= windowMs))
    .map((w) => toLedgerRow(w, nowMs));
  return { rows, firesToday: opts.firesToday ?? null };
}

/** Every workflow, active or not — the all-workflows ledger. */
export function buildWorkflowLedger(
  workflows: readonly LandingWorkflowInput[],
  opts: { nowMs?: number } = {},
): WorkflowLedgerRow[] {
  const nowMs = opts.nowMs ?? Date.now();
  return workflows.map((w) => toLedgerRow(w, nowMs));
}

function toLedgerRow(workflow: LandingWorkflowInput, nowMs: number): WorkflowLedgerRow {
  return {
    id: workflow.id,
    label: workflow.label,
    chain: formatChain(workflow.chainKinds),
    lastLabel: workflow.lastAt == null ? null : relativeSince(workflow.lastAt, nowMs),
    spendLabel: workflow.spendLabel,
    needsAttention: workflow.needsAttention,
    running: workflow.running,
    paused: workflow.paused,
  };
}

/** Compact relative time for the ledger's "last fired" column. */
export function relativeSince(atMs: number, nowMs: number): string {
  const deltaMs = nowMs - atMs;
  if (deltaMs < 0) return 'scheduled';
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
