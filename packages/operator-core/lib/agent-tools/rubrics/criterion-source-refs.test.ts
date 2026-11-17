import { describe, expect, it, vi } from 'vitest';
import { applyRubricAmendment, planRowToRubric } from '../../rubrics';
import { rubricTemplateDataSchema } from '../plans/rubric-template';
import {
  assertRubricSourceCitationsResolve, resolveRubricSourceCitations,
  type RubricSourceCitationDeps,
} from '../../rubrics-source-citations';

vi.mock('@papercusp/db-org', async orig => ({
  ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { throw new Error('Unit citation checks must not access a live database'); },
}));

const criterion = (sourceRefs: string[]) => ({ key: 'export', title: 'Complete export',
  model: 'Every source identity survives.', method: 'Compare complete identity sets.',
  driftMarkers: 'An identity is missing.', intent: { request: 'Retain all rows.', sourceRefs } });
const dependencies = (): RubricSourceCitationDeps => ({
  plan: async slug => slug === 'source' ? '## Decisions\n\n### D-001 — Preserve rows\n\nNo omissions.\n' : null,
  requirements: async () => ['R-1'],
  turns: async refs => refs.map(ref => ({ ref, ok: !ref.includes('missing'),
    evidence: { fingerprint: 'fixture', speaker: 'user', origin: {
      verdict: ref.includes('injected') ? 'agent-injected' : ref.includes('unknown') ? 'unknown'
        : ref.includes('dialog') ? 'owner-dialog' : 'owner-typed', origin: null,
    } } })),
});
const stored = (criteria: ReturnType<typeof criterion>[]) => {
  // Exercise the canonical storage schema and read projection, including the
  // JSON serialization boundary; integration tests exercise the actual writers.
  const template = rubricTemplateDataSchema.parse({ characteristic: 'export', criteria,
    ratingScale: ['healthy', 'broken', 'unknown'] });
  const rubric = planRowToRubric({ plan_slug: 'cited-standard', workspace_id: 'citation-unit',
    harness_slug: 'papercusp', title: 'Cited standard', status: 'draft', archived: false,
    owner: 'author', created: '2026-11-17', updated: '2026-11-17',
    updated_at: '2026-11-17T00:00:00Z', version: 1,
    template_data: JSON.parse(JSON.stringify(template)),
  });
  expect(rubric).not.toBeNull();
  return rubric!;
};

describe('standard criterion source references', () => {
  it('R-2 Citations survive write and read', () => {
    const original = ['plan:source#R-1', 'session_turn:codex:typed:0'];
    const before = stored([criterion(original)]);
    expect(before.criteria[0]!.intent!.sourceRefs).toEqual(original);
    const revised = ['plan:source#D-001', ...original, 'session_turn:claude:dialog:0'];
    const amendment = applyRubricAmendment(before, { rubricId: before.rubricId,
      requirement: { key: 'export', intent: { request: 'Preserve source intent.', sourceRefs: revised } } });
    const after = stored(amendment.criteria as ReturnType<typeof criterion>[]);
    expect(after.criteria[0]!.intent!.sourceRefs).toEqual(revised);
    expect(before.criteria[0]!.intent!.sourceRefs).toEqual(original);
  });

  it('R-8 Unresolvable citations are refused', async () => {
    for (const ref of ['plan:missing#R-1', 'plan:source#R-404', 'plan:source#D-404',
      'session_turn:codex:missing:0', 'session_turn:codex:injected:0']) {
      await expect(assertRubricSourceCitationsResolve([criterion([ref])], [], dependencies()))
        .rejects.toThrow('rubric_source_citation_unresolved');
    }
  });

  it('R-35 Resolving citations are accepted', async () => {
    const refs = ['plan:source#R-1', 'plan:source#D-001', 'session_turn:codex:typed:0',
      'session_turn:claude:dialog:0', 'session_turn:codex:unknown:0'];
    const criteria = [criterion(refs)];
    await expect(assertRubricSourceCitationsResolve(criteria, [], dependencies())).resolves.toBeUndefined();
    await expect(assertRubricSourceCitationsResolve(criteria, [criterion(['plan:source#R-1'])], dependencies()))
      .resolves.toBeUndefined();
    const read = await resolveRubricSourceCitations(criteria, dependencies());
    expect(read[0]!.citations.map(c => c.status)).toEqual([
      'resolved', 'resolved', 'verified-owner', 'verified-owner', 'unverified',
    ]);
  });
});
