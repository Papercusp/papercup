/**
 * The operator's prompt + preferences have TWO readers rendering ONE editor:
 * `GET /api/agent-mcp/operator-config` and the sync resolver
 * `operatorConfig.byWorkspace`. They read the same tables and must agree on
 * what an UNSET table renders as. They did not (EI-22439758558949990): the
 * route fell back to the template, the resolver to '', and the Settings ›
 * Papercup form — seeded from the sync read — showed an empty editor whose
 * Save would have written '' over the template every REST reader reported.
 *
 * Two halves: the shared rule's behaviour, and a pin that BOTH readers go
 * through it with the SAME constants (a reader that re-grows a private
 * fallback drifts silently again — the source pin is what makes that loud).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, DEFAULT_PROMPT_USER, operatorConfigContent } from './operator-config-defaults';

describe('operatorConfigContent — the one fallback rule', () => {
  it('renders the default when nothing is stored (null row, missing content, non-string content)', () => {
    expect(operatorConfigContent(null, DEFAULT_PROMPT_USER)).toBe(DEFAULT_PROMPT_USER);
    expect(operatorConfigContent(undefined, DEFAULT_PREFS)).toBe(DEFAULT_PREFS);
    expect(operatorConfigContent({}, DEFAULT_PROMPT_USER)).toBe(DEFAULT_PROMPT_USER);
    expect(operatorConfigContent({ content: 42 }, DEFAULT_PREFS)).toBe(DEFAULT_PREFS);
  });

  it('lets a stored string win — including an explicitly saved empty string', () => {
    expect(operatorConfigContent({ content: '# mine' }, DEFAULT_PROMPT_USER)).toBe('# mine');
    // '' is a value the owner can save; it must not silently revert to the template.
    expect(operatorConfigContent({ content: '' }, DEFAULT_PROMPT_USER)).toBe('');
  });

  it('ships non-empty templates so a fresh install never seeds an empty editor', () => {
    expect(DEFAULT_PROMPT_USER.trim().length).toBeGreaterThan(0);
    expect(DEFAULT_PREFS.trim().length).toBeGreaterThan(0);
  });
});

describe('both readers apply the shared rule with the shared constants', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

  it('the REST route reads prompt + preferences through operatorConfigContent', () => {
    const src = read('endpoint-route/routes/agent-mcp/operator-config.ts');
    expect(src).toMatch(/from '\.\.\/\.\.\/\.\.\/operator-config-defaults'/);
    expect(src).toMatch(/operatorConfigContent\(await readOperatorState/);
    expect(src).toMatch(/readContent\('operator_prompt_user', DEFAULT_PROMPT_USER\)/);
    expect(src).toMatch(/readContent\('operator_preferences', DEFAULT_PREFS\)/);
    // No private copy of the template may re-grow here.
    expect(src).not.toMatch(/const DEFAULT_PROMPT_USER\s*=/);
  });

  it("the sync resolver 'operatorConfig.byWorkspace' falls back to the same defaults, never ''", () => {
    const src = read('sync-resolver/index.ts');
    const start = src.indexOf("'operatorConfig.byWorkspace': {");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("'operatorPreferences.byWorkspace': {", start));
    expect(block).toMatch(/import\('\.\.\/operator-config-defaults'\)/);
    expect(block).toMatch(/prompt_user: defaults\.operatorConfigContent\(prompt, defaults\.DEFAULT_PROMPT_USER\)/);
    expect(block).toMatch(/preferences: defaults\.operatorConfigContent\(prefs, defaults\.DEFAULT_PREFS\)/);
    // The drift this file exists to stop: a bare '' fallback on either field.
    expect(block).not.toMatch(/prompt_user: prompt\?\.content \?\? ''/);
    expect(block).not.toMatch(/preferences: prefs\?\.content \?\? ''/);
  });
});
