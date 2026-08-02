/**
 * P-009 — executable advisories.
 *
 * The behaviour under test is not "does it format a string" but the four
 * properties the advisory path depends on: the envelope matches what the pair's
 * own `cover()` describes, pairs whose answer is NOT a call get no envelope, a
 * broken rewrite costs an envelope rather than a command, and an envelope that
 * cannot be rendered is dropped whole rather than half-shipped.
 */

import { describe, expect, it } from 'vitest';
import {
  attachInvokeEnvelopes,
  deriveInvokeEnvelope,
  envelopeFromPair,
  renderInvokeEnvelope,
  MAX_RENDERED_ENVELOPE_CHARS,
} from './invoke-envelope';
import { ALL_PAIRS } from './pairs';
import type { CoverageResult, ReplayToolCall, SubstitutionPair } from './types';

/** A minimal pair whose `rewrite` the test controls. */
function fakePair(rewrite: SubstitutionPair['rewrite']): SubstitutionPair {
  return {
    id: 'test.fake',
    intentLabel: 'test-fake',
    bashPattern: /^never-matches$/,
    toolName: 'capability:read',
    advisoryText: 'irrelevant',
    routing: { want: 'w', use: 'u', insteadOf: 'i' },
    expectedVerdict: 'equivalent',
    cover: (): CoverageResult => ({ covered: true, expression: 'x' }),
    rewrite,
  };
}

describe('deriveInvokeEnvelope — the file-read family', () => {
  // The plan's own worked example, kept verbatim so a regression reads as a
  // failure against the spec rather than against an implementation detail:
  // "`tail -25 /tmp/x.log` should yield a ready `{ file_path: '/tmp/x.log',
  // tail: 25 }`, not a sentence the agent must translate."
  it('turns `tail -n 25 FILE` into the finished capability:read call', () => {
    expect(deriveInvokeEnvelope('file-tail-read', 'tail -n 25 /tmp/x.log')).toEqual({
      name: 'capability:read',
      args: { file_path: '/tmp/x.log', tail: 25 },
    });
  });

  it('maps a sed range onto offset + INCLUSIVE limit', () => {
    // 10..40 inclusive is 31 lines, not 30. The off-by-one is the whole reason
    // an agent should not be asked to do this translation by hand.
    expect(deriveInvokeEnvelope('file-range-read', "sed -n '10,40p' /tmp/x.log")).toEqual({
      name: 'capability:read',
      args: { file_path: '/tmp/x.log', offset: 10, limit: 31 },
    });
  });

  it('turns `cat FILE` into a bare whole-file read', () => {
    expect(deriveInvokeEnvelope('file-whole-read', 'cat /tmp/x.log')).toEqual({
      name: 'capability:read',
      args: { file_path: '/tmp/x.log' },
    });
  });

  it("carries head's POSIX default of 10 rather than the tool's 2000-line page", () => {
    // D-055 found this exact case as a 200x over-read. If the envelope ever
    // drifts back to READ_DEFAULT_LIMIT, the advisory would tell an agent to
    // read 2000 lines where `head` returned 10 — and now it would say so in a
    // form the agent runs without reading.
    expect(deriveInvokeEnvelope('file-head-read', 'head /tmp/x.log')).toEqual({
      name: 'capability:read',
      args: { file_path: '/tmp/x.log', limit: 10 },
    });
  });

  it('declines an atom the pair cannot express exactly', () => {
    // `tail -f` is outside the pattern AND unexpressible. The advisory may still
    // fire from a drifted DB row; the envelope must not invent a call for it.
    expect(deriveInvokeEnvelope('file-tail-read', 'tail -f /tmp/x.log')).toBeNull();
  });
});

describe('deriveInvokeEnvelope — the test-running family (the promotion row)', () => {
  it('turns the router form into a finished testing:run call', () => {
    expect(
      deriveInvokeEnvelope('run-test-files', 'npm run test:file -- packages/operator-core/lib/a.test.ts'),
    ).toEqual({ name: 'testing:run', args: { files: ['packages/operator-core/lib/a.test.ts'] } });
  });

  it('carries a -t pattern through as testNamePattern', () => {
    expect(
      deriveInvokeEnvelope(
        'run-test-files',
        'npm run test:file -- packages/operator-core/lib/a.test.ts -- -t "renders the header"',
      ),
    ).toEqual({
      name: 'testing:run',
      args: { files: ['packages/operator-core/lib/a.test.ts'], testNamePattern: 'renders the header' },
    });
  });

  it('turns the raw-vitest BYPASS form into the same routed call', () => {
    // The substitution that removes the zero-match false green, so the envelope
    // for it is the one most worth being executable.
    expect(deriveInvokeEnvelope('run-test-files-unrouted', 'npx vitest run packages/operator-core/lib/a.test.ts')).toEqual({
      name: 'testing:run',
      args: { files: ['packages/operator-core/lib/a.test.ts'] },
    });
  });

  it('declines a redirect-to-log run, which the tool cannot reproduce', () => {
    // The command's literal effect includes an artifact testing:run never
    // writes. cover() already refuses it; the envelope must not offer a call
    // that silently drops the file the agent asked for.
    expect(
      deriveInvokeEnvelope(
        'run-test-files',
        'npm run test:file -- packages/operator-core/lib/a.test.ts > /tmp/run.log 2>&1',
      ),
    ).toBeNull();
  });

  it('declines `npm run test:affected` — the recorded non-substitute', () => {
    expect(deriveInvokeEnvelope('run-affected-tests', 'npm run test:affected')).toBeNull();
  });
});

describe('pairs whose answer is not a call get no envelope', () => {
  // The load-bearing negative. These rows name `coord:orient` as their tool, but
  // their advisories say the answer ALREADY ARRIVED and to call nothing —
  // calling orient to read a clock costs more than the `date` it replaced. An
  // envelope here would invert the exact advice the row exists to give.
  it.each(['current-time', 'host-load', 'host-cores', 'host-memory'])(
    'ambient row %s yields no executable call',
    (intent) => {
      expect(deriveInvokeEnvelope(intent, 'date -u')).toBeNull();
      expect(deriveInvokeEnvelope(intent, 'uptime')).toBeNull();
    },
  );

  it('holds that property structurally: no ambient pair declares a rewrite', () => {
    // The test above pins today's behaviour; this pins the MECHANISM, so adding
    // a rewrite to an ambient pair fails here with a reason rather than only
    // showing up as a surprising advisory in production.
    const ambient = ALL_PAIRS.filter((p) =>
      ['current-time', 'host-load', 'host-cores', 'host-memory'].includes(p.intentLabel),
    );
    expect(ambient.length).toBeGreaterThan(0);
    for (const pair of ambient) expect(pair.rewrite).toBeUndefined();
  });

  it('returns null for an intent with no code pair (a hand-added registry row)', () => {
    expect(deriveInvokeEnvelope('no-such-intent-label', 'cat /tmp/x.log')).toBeNull();
  });

  it('returns null for a pair that declares no rewrite', () => {
    expect(envelopeFromPair(fakePair(undefined), 'anything')).toBeNull();
  });
});

describe('fail-open', () => {
  it('a throwing rewrite costs an envelope, never the command', () => {
    const pair = fakePair(() => {
      throw new Error('parser blew up');
    });
    expect(() => envelopeFromPair(pair, 'cat /tmp/x.log')).not.toThrow();
    expect(envelopeFromPair(pair, 'cat /tmp/x.log')).toBeNull();
  });

  it.each([
    ['no tool name', { toolName: '', args: { a: 1 } }],
    ['non-object args', { toolName: 'capability:read', args: 'nope' }],
    ['array args', { toolName: 'capability:read', args: [1, 2] }],
  ])('rejects a malformed rewrite result (%s)', (_label, bad) => {
    // Rendering one of these would produce `tools:invoke { name: "", … }` —
    // strictly worse than prose, because it looks runnable.
    const pair = fakePair(() => bad as unknown as ReplayToolCall);
    expect(envelopeFromPair(pair, 'cat /tmp/x.log')).toBeNull();
  });
});

describe('renderInvokeEnvelope', () => {
  it('renders a paste-ready tools:invoke line with JSON args', () => {
    expect(
      renderInvokeEnvelope({ name: 'capability:read', args: { file_path: '/tmp/x.log', tail: 25 } }),
    ).toBe('tools:invoke { name: "capability:read", args: {"file_path":"/tmp/x.log","tail":25} }');
  });

  it('quotes paths that need it, because the args are JSON not JS source', () => {
    const line = renderInvokeEnvelope({
      name: 'capability:read',
      args: { file_path: '/tmp/a b/"q".log' },
    });
    // The point is that the result parses back — a hand-formatted object
    // literal would not survive either the space or the embedded quote.
    const args = JSON.parse(line!.slice(line!.indexOf('args: ') + 6, -2));
    expect(args).toEqual({ file_path: '/tmp/a b/"q".log' });
  });

  it('drops an oversized render rather than truncating it', () => {
    // A truncated `tools:invoke {…` is not executable but LOOKS executable, so
    // the agent pays the paste before discovering it was cut.
    const huge = renderInvokeEnvelope({
      name: 'dev:pg_query',
      args: { sql: 'x'.repeat(MAX_RENDERED_ENVELOPE_CHARS + 100) },
    });
    expect(huge).toBeNull();
  });

  it('returns null for non-serialisable args instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(renderInvokeEnvelope({ name: 'capability:read', args: cyclic })).toBeNull();
  });
});

describe('attachInvokeEnvelopes', () => {
  it('adds invoke + invokeLine to a match that can carry one, preserving other fields', () => {
    const [out] = attachInvokeEnvelopes([
      { intentLabel: 'file-tail-read', atom: 'tail -n 25 /tmp/x.log', tier: 'advise' },
    ]);
    expect(out).toMatchObject({
      intentLabel: 'file-tail-read',
      atom: 'tail -n 25 /tmp/x.log',
      tier: 'advise',
      invoke: { name: 'capability:read', args: { file_path: '/tmp/x.log', tail: 25 } },
    });
    expect(out?.invokeLine).toContain('tools:invoke { name: "capability:read"');
  });

  it('leaves a match untouched when no envelope can be derived', () => {
    const [out] = attachInvokeEnvelopes([{ intentLabel: 'current-time', atom: 'date -u' }]);
    expect(out).toEqual({ intentLabel: 'current-time', atom: 'date -u' });
    expect(out).not.toHaveProperty('invoke');
    expect(out).not.toHaveProperty('invokeLine');
  });

  it('never ships a structured envelope without its rendered line', () => {
    // The two must appear together: shipping `invoke` alone would hand the
    // gates the formatting job this module exists to keep away from them.
    const out = attachInvokeEnvelopes(
      ALL_PAIRS.map((p) => ({ intentLabel: p.intentLabel, atom: 'tail -n 25 /tmp/x.log' })),
    );
    for (const row of out) {
      expect(Boolean(row.invoke)).toBe(Boolean(row.invokeLine));
    }
  });

  it('is a no-op on an empty match list', () => {
    expect(attachInvokeEnvelopes([])).toEqual([]);
  });
});
