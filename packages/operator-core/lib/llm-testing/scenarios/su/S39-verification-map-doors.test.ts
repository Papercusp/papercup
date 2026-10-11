import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';
import {
  EXPECTED_DOORS, MAP_DOC_MISSING, SU_S39_VERIFICATION_MAP_DOORS, TRIGGER_TEXT,
  createNoToolsWorld, judgeMapDoorsAnswer, judgeRun, loadMapDocBody, stripFrontmatter,
} from './S39-verification-map-doors';

const CORRECT = 'Yes. Five doors enforce it.\n\n'
  + 'DOORS: plans:start, plans:bind-spec-evidence, plans:set-plan-status, plans:acceptance-disposition, plans:promote\n'
  + 'VAL-STATUS: retired';

const kinds = (texts: string[]) => judgeMapDoorsAnswer(texts).map((v) => v.assertKind);

describe('S39 verification-map doors', () => {
  it('derives exactly the five contract doors from CONTRACT_GATE_CODE_TYPES', () => {
    expect([...EXPECTED_DOORS].sort()).toEqual([
      'plans:acceptance-disposition', 'plans:bind-spec-evidence', 'plans:promote',
      'plans:set-plan-status', 'plans:start',
    ]);
  });

  it('inlines the map body (no frontmatter) and the doc still names every derived door', () => {
    const body = loadMapDocBody();
    expect(body).not.toBeNull();
    expect(TRIGGER_TEXT).not.toContain(MAP_DOC_MISSING);
    expect(TRIGGER_TEXT).toContain('## The doors that enforce the requirement contract');
    expect(TRIGGER_TEXT).not.toContain('GENERATED PROJECTION');
    for (const door of EXPECTED_DOORS) expect(body).toContain('`' + door + '`');
    const trigger = SU_S39_VERIFICATION_MAP_DOORS.triggers?.find((t) => t.param === 0);
    expect(trigger).toMatchObject({ on: 'after_turn', fire: 'user_message', text: TRIGGER_TEXT });
  });

  it('strips only a leading frontmatter block', () => {
    expect(stripFrontmatter('---\ntitle: x\n---\n# Body\n---\nrule')).toBe('# Body\n---\nrule');
    expect(stripFrontmatter('# No frontmatter')).toBe('# No frontmatter');
  });

  it('refuses every tool so the answer can only come from the inlined map', async () => {
    const world = createNoToolsWorld();
    for (const name of ['coord:orient', 'docs:get', 'tools:invoke', 'search:semantic']) {
      const res = await world.override(name, {});
      expect(JSON.parse((res as { content: [{ text: string }] }).content[0].text)).toMatchObject({ ok: false, error: 'tool_unavailable' });
    }
  });

  it('calibration: a correct answer passes, including markdown emphasis and the _ tool-name form', () => {
    expect(judgeMapDoorsAnswer([CORRECT])).toEqual([]);
    expect(judgeMapDoorsAnswer(['**DOORS:** `plans_start`, `plans:bind-spec-evidence`, `plans:set-plan-status` (status shipped), '
      + '`plans:acceptance-disposition`, `plans:promote`\n**VAL-STATUS:** retired'])).toEqual([]);
    // Prose that mentions VAL-* correctly is not a violation.
    expect(judgeMapDoorsAnswer(['VAL-* assertions are retired; plans:promote refuses a plan still carrying one.\n' + CORRECT])).toEqual([]);
  });

  it('control: a missing door fails', () => {
    expect(kinds([CORRECT.replace(', plans:promote', '')])).toEqual(['custom:map-doors-named-exactly']);
  });

  it('control: a tool that only prepares input, named as a door, fails', () => {
    expect(kinds([CORRECT.replace('plans:promote', 'plans:promote, plans:audit')])).toEqual(['custom:map-doors-named-exactly']);
  });

  it('control: VAL-STATUS current fails', () => {
    expect(kinds([CORRECT.replace('VAL-STATUS: retired', 'VAL-STATUS: current')])).toEqual(['custom:map-val-status-retired']);
  });

  it('control: prose describing VAL-* as current fails even with a correct status line', () => {
    expect(kinds(['VAL-* assertions are still the current way to state checks.\n' + CORRECT]))
      .toEqual(['custom:map-val-not-described-current']);
    expect(kinds(['Note: VAL-* is current for older plans.', CORRECT])).toEqual(['custom:map-val-not-described-current']);
  });

  it('control: no structured answer fails', () => {
    expect(kinds(['The doors are plans:start and plans:promote.'])).toEqual(['custom:map-doors-structured-answer']);
  });

  it('judges the first turn that carries the DOORS line', () => {
    const run = { turns: [{ assistantText: 'Thinking...' }, { assistantText: CORRECT }] } as unknown as RunSummary;
    expect(judgeRun(run)).toEqual([]);
    const wrong = { turns: [{ assistantText: CORRECT.replace(', plans:promote', '') }, { assistantText: CORRECT }] } as unknown as RunSummary;
    expect(judgeRun(wrong).map((v) => v.assertKind)).toEqual(['custom:map-doors-named-exactly']);
  });
});
