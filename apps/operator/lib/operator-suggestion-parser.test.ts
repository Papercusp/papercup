import { describe, expect, it } from 'vitest';
import { parseSuggestions } from './operator-suggestion-parser';

describe('parseSuggestions', () => {
  it('extracts a well-formed block', () => {
    const text = `
some prose
<suggestion>
{"title":"Run validator","why":"Worker just finished","action":"send_directive","target_harness":"foo","directive_kind":"Directive","directive_subject":"validate F-001","directive_body":"Please validate F-001","auto_dispatch":false,"reason":"underspecified — let the user confirm before dispatch"}
</suggestion>
trailing prose
`;
    const r = parseSuggestions(text);
    expect(r.parseErrors).toEqual([]);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].title).toBe('Run validator');
    expect(r.suggestions[0].auto_dispatch).toBe(false);
  });

  it('extracts multiple blocks', () => {
    const text = `
<suggestion>
{"title":"a","why":"b","action":"advise","target_harness":null,"directive_kind":null,"directive_subject":"","directive_body":"","auto_dispatch":false,"reason":"plenty of reason here"}
</suggestion>
<suggestion>
{"title":"c","why":"d","action":"open","target_harness":"x","directive_kind":null,"directive_subject":"","directive_body":"","auto_dispatch":false,"reason":"another good reason here"}
</suggestion>
`;
    const r = parseSuggestions(text);
    expect(r.suggestions).toHaveLength(2);
  });

  it('records parse error on invalid JSON', () => {
    const text = `<suggestion>{not valid json}</suggestion>`;
    const r = parseSuggestions(text);
    expect(r.suggestions).toHaveLength(0);
    expect(r.parseErrors[0]).toMatch(/JSON parse failed/);
  });

  it('records parse error on schema mismatch', () => {
    const text = `<suggestion>{"title":"a"}</suggestion>`;
    const r = parseSuggestions(text);
    expect(r.suggestions).toHaveLength(0);
    expect(r.parseErrors[0]).toMatch(/schema/);
  });

  it('rejects too-short reason', () => {
    const text = `<suggestion>${JSON.stringify({
      title: 'a',
      why: 'b',
      action: 'advise',
      target_harness: null,
      directive_kind: null,
      directive_subject: '',
      directive_body: '',
      auto_dispatch: false,
      reason: 'short',
    })}</suggestion>`;
    const r = parseSuggestions(text);
    expect(r.suggestions).toHaveLength(0);
    expect(r.parseErrors[0]).toMatch(/reason too short/);
  });

  it('returns empty when there are no blocks', () => {
    const r = parseSuggestions('some text without any suggestion blocks');
    expect(r.suggestions).toHaveLength(0);
    expect(r.parseErrors).toEqual([]);
  });
});
