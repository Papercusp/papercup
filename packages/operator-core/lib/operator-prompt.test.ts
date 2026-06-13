import { describe, it, expect, vi } from 'vitest';

vi.mock('./operator-state-pg', () => ({
  readOperatorState: async () => null,
  writeOperatorState: async () => {},
  updateOperatorState: async () => {},
}));
vi.mock('./operator-preferences', () => ({
  loadPreferences: async () => ({ raw: '', standingApprovals: [] }),
}));
vi.mock('./harness-markdown-index', () => ({
  loadHarnessMarkdownIndex: () => ({}),
  renderHarnessMarkdownIndexForPrompt: () => '',
}));

import { buildOperatorPrompt } from './operator-prompt';

describe('buildOperatorPrompt (v5)', () => {
  it('includes the request text', async () => {
    const r = await buildOperatorPrompt({ request: 'Test request', userId: 'u1', showFirstRun: false });
    expect(r.promptText).toContain('Test request');
  });

  it('marks isFirstRun=true when forced', async () => {
    const r = await buildOperatorPrompt({ request: 'x', userId: 'u1', showFirstRun: true });
    expect(r.isFirstRun).toBe(true);
    expect(r.promptText).toContain("I'm the Operator");
  });

  it('includes the substrate prompt with the suggestion schema', async () => {
    const r = await buildOperatorPrompt({ request: 'scan', userId: 'u1', showFirstRun: false });
    expect(r.promptText).toContain('<suggestion>');
    expect(r.promptText).toContain('send_directive');
    expect(r.promptText).toContain('navigate');
    expect(r.promptText).toContain('inform');
  });

  it('includes the canonical tier table', async () => {
    const r = await buildOperatorPrompt({ request: 'x', userId: 'u1', showFirstRun: false });
    expect(r.promptText).toContain('messages:write');
    expect(r.promptText).toContain('harness:dispatch:*');
    expect(r.promptText).toContain('high (fail-safe)');
  });

  it('includes the principal identity hint', async () => {
    const r = await buildOperatorPrompt({ request: 'x', userId: 'u1', showFirstRun: false });
    expect(r.promptText).toContain('system:operator');
  });

  it('does NOT include the v4 advise/draft variants', async () => {
    const r = await buildOperatorPrompt({ request: 'x', userId: 'u1', showFirstRun: false });
    expect(r.promptText).not.toContain('"advise"');
    expect(r.promptText).not.toContain('"draft"');
  });
});
