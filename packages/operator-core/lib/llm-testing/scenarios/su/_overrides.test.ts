import { describe, expect, it } from 'vitest';

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { SU_S01_HARNESS_SCOPE } from './S01-harness-scope';
import { SU_S02_TAURI_ONLY } from './S02-tauri-only';
import { HARNESS_REQUIRED_GATE, TAURI_APP_VERIFICATION_CONTEXT } from './_overrides';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.map((part) => part.text ?? '').join('\n') ?? '';
}

describe('SU S01/S02 populated scenario worlds', () => {
  it('keeps S01 load-bearing harness rejection and returns grounded plan evidence after recovery', () => {
    const rejected = HARNESS_REQUIRED_GATE.override('plans:search', { query: 'spec-md' });
    expect(textOf(rejected)).toContain('harness_required');

    const scoped = HARNESS_REQUIRED_GATE.override('plans:search', {
      query: 'spec-md',
      harness: 'all',
    });
    expect(textOf(scoped)).toContain('spec-md-deprecation-2026-08-18');
    expect(textOf(scoped)).toContain('P-005');
    expect(textOf(scoped)).toContain('P-007');
    expect(SU_S01_HARNESS_SCOPE.version).toBe(2);
  });

  it('returns S01 docs evidence only after a non-empty harness scope', () => {
    const rejected = HARNESS_REQUIRED_GATE.override('docs:search', { query: 'spec-md' });
    expect(textOf(rejected)).toContain('harness_required');

    const scoped = HARNESS_REQUIRED_GATE.override('docs:get', {
      slugs: ['agent-insights/spec-md-deprecation-migration'],
      harness: 'all',
    });
    expect(textOf(scoped)).toContain('two remaining readers');
    expect(textOf(scoped)).toContain('compatibility adapter');
  });

  it('grounds S02 in the canonical Tauri E2E docs without seeding banned tool names', () => {
    const search = TAURI_APP_VERIFICATION_CONTEXT.override('docs:search', {
      query: 'Papercusp app visual verification',
      harness: 'papercusp',
    });
    const page = TAURI_APP_VERIFICATION_CONTEXT.override('docs:get', {
      slugs: ['testing/agent-e2e'],
      harness: 'papercusp',
    });
    const evidence = `${textOf(search)}\n${textOf(page)}`;

    expect(evidence).toContain('testing/agent-e2e');
    expect(evidence).toContain('Tauri');
    expect(evidence).toContain('tauri-agent-tools');
    expect(evidence).toContain('npm run dev');
    expect(evidence).toContain('exit-coded `check`');
    expect(evidence).not.toMatch(/\bverdict\b|\bxdg-open\b/i);
    expect(SU_S02_TAURI_ONLY.version).toBe(2);
  });

  it('passes unrelated tools through to the target default', () => {
    expect(HARNESS_REQUIRED_GATE.override('coord:presence', {})).toBe(PASS_THROUGH);
    expect(TAURI_APP_VERIFICATION_CONTEXT.override('coord:presence', {})).toBe(PASS_THROUGH);
  });
});
