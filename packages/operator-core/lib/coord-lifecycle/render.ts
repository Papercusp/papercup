/**
 * render.ts — PURE formatters that turn a structured lifecycle record
 * (./records) into a coord notification `{ summary, body }`
 * (coord-lifecycle-automation-2026-06-04 D-004 / D-006 / D-008).
 *
 * These are the heart of "stop narrating, emit structure": an agent fills in
 * the record's fields once (or a typed op carries them), and the transition
 * renders the notification deterministically — the agent spends zero tokens
 * writing prose. The prose STYLE here matches the real corpus so a reader of
 * `coord:inbox` sees the same shape they're used to, only now generated.
 *
 * INVARIANT (D-006, information preservation): every field a record carries
 * MUST appear in the rendered output. The deferred-set especially — the
 * "surface every deferred item" policy depends on it never being dropped.
 *
 * Pure: no I/O, no clock, no identity resolution. Fully unit-testable. The
 * coord:emit wiring (which fires these) lives in ../agent-tools/coordination;
 * the event-rule that calls them lives in ./lifecycle-rules.
 */

import type {
  ClaimRecord,
  CompletionRecord,
  FindingRecord,
  HandoffRecord,
  IntentRecord,
  LifecycleCategory,
  WindowRecord,
} from './records';

/** What every renderer produces — the two coord-notification fields. */
export interface RenderedNotification {
  summary: string;
  body?: string;
}

/** Join non-empty lines, dropping blanks at the seams. */
function block(...lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
}

/** A "• "-prefixed bullet list, or null when empty. */
function bullets(items: readonly string[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  return items.map((i) => `• ${i}`).join('\n');
}

/** Truncate a summary so coord:inbox headers stay scannable. */
function clip(s: string, max = 180): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * COMPLETION (D-004). The summary mirrors the corpus headline
 * ("<id> BUILT+TESTED (agent): <one-liner>, <tests>, migs …"); the body
 * carries the full structured detail with the deferred-set called out.
 */
export function renderCompletion(rec: CompletionRecord): RenderedNotification {
  const status = (rec.status || 'done').toUpperCase();
  const who = rec.agent ? ` (${rec.agent})` : '';
  // Compact trailers on the headline, the way agents write them.
  const trailers: string[] = [];
  if (rec.tests) trailers.push(rec.tests);
  if (rec.migrations && rec.migrations.length > 0) {
    trailers.push(`migs ${rec.migrations.map((m) => m.split(/\s/)[0]).join('/')}`);
  }
  const trailer = trailers.length > 0 ? ` — ${trailers.join(', ')}` : '';
  const summary = clip(`${rec.workItem} ${status}${who}: ${rec.summary}${trailer}`);

  const body = block(
    rec.title ? `**${rec.title}**` : null,
    rec.whatLanded && rec.whatLanded.length > 0 ? `What landed:\n${bullets(rec.whatLanded)}` : null,
    rec.migrations && rec.migrations.length > 0 ? `Migrations:\n${bullets(rec.migrations)}` : null,
    rec.tests ? `Tests: ${rec.tests}` : null,
    rec.deploy ? `Deploy: ${rec.deploy}` : null,
    // The deferred-set is intentionally last + visually flagged so it can't be
    // skimmed past — this is the "surface every deferred item" guarantee.
    rec.deferred && rec.deferred.length > 0
      ? `⚠ Still deferred (not done this pass):\n${bullets(rec.deferred)}`
      : null,
    rec.coordNotes ? `\n${rec.coordNotes}` : null,
  );

  return body.length > 0 ? { summary, body } : { summary };
}

/** CLAIM — "Taking <id>". */
export function renderClaim(rec: ClaimRecord): RenderedNotification {
  const who = rec.agent ? ` (${rec.agent})` : '';
  const summary = clip(`Taking ${rec.workItem}${who}${rec.summary ? ` — ${rec.summary}` : ''}`);
  return { summary };
}

/** INTENT — "now working on X" heads-up (from coord:declare-intent). */
export function renderIntent(rec: IntentRecord): RenderedNotification {
  const who = rec.agent ? `${rec.agent} ` : '';
  const summary = clip(`▶ ${who}now working on: ${rec.intent}`);
  const body = block(
    rec.files && rec.files.length > 0 ? `Files in scope:\n${bullets(rec.files)}` : null,
    rec.planSlug ? `Plan: ${rec.planSlug}` : null,
  );
  return body.length > 0 ? { summary, body } : { summary };
}

/** WINDOW — open / draining / done broadcasts for a held scope. */
export function renderWindow(rec: WindowRecord): RenderedNotification {
  const who = rec.agent ? ` (${rec.agent})` : '';
  switch (rec.phase) {
    case 'open':
      return {
        summary: clip(`🔒 holding ${rec.scope}${who} — ${rec.intent}`),
        body: `Holding ${rec.scope} for: ${rec.intent}. I'll post DONE for this window when I release it — hold off on edits in this scope until then.`,
      };
    case 'draining':
      return {
        summary: clip(`⏳ draining ${rec.scope}${who} — wrapping up: ${rec.intent}`),
        body: `Finishing up on ${rec.scope} (${rec.intent}). Almost done — the window closes shortly.`,
      };
    case 'done':
      return {
        summary: clip(`✅ released ${rec.scope}${who} — ${rec.intent} done`),
        body: `Released ${rec.scope}. ${rec.intent} is done — the scope is free to edit.`,
      };
  }
}

/**
 * HANDOFF (D-008) — the shared formatHandoff. Used by BOTH the coord
 * notification and the agent's-pane render so they never disagree.
 */
export function renderHandoff(rec: HandoffRecord): RenderedNotification {
  const dest = rec.to ? ` → ${rec.to}` : '';
  const summary = clip(`↪ handoff${dest}: ${rec.item}`);
  const body = block(
    rec.context,
    rec.nextStep ? `Next step: ${rec.nextStep}` : null,
  );
  return body.length > 0 ? { summary, body } : { summary };
}

/** FINDING / health — a discovered problem. */
export function renderFinding(rec: FindingRecord): RenderedNotification {
  const sev = rec.severity ? `[${rec.severity}] ` : '';
  const ref = rec.workItemId ? ` (${rec.workItemId})` : '';
  const summary = clip(`⚠ ${sev}${rec.title}${ref}`);
  return rec.detail ? { summary, body: rec.detail } : { summary };
}

/**
 * A category-keyed renderer map for the desugar layer — lets a single emits
 * rule pick the renderer by category without a switch at the callsite. Each
 * entry takes the *already-validated* record shape for its category.
 */
export const CATEGORY_RENDERERS: {
  completion: (r: CompletionRecord) => RenderedNotification;
  claim: (r: ClaimRecord) => RenderedNotification;
  intent: (r: IntentRecord) => RenderedNotification;
  window: (r: WindowRecord) => RenderedNotification;
  handoff: (r: HandoffRecord) => RenderedNotification;
  finding: (r: FindingRecord) => RenderedNotification;
} = {
  completion: renderCompletion,
  claim: renderClaim,
  intent: renderIntent,
  window: renderWindow,
  handoff: renderHandoff,
  finding: renderFinding,
};

/** Type guard helper kept next to the map for callsite ergonomics. */
export function isLifecycleCategory(x: string): x is LifecycleCategory {
  return x in CATEGORY_RENDERERS;
}
