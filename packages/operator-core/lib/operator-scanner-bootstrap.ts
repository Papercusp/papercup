/**
 * State bootstrap for the persistent-session scanner.
 *
 * When the scanner resumes its prior Claude session, the model brings
 * its prior context but doesn't see what's changed since. Without a
 * fresh state injection it can hallucinate ("you already dispatched
 * this last week" — but the user actually didn't, that was a
 * different conversation).
 *
 * The bootstrap is a small markdown blob the scan handler prepends to
 * the user's request. It contains:
 *   - what cards are currently visible (last persisted scan output)
 *   - recent decisions (dispatched / dismissed in the last 24h)
 *   - a one-liner from the previous scan's summary so the scanner
 *     knows what it said before
 *
 * Server-only. Cheap — file reads + one PG query. Run on every scan
 * when OPERATOR_SCANNER_RESUME=1.
 */

import { listOperatorScans } from './operator-scans';
import { readLastScan, type LastScanEntry } from './operator-last-scan';

interface BootstrapArgs {
  workspaceId: string;
  /** Max chars to include from the prior scan's summary. */
  maxPriorSummaryChars?: number;
}

export async function buildScannerBootstrap(args: BootstrapArgs): Promise<string> {
  const sections: string[] = [];

  // Section 1: previous scan summary (the "where did I leave off" cue).
  let prior: LastScanEntry | null = null;
  try { prior = await readLastScan(); } catch { /* ignore */ }
  if (prior) {
    const cap = args.maxPriorSummaryChars ?? 280;
    const cards = (prior.cards ?? []) as Array<Record<string, unknown>>;
    const cardLines = cards.slice(0, 8).map((c, i) => {
      const title = (c as any).title ?? '(untitled)';
      const tier = (c as any).actualTier ?? (c as any).tier ?? '';
      const status = (c as any).status ?? '';
      return `${i + 1}. ${title} [${tier}${status ? `, ${status}` : ''}]`;
    });
    const headerTs = prior.scanCompletedAt
      ? `${fmtAge(prior.scanCompletedAt)} (${prior.scanCompletedAt})`
      : 'unknown';
    sections.push(
      `## Previous scan (${headerTs})\n\n` +
      (cards.length === 0 ? '_No cards emitted last time._' :
        `Last scan emitted ${cards.length} card${cards.length === 1 ? '' : 's'}:\n${cardLines.join('\n')}`),
    );
    void cap; // reserved if we add a long-summary slot later
  }

  // Section 2: recent scan history (what was emitted across the last
  // few scans, deduped by id). Helps the model spot recurrent issues
  // ("this 'replan needed' card has come up 3 scans in a row").
  try {
    const recent = await listOperatorScans({ workspaceId: args.workspaceId, limit: 5 });
    if (recent.length > 0) {
      const lines = recent.slice(0, 5).map((s) => {
        const summary = s.summary ?? (s.error ? `errored: ${s.error}` : `${s.suggestionCount} cards`);
        return `- ${fmtAge(s.startedAt)}: ${summary}`;
      });
      sections.push(`## Recent scans (last 5)\n\n${lines.join('\n')}`);
    }
  } catch { /* ignore — table may not exist yet on first call */ }

  // Section 3: ground rules. Important to repeat each turn since the
  // resumed session might drift.
  sections.push(
    `## Ground rules for this scan\n\n` +
    `- This is a NEW scan turn. Do not assume the user has already seen any card from earlier scans — the panel may have been refreshed, the user may be new to this session.\n` +
    `- Re-emit a card with the SAME id if the underlying issue is unchanged; the panel dedups on id.\n` +
    `- If you previously suggested something that turned out to be wrong, say so explicitly in your status line ("Withdrawing prior suggestion X — turns out…").`,
  );

  if (sections.length === 0) return '';
  return `## State bootstrap\n\n${sections.join('\n\n')}\n\n---\n\n`;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
