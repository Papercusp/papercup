import { describe, it, expect } from 'vitest';
import { markContestedFacts, describeContestForReader } from './contested-fold';
import { CONTEST_MIN_OTHER_AUTHORS } from '../../facts/contested-key';
import type { AgentFact, SupersededVersionRow } from '../../agent-facts/store';

/** Minimal fact shaped like the fold's input; only the identity fields matter here. */
function fact(over: Partial<AgentFact> = {}): AgentFact {
  return {
    scope: 'workspace',
    scopeRef: null,
    key: 'gate-candidate-sha',
    body: 'the gate is judging 4a9b218b',
    createdBy: 'su-me',
    kind: null,
    settledBy: null,
    updatedAt: '2026-08-02T00:00:00Z',
    ...over,
  } as AgentFact;
}

function version(over: Partial<SupersededVersionRow> = {}): SupersededVersionRow {
  return {
    scope: 'workspace',
    scopeRef: null,
    key: 'gate-candidate-sha',
    createdBy: 'su-a',
    body: 'it is 1ee32228',
    kind: null,
    settledBy: null,
    updatedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('markContestedFacts', () => {
  it('marks a key several OTHER agents have answered differently', async () => {
    const out = await markContestedFacts(
      [fact()],
      async () => [version({ createdBy: 'su-a' }), version({ createdBy: 'su-b' })],
    );
    expect(out[0].contested).toBeDefined();
    expect(out[0].contested!.priorAuthors).toEqual(['su-a', 'su-b']);
    expect(out[0].contested!.priorVersions).toBe(2);
    expect(out[0].contested!.note).toContain('CONTESTED KEY');
  });

  it('does NOT mark a key below the shared threshold', async () => {
    const out = await markContestedFacts([fact()], async () => [version({ createdBy: 'su-a' })]);
    expect(out[0].contested).toBeUndefined();
    expect(CONTEST_MIN_OTHER_AUTHORS).toBe(2); // the write path's threshold, not a second copy
  });

  it("does NOT count the fact's OWN author as a dispute — re-asserting your own key is not contest", async () => {
    const out = await markContestedFacts(
      [fact({ createdBy: 'su-me' })],
      async () => [version({ createdBy: 'su-me' }), version({ createdBy: 'su-me' })],
    );
    expect(out[0].contested).toBeUndefined();
  });

  it('marks a SETTLED-UNDECIDABLE key even with a single prior author', async () => {
    const out = await markContestedFacts(
      [fact()],
      async () => [version({ createdBy: 'su-a', kind: 'undecidable', settledBy: 'the inFlightRetriage marker' })],
    );
    const c = out[0].contested!;
    expect(c.settledUndecidable).toBe(true);
    expect(c.settledBy).toBe('the inFlightRetriage marker');
    expect(c.note).toContain('ALREADY SETTLED AS UNDECIDABLE');
    expect(c.note).toContain('the inFlightRetriage marker');
  });

  it('only the MOST RECENT prior version decides settled-undecidable', async () => {
    // An older undecidable that has since been superseded by a plain answer is NOT a
    // standing "stop re-deriving" — reading it as one would freeze a settled question.
    const out = await markContestedFacts(
      [fact()],
      async () => [
        version({ createdBy: 'su-a', kind: 'conclusion' }),
        version({ createdBy: 'su-b', kind: 'undecidable' }),
      ],
    );
    expect(out[0].contested!.settledUndecidable).toBe(false);
  });

  it('does NOT merge the same key across DIFFERENT scopes', async () => {
    // owner:su-x/foo and harness:papercusp/foo are different questions; merging them would
    // invent a dispute between agents who never addressed the same thing.
    const out = await markContestedFacts(
      [fact({ scope: 'harness', scopeRef: 'papercusp', key: 'foo' })],
      async () => [
        version({ scope: 'owner', scopeRef: 'su-x', key: 'foo', createdBy: 'su-a' }),
        version({ scope: 'owner', scopeRef: 'su-x', key: 'foo', createdBy: 'su-b' }),
      ],
    );
    expect(out[0].contested).toBeUndefined();
  });

  it('marks only the contested fact in a mixed fold, leaving the rest untouched', async () => {
    const out = await markContestedFacts(
      [fact({ key: 'quiet' }), fact({ key: 'loud' })],
      async () => [
        version({ key: 'loud', createdBy: 'su-a' }),
        version({ key: 'loud', createdBy: 'su-b' }),
      ],
    );
    expect(out[0].contested).toBeUndefined();
    expect(out[1].contested).toBeDefined();
  });

  it('is FAIL-SOFT: a read failure returns the facts unmarked, never throws', async () => {
    const input = [fact()];
    const out = await markContestedFacts(input, async () => {
      throw new Error('pg down');
    });
    expect(out).toHaveLength(1);
    expect(out[0].contested).toBeUndefined();
  });

  it('short-circuits an empty fold without reading', async () => {
    let called = false;
    const out = await markContestedFacts([], async () => {
      called = true;
      return [];
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('does not mutate the input facts (the fold returns copies)', async () => {
    const input = fact();
    const out = await markContestedFacts(
      [input],
      async () => [version({ createdBy: 'su-a' }), version({ createdBy: 'su-b' })],
    );
    expect(out[0].contested).toBeDefined();
    expect((input as { contested?: unknown }).contested).toBeUndefined();
  });
});

describe('describeContestForReader', () => {
  it('is READ-voiced, not write-voiced (the assert-path prose is wrong here)', () => {
    const n = describeContestForReader({
      settledUndecidable: false,
      settledBy: null,
      priorAuthors: ['su-a', 'su-b'],
      priorVersions: 3,
    });
    // assessKeyContest addresses someone mid-write; this reader has written nothing.
    expect(n).not.toContain('this write');
    expect(n).not.toContain('Before adding another');
    expect(n).toContain('WHAT WOULD YOU DO DIFFERENTLY');
  });

  it('an undecidable with no exit condition says so instead of implying one', () => {
    const n = describeContestForReader({
      settledUndecidable: true,
      settledBy: null,
      priorAuthors: ['su-a'],
      priorVersions: 1,
    });
    expect(n).toContain('no exit condition');
  });
});
