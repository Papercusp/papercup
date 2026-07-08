/**
 * new-item-parse.test.ts — plans:new parse-feedback (WI-3362).
 *
 * plans:new writes the body verbatim; items are only parsed on READ, so a body
 * with malformed item lines (an agent writes `- [ ] X` instead of the required
 * `- **P-001** `todo` X`) used to create a ZERO-item plan with no signal — the
 * agent only found out on a later plans:get and burned extra tool calls.
 *
 * These tests are the recurrence guard for that silent-partial-success class:
 * a body whose list lines look like items but do NOT parse must come back with
 * a nonzero `unparsedItemLines` + a hint naming the real fix tool
 * (plans:set-content), NEVER a silent 0-item success. Pure — no PG / lock.
 */
import { describe, it, expect } from 'vitest';
import { buildTemplate, summarizeItemParse, detectUnparsedItemLines } from '../new';

const base = {
  slug: 'x-plan-2026-07-08',
  title: 'X Plan',
  status: 'active',
  owner: null,
  date: '2026-07-08',
};

/** buildTemplate(frontmatter + body) → the exact bytes plans:new writes. */
function written(body: string): string {
  return buildTemplate({ ...base, body });
}

describe('plans:new parse-feedback — summarizeItemParse', () => {
  it('THE GUARD: a checkbox body (the real fumble) reports unparsed items, not a silent 0', () => {
    const body = [
      '## Phase 1 — TODO',
      '',
      '- [ ] Add a first line under the ## Log heading',
      '- [ ] Add a second line under the ## Log heading',
    ].join('\n');
    const s = summarizeItemParse(written(body), { bodyProvided: true });
    expect(s.itemsParsed).toBe(0);
    expect(s.unparsedItemLines).toBe(2);
    expect(s.unparsedSamples?.length).toBe(2);
    expect(s.hint).toContain('plans:set-content');
    expect(s.hint).toContain('P-001'); // shows the grammar
  });

  it('well-formed items parse, are echoed, and produce NO hint', () => {
    const body = [
      '## Phase 1',
      '',
      '- **P-001** `todo` Add a first line',
      '- **P-002** `wip` Add a second line',
    ].join('\n');
    const s = summarizeItemParse(written(body), { bodyProvided: true });
    expect(s.itemsParsed).toBe(2);
    expect(s.items.map((i) => i.id)).toEqual(['P-001', 'P-002']);
    expect(s.items[0]).toMatchObject({ id: 'P-001', status: 'todo', text: 'Add a first line' });
    expect(s.items[1]?.status).toBe('wip');
    expect(s.unparsedItemLines).toBeUndefined();
    expect(s.hint).toBeUndefined();
  });

  it('a body with an id but the wrong format (no bold/backticks) is flagged', () => {
    const body = '## Phase 1\n\n- P-001 todo Add a first line';
    const s = summarizeItemParse(written(body), { bodyProvided: true });
    expect(s.itemsParsed).toBe(0);
    expect(s.unparsedItemLines).toBe(1);
    expect(s.hint).toContain('plans:set-content');
  });

  it('a prose body with no items yields the 0-item hint naming plans:set-content', () => {
    const body = '## Background\n\nThis plan just has prose, no items yet.';
    const s = summarizeItemParse(written(body), { bodyProvided: true });
    expect(s.itemsParsed).toBe(0);
    expect(s.unparsedItemLines).toBeUndefined();
    expect(s.hint).toContain('plans:set-content');
  });

  it('PRECISION: prose bullets under ## Background are NOT flagged as items', () => {
    const body = [
      '## Background',
      '',
      '- some context point',
      '- another context point',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` The one real item',
    ].join('\n');
    const s = summarizeItemParse(written(body), { bodyProvided: true });
    expect(s.itemsParsed).toBe(1);
    expect(s.unparsedItemLines).toBeUndefined();
    expect(s.hint).toBeUndefined();
  });

  it('PRECISION: bullets inside a fenced code block are ignored', () => {
    const body = [
      '## Background',
      '',
      'Example of what NOT to write:',
      '',
      '```',
      '- [ ] this is only an example',
      '- **P-001** `todo` also just an example',
      '```',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` The real item',
    ].join('\n');
    const s = summarizeItemParse(written(body), { bodyProvided: true });
    expect(s.itemsParsed).toBe(1);
    expect(s.unparsedItemLines).toBeUndefined();
  });

  it('the empty starter template (no body) reports 0 items and NO scary hint', () => {
    // bodyProvided:false is what the handler passes when args.body is absent.
    const s = summarizeItemParse(buildTemplate(base), { bodyProvided: false });
    expect(s.itemsParsed).toBe(0);
    expect(s.hint).toBeUndefined();
  });

  it('caps the echoed items and reports the true total', () => {
    const lines = ['## Phase 1', ''];
    for (let i = 1; i <= 60; i++) {
      lines.push('- **P-' + String(i).padStart(3, '0') + '** `todo` item ' + i);
    }
    const s = summarizeItemParse(written(lines.join('\n')), { bodyProvided: true });
    expect(s.itemsParsed).toBe(60);
    expect(s.items.length).toBe(50); // ITEM_ECHO_CAP
  });
});

describe('detectUnparsedItemLines — precision unit', () => {
  it('does not re-flag a line the parser already accepted', () => {
    const body = written('## Phase 1\n\n- **P-001** `todo` fine');
    // Feed the parser-accepted rawline in so it is skipped.
    const accepted = new Set(['- **P-001** `todo` fine']);
    expect(detectUnparsedItemLines(body, accepted)).toEqual([]);
  });

  it('flags a numbered-list attempt under a Phase heading', () => {
    const body = written('## Phase 1\n\n1. Do the first thing');
    const found = detectUnparsedItemLines(body, new Set());
    expect(found.length).toBe(1);
    expect(found[0]?.text).toContain('Do the first thing');
  });
});
