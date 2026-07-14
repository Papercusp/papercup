/** peer-brief-distiller (ambient-semantic-push P-012, plan D-007 + D-008): the
 *  collision-handle → PEER BRIEF resolver. Verifies it scopes the peer's surface
 *  to the READER's cursor (rank + floor + cap), always keeps the claim identity,
 *  bounds every snippet (never full content — D-007), stamps the brief data-not-
 *  directive, and — the load-bearing cross-agent WI-3532 guard — preserves each
 *  fragment's source provenance under a receiver-facing `peer-*` label so a
 *  peer's self-imposed note can never read as the reader's own owner directive. */
import { describe, it, expect } from 'vitest';
import { buildCursor } from './lexical-cursor';
import { makePush, SEVERITY_BY_MATCHER } from './ambient-push';
import {
  distillPeerBrief,
  deliveredProvenanceLabel,
  checkBriefProvenanceSafe,
  briefDeliveryMode,
  resolveCollisionBrief,
  DEFAULT_PEER_BRIEF_SNIPPET_CHARS,
  type PeerSurface,
  type SurfaceProvenance,
} from './peer-brief-distiller';

/** The reader's own recent work — strong, legible join keys (a WI id, a
 *  path/symbol, domain terms). */
const READER_NOTE = 'debugging psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock';

function frag(kind: PeerSurface['fragments'][number]['kind'], ref: string, text: string, provenance: SurfaceProvenance = 'self-imposed') {
  return { kind, ref, text, provenance };
}

describe('distillPeerBrief — cursor-scoped ranking', () => {
  it('always keeps the claim as the collision identity, even at zero overlap', () => {
    const reader = buildCursor([READER_NOTE]);
    // A claim disjoint from the reader's cursor — still the peer's identity.
    const surface: PeerSurface = {
      sessionId: 'peer-7',
      fragments: [frag('claim', 'intent', 'rotating the mac build VM sudo password', 'peer')],
    };
    const brief = distillPeerBrief(reader, surface);
    expect(brief.claim).toBeDefined();
    expect(brief.claim!.kind).toBe('claim');
    expect(brief.claim!.score).toBe(0); // disjoint, but not dropped
    expect(brief.claim!.deliveredLabel).toBe('peer-cited');
  });

  it('ranks non-claim fragments by relevance to the reader, strongest first', () => {
    const reader = buildCursor([READER_NOTE]);
    const surface: PeerSurface = {
      sessionId: 'peer-7',
      fragments: [
        frag('touched-file', 'notes.md', 'nightly compaction of cold storage logs offsite'), // shares ~"compaction"
        frag('journal', 'j1', 'also poking psu-launcher.mjs restart loop, WI-4790 advisory lock under compaction'), // near-identical
      ],
    };
    const brief = distillPeerBrief(reader, surface, { minScore: 0 });
    expect(brief.fragments[0].ref).toBe('j1'); // strongest overlap leads
    expect(brief.fragments.map((f) => f.ref)).toContain('notes.md');
    expect(brief.fragments[0].sharedTerms).toContain('WI-4790');
  });

  it('floors out fragments disjoint from the reader (counted in droppedBelowFloor)', () => {
    const reader = buildCursor([READER_NOTE]);
    const surface: PeerSurface = {
      sessionId: 'peer-7',
      fragments: [
        frag('journal', 'j1', 'psu-launcher.mjs restart loop WI-4790 compaction advisory lock'), // strong
        frag('dead-end', 'FACT-mac', 'quarterly mac build VM sudo password rotation runbook'), // disjoint
      ],
    };
    const brief = distillPeerBrief(reader, surface);
    expect(brief.fragments.map((f) => f.ref)).toEqual(['j1']);
    expect(brief.totalCandidates).toBe(2);
    expect(brief.droppedBelowFloor).toBe(1);
  });

  it('caps the ranked set at maxFragments', () => {
    const reader = buildCursor([READER_NOTE]);
    const surface: PeerSurface = {
      sessionId: 'peer-7',
      fragments: [1, 2, 3, 4].map((n) =>
        frag('journal', `j${n}`, `psu-launcher.mjs restart loop WI-4790 compaction advisory lock note ${n}`),
      ),
    };
    const brief = distillPeerBrief(reader, surface, { maxFragments: 2 });
    expect(brief.fragments).toHaveLength(2);
    expect(brief.totalCandidates).toBe(4);
  });

  it('skips empty / ref-less fragments', () => {
    const reader = buildCursor([READER_NOTE]);
    const surface: PeerSurface = {
      sessionId: 'peer-7',
      fragments: [frag('journal', '', 'psu-launcher.mjs WI-4790'), frag('journal', 'j2', '   ')],
    };
    const brief = distillPeerBrief(reader, surface);
    expect(brief.fragments).toEqual([]);
    expect(brief.claim).toBeUndefined();
  });
});

describe('distillPeerBrief — distilled, never full content (D-007)', () => {
  it('bounds every snippet to the cap with an ellipsis', () => {
    const reader = buildCursor([READER_NOTE]);
    const long = 'psu-launcher.mjs WI-4790 compaction ' + 'lorem ipsum dolor sit amet '.repeat(40);
    const surface: PeerSurface = { sessionId: 'peer-7', fragments: [frag('journal', 'j1', long)] };
    const brief = distillPeerBrief(reader, surface, { maxSnippetChars: 60 });
    expect(brief.fragments[0].snippet.length).toBeLessThanOrEqual(60);
    expect(brief.fragments[0].snippet.endsWith('…')).toBe(true);
    expect(brief.fragments[0].snippet.length).toBeLessThan(long.length);
  });

  it('the whole brief is stamped data-not-directive', () => {
    const reader = buildCursor([READER_NOTE]);
    const surface: PeerSurface = { sessionId: 'peer-7', fragments: [frag('journal', 'j1', READER_NOTE)] };
    expect(distillPeerBrief(reader, surface).provenance).toBe('data-not-directive');
  });
});

describe('cross-agent WI-3532 guard — provenance preserved, never a reader directive', () => {
  it('renders an owner-to-peer directive as peer context, not the reader’s own order', () => {
    const reader = buildCursor([READER_NOTE]);
    const surface: PeerSurface = {
      sessionId: 'peer-7',
      fragments: [
        frag('checkpoint', 'cp', 'owner told peer: do NOT touch psu-launcher.mjs WI-4790 until the sweep lands', 'owner'),
        frag('journal', 'j1', 'my own hunch on the psu-launcher.mjs WI-4790 compaction lock', 'self-imposed'),
      ],
    };
    const brief = distillPeerBrief(reader, surface, { minScore: 0 });
    const byRef = Object.fromEntries(brief.fragments.map((f) => [f.ref, f]));
    // Source provenance preserved verbatim...
    expect(byRef['cp'].provenance).toBe('owner');
    // ...but delivered under a peer-scoped label — never a bare owner directive.
    expect(byRef['cp'].deliveredLabel).toBe('peer-owner-directive');
    expect(byRef['j1'].deliveredLabel).toBe('peer-self-imposed');
    expect(checkBriefProvenanceSafe(brief)).toEqual([]);
  });

  it('deliveredProvenanceLabel maps every source to a peer-scoped label', () => {
    const cases: SurfaceProvenance[] = ['owner', 'self-imposed', 'peer', 'inferred', 'system'];
    for (const p of cases) expect(deliveredProvenanceLabel(p).startsWith('peer-')).toBe(true);
    expect(deliveredProvenanceLabel('owner')).toBe('peer-owner-directive');
  });

  it('checkBriefProvenanceSafe flags a tampered brief (leaked authority / full content)', () => {
    const reader = buildCursor([READER_NOTE]);
    const brief = distillPeerBrief(reader, { sessionId: 'peer-7', fragments: [frag('journal', 'j1', READER_NOTE)] });
    // Tamper: a naked authority label + an over-cap snippet + a non-data provenance.
    const bad = {
      ...brief,
      provenance: 'directive' as unknown as 'data-not-directive',
      fragments: [{ ...brief.fragments[0], deliveredLabel: 'owner', snippet: 'x'.repeat(DEFAULT_PEER_BRIEF_SNIPPET_CHARS + 1) }],
    };
    const kinds = checkBriefProvenanceSafe(bad).map((v) => v.kind);
    expect(kinds).toContain('brief-not-data-not-directive');
    expect(kinds).toContain('label-not-peer-scoped');
    expect(kinds).toContain('snippet-over-cap');
  });
});

describe('delivery mode + collision-handle resolution', () => {
  it('auto-injects only at confirmed-collision severity (critical); else pull-first', () => {
    expect(briefDeliveryMode('critical')).toBe('auto-inject');
    expect(briefDeliveryMode('warning')).toBe('pull');
    expect(briefDeliveryMode('info')).toBe('pull');
    // A collision matcher IS critical — so a real collision push auto-injects.
    expect(SEVERITY_BY_MATCHER['collision']).toBe('critical');
  });

  it('resolves a collision push into the brief, and refuses a surface mismatch', () => {
    const reader = buildCursor([READER_NOTE]);
    const push = makePush({
      matcherKind: 'collision',
      handle: { kind: 'session', ref: 'peer-7', query: ['psu-launcher.mjs'] },
      teaser: 'sustained collision with peer-7',
      score: 0.8,
    });
    const surface: PeerSurface = { sessionId: 'peer-7', fragments: [frag('journal', 'j1', READER_NOTE)] };
    const { mode, brief } = resolveCollisionBrief(push, surface, reader);
    expect(mode).toBe('auto-inject'); // collision → critical → auto-inject
    expect(brief.sessionId).toBe('peer-7');

    const stranger: PeerSurface = { sessionId: 'peer-99', fragments: [] };
    expect(() => resolveCollisionBrief(push, stranger, reader)).toThrow(/mismatch/);
  });
});

describe('distillPeerBrief — purity', () => {
  it('does not mutate its inputs', () => {
    const reader = buildCursor([READER_NOTE]);
    const surface: PeerSurface = {
      sessionId: 'peer-7',
      fragments: [frag('claim', 'intent', 'on psu-launcher.mjs', 'peer'), frag('journal', 'j1', READER_NOTE)],
    };
    const snapshot = JSON.parse(JSON.stringify(surface));
    distillPeerBrief(reader, surface);
    expect(surface).toEqual(snapshot);
  });
});
