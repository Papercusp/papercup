import { describe, expect, it, vi } from 'vitest';
import {
  assertRubricSourceCitationsResolve, resolveRubricSourceCitations,
  type RubricSourceCitationDeps, type SourceCitationCriterion,
} from './rubrics-source-citations';

const criterion = (refs?: string[], key = 'export'): SourceCitationCriterion => ({ key,
  ...(refs ? { intent: { request: 'Export the complete population.', sourceRefs: refs } } : {}) });
const deps = (): RubricSourceCitationDeps => ({
  plan: vi.fn(async slug => slug === 'source' ? '## Decisions\n\n### D-001 — Preserve source intent\n\nKeep all records.\n' : null),
  requirements: vi.fn(async () => ['R-1']),
  turns: vi.fn(async refs => refs.map(ref => ({ ref, ok: !ref.includes('missing'),
    evidence: { fingerprint: 'measured', speaker: 'user', origin: {
      verdict: ref.includes('injected') ? 'agent-injected' : ref.includes('dialog') ? 'owner-dialog'
        : ref.includes('unknown') ? 'unknown' : 'owner-typed', origin: null,
    } } }))),
});

describe('standard rubric source citations', () => {
  it('accepts plan requirements and Decisions and returns every original reference unchanged', async () => {
    const refs = ['plan:source#R-1', 'plan:source#D-001', 'plan:papercusp/source#R-1'];
    const input = [criterion(refs)];
    const result = await resolveRubricSourceCitations(input, deps());
    expect(result[0]!.citations.map(c => c.ref)).toEqual(refs);
    expect(result[0]!.citations.map(c => c.status)).toEqual(['resolved', 'resolved', 'resolved']);
    expect(input[0]!.intent!.sourceRefs).toEqual(refs);
    await expect(assertRubricSourceCitationsResolve(input, [], deps())).resolves.toBeUndefined();
  });

  it.each(['plan:missing#R-1', 'plan:source#R-404', 'plan:source#D-404', 'session_turn:codex:missing:0', 'source'])
    ('refuses an unresolvable source intact: %s', async ref => {
      await expect(assertRubricSourceCitationsResolve([criterion([ref])], [], deps()))
        .rejects.toThrow('rubric_source_citation_unresolved');
      expect((await resolveRubricSourceCitations([criterion([ref])], deps()))[0]!.citations[0]!.ref).toBe(ref);
    });

  it('labels only owner-typed and owner-dialog verified and accepts unknown origin unverified', async () => {
    const refs = ['session_turn:codex:typed:0', 'session_turn:claude:dialog:0', 'session_turn:codex:unknown:0'];
    const result = await resolveRubricSourceCitations([criterion(refs)], deps());
    expect(result[0]!.citations.map(c => c.status)).toEqual(['verified-owner', 'verified-owner', 'unverified']);
    await expect(assertRubricSourceCitationsResolve([criterion(refs)], [], deps())).resolves.toBeUndefined();
  });

  it('refuses a verified injected turn as an owner source', async () => {
    await expect(assertRubricSourceCitationsResolve([criterion(['session_turn:codex:injected:0'])], [], deps()))
      .rejects.toThrow('not owner speech');
  });

  it('validates added and changed criteria while preserving untouched uncited legacy criteria', async () => {
    const legacy = criterion();
    await expect(assertRubricSourceCitationsResolve([legacy], [legacy], deps())).resolves.toBeUndefined();
    await expect(assertRubricSourceCitationsResolve([legacy, criterion(['plan:missing#R-1'], 'new')], [legacy], deps()))
      .rejects.toThrow('rubric_source_citation_unresolved');
    await expect(assertRubricSourceCitationsResolve([criterion(['plan:source#R-404'])], [criterion(['plan:source#R-1'])], deps()))
      .rejects.toThrow('rubric_source_citation_unresolved');
  });

  it.each([99, 100, 101])('resolves the decisive last source beyond a batch boundary of %i', async count => {
    const refs = Array.from({ length: count }, (_, i) => `plan:source#R-${i + 1}`);
    const d = deps();
    d.requirements = async () => refs.slice(0, -1).map(ref => ref.split('#')[1]!);
    for (const ordered of [refs, [...refs].reverse()]) {
      const result = await resolveRubricSourceCitations([criterion(ordered)], d);
      expect(result[0]!.citations).toHaveLength(count);
      expect(result[0]!.citations.filter(c => c.status === 'unresolved').map(c => c.ref)).toEqual([refs.at(-1)]);
      await expect(assertRubricSourceCitationsResolve([criterion(ordered)], [], d)).rejects.toThrow(refs.at(-1)!);
    }
  });
});
