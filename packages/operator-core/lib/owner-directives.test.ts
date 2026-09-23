/**
 * owner-directives (EI-11484) — budgeted-renderer unit tests: rows up to the
 * D-004 cap render whole; longer rows render the labelled agent summary (or a
 * summary-pending note) plus an orders:get pointer, never a cut fragment; the
 * block cap collapses overflow into a "+N more" line; guard assembly
 * soft-blocks only while open rows exist.
 */
import { describe, expect, it } from 'vitest';
import {
  OWNER_DIRECTIVES_BLOCK_CHAR_CAP,
  OWNER_DIRECTIVES_BLOCK_HEADER,
  renderOwnerDirectiveRow,
  renderOwnerDirectivesBlock,
  type OwnerDirectiveRow,
} from './owner-directives';
import { OWNER_DIRECTIVE_VERBATIM_CAP } from './owner-directive-display';
import { buildOpenDirectivesGuard } from './agent-tools/orders/open-directives-guard';
import { renderLoopWakeText } from './harness/routines/loop-fire';

const NOW = Date.UTC(2026, 6, 13, 20, 0, 0);

function row(over: Partial<OwnerDirectiveRow> = {}): OwnerDirectiveRow {
  return {
    id: 7,
    workspaceId: 'papercusp-workspace',
    ownerId: 'owner',
    sessionRef: null,
    sourceTurnRef: null,
    verbatimText: 'resume all the sessions active in the last half hour',
    recordedBy: 'su-00a9161f-6a7d-4caa-abec-4b24bcd94d1f',
    createdAtMs: NOW - 5 * 60_000,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    ...over,
  };
}

describe('renderOwnerDirectiveRow', () => {
  it('renders a short row whole, verbatim, with id + age + recorder attribution', () => {
    const out = renderOwnerDirectiveRow(row(), NOW);
    expect(out).toContain('#7');
    expect(out).toContain('5m old');
    expect(out).toContain('su-00a9161f-'); // recorder shortened, still attributable
    expect(out).toContain('"resume all the sessions active in the last half hour"');
    expect(out).not.toContain('orders:get'); // short rows carry no pointer
  });

  it('D-004: a long row with no summary yet shows NO fragment of the owner text — a note + the orders:get pointer', () => {
    const long = 'do the thing '.repeat(60); // ~780 chars
    expect(long.trim().length).toBeGreaterThan(OWNER_DIRECTIVE_VERBATIM_CAP);
    const out = renderOwnerDirectiveRow(row({ id: 41, verbatimText: long }), NOW);
    expect(out).not.toContain('do the thing');
    expect(out).toContain('summary not written yet');
    expect(out).toContain('[full text: orders:get #41]');
  });

  it('D-004: a long row with a summary shows the summary, labelled with its author', () => {
    const long = 'do the thing '.repeat(60);
    const out = renderOwnerDirectiveRow(
      row({ id: 41, verbatimText: long, summaryText: 'Do the thing, sixty times.', summaryBy: 'su-summarizer-01' }),
      NOW,
    );
    expect(out).toContain('summary by su-summarize');
    expect(out).toContain('"Do the thing, sixty times."');
    expect(out).toContain('[full text: orders:get #41]');
  });

  it('renders exactly at the whole-row boundary without a pointer', () => {
    const exact = 'x'.repeat(OWNER_DIRECTIVE_VERBATIM_CAP);
    const out = renderOwnerDirectiveRow(row({ verbatimText: exact }), NOW);
    expect(out).toContain(`"${exact}"`);
    expect(out).not.toContain('orders:get');
  });
});

describe('renderOwnerDirectivesBlock', () => {
  it('returns null with no rows', () => {
    expect(renderOwnerDirectivesBlock([], { nowMs: NOW })).toBeNull();
  });

  it('renders header + one line per row, oldest first as given', () => {
    const out = renderOwnerDirectivesBlock([row({ id: 1 }), row({ id: 2 })], { nowMs: NOW })!;
    expect(out.startsWith(OWNER_DIRECTIVES_BLOCK_HEADER)).toBe(true);
    expect(out.indexOf('#1')).toBeLessThan(out.indexOf('#2'));
    expect(out).not.toContain('more open');
  });

  it('caps the block and collapses overflow into "+N more — orders:list"', () => {
    // Each row renders the full verbatim (~560 chars); enough rows to blow the cap.
    const long = 'L'.repeat(OWNER_DIRECTIVE_VERBATIM_CAP);
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: i + 1, verbatimText: long }));
    const out = renderOwnerDirectivesBlock(rows, { nowMs: NOW })!;
    expect(out.length).toBeLessThanOrEqual(OWNER_DIRECTIVES_BLOCK_CHAR_CAP + 200); // header + "+N more" slack
    expect(out).toMatch(/\+\d+ more open — orders:list/);
  });

  it('adds the "+N more" line when totalOpen exceeds the fetched rows even under the cap', () => {
    const out = renderOwnerDirectivesBlock([row({ id: 3 })], { nowMs: NOW, totalOpen: 9 })!;
    expect(out).toContain('+8 more open — orders:list');
  });
});

describe('loop wake render (EI-11484) — directives ABOVE the loop contract', () => {
  const KICKOFF = '🔁 loop goal: drain the bug queue\nfull contract body here';
  const block = renderOwnerDirectivesBlock([row({ id: 5 })], { nowMs: NOW })!;

  it('FULL form: the directives block renders above the walls and the checkpoint', () => {
    const out = renderLoopWakeText({
      kickoff: KICKOFF,
      fireNumber: 1,
      checkpoint: '## Next action\ndo the thing',
      walls: [{ claim: 'a wall', sinceMs: NOW - 1000 }],
      ownerDirectivesBlock: block,
      nowMs: NOW,
    });
    expect(out).toContain('OPEN OWNER DIRECTIVES');
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('OPEN WALLS'));
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('do the thing'));
  });

  it('SHORT form: the directives block still renders, above the checkpoint', () => {
    const out = renderLoopWakeText({
      kickoff: KICKOFF,
      fireNumber: 3,
      checkpoint: '## Next action\ndo the thing',
      ownerDirectivesBlock: block,
      nowMs: NOW,
    });
    expect(out).toContain('short form');
    expect(out).toContain('OPEN OWNER DIRECTIVES');
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('do the thing'));
  });

  it('no open directives ⇒ no block in either form', () => {
    const out = renderLoopWakeText({
      kickoff: KICKOFF,
      fireNumber: 3,
      checkpoint: 'c',
      ownerDirectivesBlock: null,
      nowMs: NOW,
    });
    expect(out).not.toContain('OPEN OWNER DIRECTIVES');
  });
});

describe('buildOpenDirectivesGuard', () => {
  it('null when nothing is open', () => {
    expect(buildOpenDirectivesGuard([], 0, 'loop:end', NOW)).toBeNull();
  });

  it('soft-blocks with the open rows, the count, and the acknowledge escape hatch', () => {
    const g = buildOpenDirectivesGuard([row({ id: 12 })], 3, 'loop:end', NOW)!;
    expect(g.ok).toBe(false);
    expect(g.error).toBe('open_owner_directives');
    expect(g.openCount).toBe(3);
    expect(g.directives[0]).toContain('#12');
    expect(g.note).toContain('orders:disposition');
    expect(g.note).toContain('acknowledgeOpenDirectives: true');
    expect(g.note).toContain('loop:end');
  });
});
