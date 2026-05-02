import { describe, it, expect } from 'vitest';
import { buildOperatorPrompt } from './operator-prompt';

describe('buildOperatorPrompt', () => {
  it('includes the request text in the prompt', () => {
    const r = buildOperatorPrompt({ request: 'Test request', showFirstRun: false });
    expect(r.promptText).toContain('Test request');
  });

  it('marks isFirstRun=true when showFirstRun is forced', () => {
    const r = buildOperatorPrompt({ request: 'x', showFirstRun: true });
    expect(r.isFirstRun).toBe(true);
    expect(r.promptText).toContain("I'm the Operator");
  });

  it('includes the suggestion schema', () => {
    const r = buildOperatorPrompt({ request: 'scan', showFirstRun: false });
    expect(r.promptText).toContain('<suggestion>');
    expect(r.promptText).toContain('auto_dispatch');
    expect(r.promptText).toContain('directive_body');
  });

  it('includes the principal identity hint', () => {
    const r = buildOperatorPrompt({ request: 'x', showFirstRun: false });
    expect(r.promptText).toContain('system:operator');
  });

  it('includes the dispatch action types', () => {
    const r = buildOperatorPrompt({ request: 'x', showFirstRun: false });
    expect(r.promptText).toContain('send_directive');
    expect(r.promptText).toContain('open');
    expect(r.promptText).toContain('draft');
    expect(r.promptText).toContain('advise');
  });
});
