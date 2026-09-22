/**
 * P-025 — a fleet leader's brief renders the never-drop facts in its scope.
 *
 * BAR (SPEC-P-025-LEADER-BRIEF-NEVER-DROP-FACTS): "A fleet leader's brief
 * renders the never-drop facts that apply to that leader's scope."
 *
 * WHY THIS ITEM EXISTS: a fleet leader has the widest blast radius on the pot
 * and, before this, received NO wall / dead-end / guard-rail facts at all — the
 * "antidote absent where the poison is strongest" failure EI-18725816532600240
 * established for cold wakes. Measured before the fix: `neverDrop|never-drop`
 * occurred 0 times in leader-brief.ts, against a positive control
 * (`announcedGates|announcement`) of 22 in the SAME file, so the zero was a
 * measurement rather than a broken grep.
 *
 * FALSIFIABILITY. The registry-driven tests below are the controls: the reader
 * is wired to the shared declaration, so revoking the `leader-brief` sink must
 * turn the field OFF. A test that only asserted the happy path would pass just
 * as well against a hardcoded reader that ignores `applicableSinks` entirely.
 */
import { describe, expect, it } from 'vitest';
import { readLeaderNeverDropFacts } from './leader-brief';
import { shapeLeaderBrief } from './leader-brief-shape';
import { ORIENTATION_CLASS_REGISTRY } from '../../orientation-class-registry';
import type { RegisteredOrientationClass } from '../../orientation-class-registry';
import type { AgentFact } from '../../agent-facts/store';

const fact = (key: string): AgentFact =>
  ({ scope: 'workspace', scopeRef: null, key, body: 'b', sourceRef: null, audienceScope: null }) as AgentFact;

/** The registry with `neverDropFacts` withdrawn from the leader-brief sink. */
const withoutLeaderBriefSink = (): readonly RegisteredOrientationClass[] =>
  ORIENTATION_CLASS_REGISTRY.map((entry) =>
    entry.id === 'neverDropFacts'
      ? { ...entry, applicableSinks: entry.applicableSinks.filter((sink) => sink !== 'leader-brief') }
      : entry,
  );

describe('P-025 — never-drop facts reach the leader brief', () => {
  it('declares the leader-brief sink on the shared neverDropFacts class', () => {
    const entry = ORIENTATION_CLASS_REGISTRY.find((row) => row.id === 'neverDropFacts');
    expect(entry, 'the shared registry must still declare a neverDropFacts class').toBeDefined();
    expect(entry!.applicableSinks).toContain('leader-brief');
    // The turn-start sink must NOT have been traded away for it.
    expect(entry!.applicableSinks).toContain('turn-start');
  });

  it('renders the facts in the leader scope, deduped and sorted', async () => {
    const out = await readLeaderNeverDropFacts(
      { ownerId: 'su-leader', workspaceId: 'ws' },
      { fold: async () => [fact('wall.deploy'), fact('gotcha.pg'), fact('wall.deploy')] },
    );
    // Deduped (one key can resolve from both selectors) and sorted, so a diff in
    // this payload means a real change rather than fold order.
    expect(out).toEqual(['gotcha.pg', 'wall.deploy']);
  });

  it('queries BOTH the workspace scope and this leader owner scope', async () => {
    const seen: unknown[] = [];
    await readLeaderNeverDropFacts(
      { ownerId: 'su-leader', workspaceId: 'ws' },
      {
        fold: async (selectors, opts) => {
          seen.push({ selectors, opts });
          return [fact('wall.deploy')];
        },
      },
    );
    expect(seen).toEqual([
      {
        selectors: [{ scope: 'workspace' }, { scope: 'owner', scopeRef: 'su-leader' }],
        opts: { workspaceId: 'ws' },
      },
    ]);
  });

  it('omits the owner selector when the leader has no owner id', async () => {
    const seen: unknown[] = [];
    await readLeaderNeverDropFacts(
      { ownerId: null, workspaceId: 'ws' },
      {
        fold: async (selectors) => {
          seen.push(selectors);
          return [];
        },
      },
    );
    expect(seen).toEqual([[{ scope: 'workspace' }]]);
  });

  it('reports successful-empty as ABSENT, not [] — an empty array would read as a measured none', async () => {
    const out = await readLeaderNeverDropFacts(
      { ownerId: 'su-leader', workspaceId: 'ws' },
      { fold: async () => [] },
    );
    expect(out).toBeUndefined();
  });

  // FALSIFIABILITY CONTROL: the reader is driven by the shared declaration, not
  // by a hardcoded class name. Withdraw the sink and the field must vanish —
  // and, critically, the fold must never even be called.
  it('renders NOTHING when the class is withdrawn from the leader-brief sink', async () => {
    let folded = 0;
    const out = await readLeaderNeverDropFacts(
      { ownerId: 'su-leader', workspaceId: 'ws' },
      {
        registry: withoutLeaderBriefSink(),
        fold: async () => {
          folded += 1;
          return [fact('wall.deploy')];
        },
      },
    );
    expect(out).toBeUndefined();
    expect(folded, 'an undeclared class must not even read its data source').toBe(0);
  });

  it('is driven by applicableSinks rather than by the class existing at all', async () => {
    // Same registry shape, same fold, only the sink membership differs — so a
    // pass here cannot come from anything except reading applicableSinks.
    const fold = async () => [fact('wall.deploy')];
    const declared = await readLeaderNeverDropFacts({ ownerId: null, workspaceId: 'ws' }, { fold });
    const withdrawn = await readLeaderNeverDropFacts(
      { ownerId: null, workspaceId: 'ws' },
      { fold, registry: withoutLeaderBriefSink() },
    );
    expect(declared).toEqual(['wall.deploy']);
    expect(withdrawn).toBeUndefined();
  });
});

describe('P-025 / D-053 ruling 4 — the new structured field is capped', () => {
  it('caps never-drop facts per tier and discloses the truncation', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `wall.k${String(i).padStart(2, '0')}`);
    const trimmed = shapeLeaderBrief({ ok: true, neverDropFacts: keys }, 'trimmed') as Record<string, unknown>;
    const standard = shapeLeaderBrief({ ok: true, neverDropFacts: keys }, 'standard') as Record<string, unknown>;

    expect((trimmed.neverDropFacts as string[]).length).toBe(8);
    expect((standard.neverDropFacts as string[]).length).toBe(16);
    // A cap that silently drops rows is the failure this disclosure prevents.
    expect(trimmed.neverDropFactsTruncated).toMatchObject({ total: 30, shown: 8 });
    expect(standard.neverDropFactsTruncated).toMatchObject({ total: 30, shown: 16 });
  });

  it('leaves an under-cap set intact and undisclosed', () => {
    const out = shapeLeaderBrief({ ok: true, neverDropFacts: ['wall.a', 'wall.b'] }, 'trimmed') as Record<string, unknown>;
    expect(out.neverDropFacts).toEqual(['wall.a', 'wall.b']);
    expect(out.neverDropFactsTruncated).toBeUndefined();
  });
});
