/**
 * owner-directives (EI-11484) — budgeted-renderer unit tests: verbatim-short
 * rows render whole; long rows excerpt via substr + an orders:get pointer
 * (never summarization); the block cap collapses overflow into a "+N more"
 * line; guard assembly soft-blocks only while open rows exist.
 */
import { describe, expect, it } from 'vitest';
import {
  OWNER_DIRECTIVE_EXCERPT_CHARS,
  OWNER_DIRECTIVE_WHOLE_MAX,
  OWNER_DIRECTIVES_BLOCK_CHAR_CAP,
  OWNER_DIRECTIVES_BLOCK_HEADER,
  renderOwnerDirectiveRow,
  renderOwnerDirectivesBlock,
  type OwnerDirectiveRow,
} from './owner-directives';
import { buildOpenDirectivesGuard } from './agent-tools/orders/open-directives-guard';

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

  it('excerpts a long row with substr(0, EXCERPT) + the orders:get pointer — never a paraphrase', () => {
    const long = 'do the thing '.repeat(60); // ~780 chars
    expect(long.length).toBeGreaterThan(OWNER_DIRECTIVE_WHOLE_MAX);
    const out = renderOwnerDirectiveRow(row({ id: 41, verbatimText: long }), NOW);
    expect(out).toContain(`"${long.slice(0, OWNER_DIRECTIVE_EXCERPT_CHARS)}…"`);
    expect(out).toContain('[full text: orders:get #41]');
  });

  it('renders exactly at the whole-row boundary without a pointer', () => {
    const exact = 'x'.repeat(OWNER_DIRECTIVE_WHOLE_MAX);
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
    // Each long row renders ~260 chars; enough rows to blow the cap.
    const long = 'L'.repeat(1000);
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
