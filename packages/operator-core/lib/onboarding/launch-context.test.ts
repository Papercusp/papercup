import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderTutorTemplate, resolveTutorPromptSource, type TutorTokens } from './launch-context';

const TOKENS: TutorTokens = {
  os: 'linux',
  agent: 'claude',
  workspacePath: '/home/u/.papercusp-workspaces/ws-1',
  appVersion: '1.2.3',
  mode: 'first-run',
  setupStatusJson: '{"statuses":{}}',
  tutorialProgressJson: '{}',
};

describe('renderTutorTemplate', () => {
  it('replaces every token, including repeats', () => {
    const out = renderTutorTemplate('{{OS}} {{MODE}} {{OS}} {{TUTORIAL_PROGRESS_JSON}}', TOKENS);
    expect(out).toBe('linux first-run linux {}');
  });
});

describe('resolveTutorPromptSource', () => {
  it('walks the fallback chain and returns null when absent', () => {
    const hit = '/srv/operator/prompts/onboarding-tutor.md';
    expect(resolveTutorPromptSource('/srv/operator', (p) => p === hit)).toBe(hit);
    expect(resolveTutorPromptSource('/nowhere', () => false)).toBeNull();
  });
});

describe('the REAL onboarding-tutor.md source (token-drift guard)', () => {
  // Renderer and prompt source must agree on the token set — a token typo in
  // the .md would otherwise ship literally into a live tutor session.
  const source = join(__dirname, '../../../../apps/operator/prompts/onboarding-tutor.md');

  it.skipIf(!existsSync(source))('renders with ZERO leftover {{TOKEN}}s', () => {
    const rendered = renderTutorTemplate(readFileSync(source, 'utf8'), TOKENS);
    const leftovers = rendered.match(/{{[A-Z_]+}}/g) ?? [];
    expect(leftovers).toEqual([]);
    // Owner-verbatim finale opener must survive rendering untouched
    // (whitespace-normalized: the source hard-wraps lines).
    expect(rendered.replace(/\s+/g, ' ')).toContain('Now the last piece is the GUI');
    // The section protocol line is the tutorial's engine — pin it.
    expect(rendered).toContain('[1] Continue · [2] More details · or just type your question');
  });
});
