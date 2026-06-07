import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOperatorTurn,
  parseReportBody,
  sleepTagToEpochMs,
} from './operator-converse-tags';

describe('parseOperatorTurn', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('extracts say-only turn', () => {
    const r = parseOperatorTurn('<say>Still with me?</say>');
    expect(r.say).toBe('Still with me?');
    expect(r.setMode).toBeNull();
    expect(r.sleep).toBeNull();
  });

  it('extracts say + set_mode together (allowed pairing)', () => {
    const r = parseOperatorTurn(
      '<say>Whenever you are ready.</say>\n<set_mode>passive</set_mode>',
    );
    expect(r.say).toBe('Whenever you are ready.');
    expect(r.setMode).toBe('passive');
    expect(r.sleep).toBeNull();
  });

  it('extracts a bare sleep tag (no say) — going-silent contract', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="30" reason="firm pushback">');
    expect(r.say).toBeNull();
    expect(r.sleep).toEqual({ durationMinutes: 30, reason: 'firm pushback' });
  });

  it('drops sleep when paired with say, keeps the say (warn emitted)', () => {
    const r = parseOperatorTurn(
      '<say>got it</say>\n<sleep duration_minutes="30" reason="x">',
    );
    expect(r.say).toBe('got it');
    expect(r.sleep).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped <sleep>'),
      expect.any(Object),
    );
  });

  it('drops sleep with non-numeric duration (warn emitted)', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="soon" reason="x">');
    expect(r.sleep).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('bad duration_minutes'),
      expect.any(Object),
    );
  });

  it('drops sleep with zero / negative duration', () => {
    expect(parseOperatorTurn('<sleep duration_minutes="0" reason="x">').sleep).toBeNull();
    expect(parseOperatorTurn('<sleep duration_minutes="-5" reason="x">').sleep).toBeNull();
  });

  it('caps absurdly large sleep durations at 1 day (was 30d, tightened)', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="9999999" reason="forever">');
    expect(r.sleep?.durationMinutes).toBe(60 * 24);
  });

  it('accepts both " and \' quoting on attributes', () => {
    const r = parseOperatorTurn(`<sleep duration_minutes='15' reason='soft'>`);
    expect(r.sleep).toEqual({ durationMinutes: 15, reason: 'soft' });
  });

  it('treats empty say content as null', () => {
    const r = parseOperatorTurn('<say>   </say>');
    expect(r.say).toBeNull();
  });

  it('rejects unknown set_mode values', () => {
    const r = parseOperatorTurn('<say>x</say><set_mode>frozen</set_mode>');
    expect(r.setMode).toBeNull();
  });

  it('returns the raw input for telemetry', () => {
    const raw = '<say>hi</say>';
    const r = parseOperatorTurn(raw);
    expect(r.raw).toBe(raw);
  });

  it('handles multi-line say content', () => {
    const r = parseOperatorTurn('<say>line one\nline two</say>');
    expect(r.say).toBe('line one\nline two');
  });

  it('first sleep wins when multiple emitted (defensive)', () => {
    const r = parseOperatorTurn(
      '<sleep duration_minutes="10" reason="a"> ignore <sleep duration_minutes="999" reason="b">',
    );
    expect(r.sleep).toEqual({ durationMinutes: 10, reason: 'a' });
  });

  it('falls back to bare prose as say when no <say> tag emitted', () => {
    // Defensive: the model is supposed to wrap in <say>, but if it
    // doesn't we still want the user to see the reply.
    const r = parseOperatorTurn('Sure, what would you like to work on?');
    expect(r.say).toBe('Sure, what would you like to work on?');
    expect(r.setMode).toBeNull();
    expect(r.sleep).toBeNull();
  });

  it('bare-prose fallback strips set_mode tags from the visible text', () => {
    const r = parseOperatorTurn('Talk to you later <set_mode>passive</set_mode>');
    expect(r.say).toBe('Talk to you later');
    expect(r.setMode).toBe('passive');
  });

  it('bare-prose fallback is skipped when a <sleep> is present (going-silent contract)', () => {
    // Prose around a sleep tag is model noise — silence IS the response.
    const r = parseOperatorTurn(
      'okay <sleep duration_minutes="15" reason="x">',
    );
    expect(r.say).toBeNull();
    expect(r.sleep).toEqual({ durationMinutes: 15, reason: 'x' });
  });

  it('returns all-null on empty input', () => {
    const r = parseOperatorTurn('');
    expect(r.say).toBeNull();
    expect(r.setMode).toBeNull();
    expect(r.sleep).toBeNull();
  });

  it('returns null say but parses tags when input is pure-tag (sleep-only contract)', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="15" reason="ok">');
    expect(r.say).toBeNull();
    expect(r.sleep).toEqual({ durationMinutes: 15, reason: 'ok' });
  });

  // ── <continue/> tag (plan: active-mode-proactive-ticks §C.2) ────
  it('parses <continue/> alongside a <say>', () => {
    const r = parseOperatorTurn('<say>Now dispatching the architect.</say><continue/>');
    expect(r.say).toBe('Now dispatching the architect.');
    expect(r.continue).toBe(true);
  });
  it('accepts <continue /> with whitespace before the slash', () => {
    const r = parseOperatorTurn('<say>Working.</say><continue />');
    expect(r.continue).toBe(true);
  });
  it('continue defaults to false when no tag present', () => {
    const r = parseOperatorTurn('<say>Done.</say>');
    expect(r.continue).toBe(false);
  });
  it('continue alone (no say) does not produce visible prose', () => {
    // Defensive: brain shouldn't emit this, but if it does, the bare-
    // prose fallback strips the tag so the user doesn't see literal
    // '<continue/>' in chat.
    const r = parseOperatorTurn('<continue/>');
    expect(r.say).toBeNull();
    expect(r.continue).toBe(true);
  });
  it('continue + sleep (no say) — both parsed; runtime layer decides which wins', () => {
    // Brain shouldn't normally pair these but if it does, the parser
    // doesn't suppress either. Runtime treats sleep as authoritative
    // (skip auto-fire); continue:true just rides along for logs.
    const r = parseOperatorTurn('<continue/><sleep duration_minutes="5">');
    expect(r.continue).toBe(true);
    expect(r.sleep?.durationMinutes).toBe(5);
    expect(r.say).toBeNull();
  });
});

describe('sleepTagToEpochMs', () => {
  it('adds duration_minutes to the supplied now', () => {
    expect(sleepTagToEpochMs({ durationMinutes: 5 }, 1_000_000_000)).toBe(
      1_000_000_000 + 5 * 60 * 1000,
    );
  });
});

import { clampSay } from './operator-converse-tags';

describe('clampSay', () => {
  it('passes a short string through unchanged', () => {
    expect(clampSay('Hi there.')).toBe('Hi there.');
  });

  it('trims surrounding whitespace', () => {
    expect(clampSay('  hi  ')).toBe('hi');
  });

  it('strips inline markdown markers', () => {
    expect(clampSay('this is **bold** and _italic_ and `code`')).toBe(
      'this is bold and italic and code',
    );
  });

  it('extracts link text from [text](url)', () => {
    expect(clampSay('see [the docs](https://example.com)')).toBe('see the docs');
  });

  it('truncates at a word boundary near the 220-char cap', () => {
    const long = 'word '.repeat(60).trim(); // 60 * 5 - 1 = 299 chars, no sentence terminator
    const out = clampSay(long);
    expect(out.length).toBeLessThanOrEqual(221); // 220 + the ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(/\w+…$/.test(out) || /\s…$/.test(out)).toBe(true);
  });

  it('caps even when there is no whitespace to break on', () => {
    const long = 'x'.repeat(400);
    const out = clampSay(long);
    expect(out.length).toBeLessThanOrEqual(221);
    expect(out.endsWith('…')).toBe(true);
  });

  // Structural backstop (voice-persona P-002): over-cap turns cut at the last
  // COMPLETE SENTENCE that fits — clean speech, no mid-thought ellipsis.
  it('cuts an over-cap multi-sentence say at the last sentence boundary that fits', () => {
    const s1 = 'The auth fix passed review and shipped to the test channel an hour ago.'; // 72 chars
    const s2 = 'Two more items are waiting on you.'; // 34 chars → s1+s2 = 107
    const s3 = 'There is also a long tail of further detail that pushes the whole thing well past the two-hundred-and-twenty character cap for spoken turns, which should be dropped.';
    const out = clampSay(`${s1} ${s2} ${s3}`);
    expect(out).toBe(`${s1} ${s2}`);
    expect(out.endsWith('…')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(220);
  });

  it('falls back to word-boundary + ellipsis when the first sentence alone overruns the cap', () => {
    const runOn = 'this single sentence just keeps going and going with more and more clauses '.repeat(5).trim();
    const out = clampSay(runOn);
    expect(out.length).toBeLessThanOrEqual(221);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to word-boundary when the only sentence boundary is degenerately early', () => {
    // "Yes." (4 chars) is under the minimum sentence cut — keeping only it
    // would drop nearly the whole turn, so the word-boundary path wins.
    const out = clampSay(`Yes. ${'detail '.repeat(40).trim()}`);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeGreaterThan(100);
  });

  it('does not treat a decimal point as a sentence boundary', () => {
    const s1 = 'The build took 3.5 minutes on the runner and finished green just now, all suites included.'; // 91 chars, one real boundary
    const long = `${s1} ${'and then it kept narrating more and more detail '.repeat(4).trim()}`;
    const out = clampSay(long);
    expect(out).toBe(s1);
  });
});

describe('sleepTagToEpochMs (clamped)', () => {
  it('caps the duration at 1 day', () => {
    // parseOperatorTurn applies the clamp, not sleepTagToEpochMs itself.
    // Here we verify the parse + clamp together.
    const r = parseOperatorTurn('<sleep duration_minutes="9999999" reason="x">');
    expect(r.sleep?.durationMinutes).toBe(60 * 24);
  });

  it('preserves a normal short duration', () => {
    const r = parseOperatorTurn('<sleep duration_minutes="15" reason="ok">');
    expect(r.sleep?.durationMinutes).toBe(15);
  });
});

describe('spawn tags', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('parses a full spawn tag including the harness attribute', () => {
    const r = parseOperatorTurn(
      '<say>On it.</say>\n<spawn role="worker" harness="papercup" feature="auth-module" chunk="auth-1" extras="A=1,B=2">',
    );
    expect(r.spawns).toEqual([
      {
        role: 'worker',
        harness: 'papercup',
        featureId: 'auth-module',
        chunkId: 'auth-1',
        extras: ['A=1', 'B=2'],
      },
    ]);
  });

  it('harness defaults to null when the attribute is omitted', () => {
    const r = parseOperatorTurn('<spawn role="validator" feature="F-1">');
    expect(r.spawns).toHaveLength(1);
    expect(r.spawns[0].harness).toBeNull();
    expect(r.spawns[0].role).toBe('validator');
  });

  it('collects multiple spawn tags in one turn', () => {
    const r = parseOperatorTurn(
      '<say>Fanning out.</say>\n' +
        '<spawn role="reviewer" harness="alpha">\n' +
        '<spawn role="reviewer" harness="beta">',
    );
    expect(r.spawns.map((s) => s.harness)).toEqual(['alpha', 'beta']);
  });

  it('drops a spawn tag with no role (warn emitted)', () => {
    const r = parseOperatorTurn('<spawn harness="papercup" feature="F-1">');
    expect(r.spawns).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('accepts single-quoted attributes', () => {
    const r = parseOperatorTurn("<spawn role='scoper' harness='demo'>");
    expect(r.spawns[0]).toMatchObject({ role: 'scoper', harness: 'demo' });
  });

  // ── <report> structured-status tag (structured-report-protocol) ──

  it('parses a <report> alongside a <say>; say stays the clean line', () => {
    const r = parseOperatorTurn(
      '<say>Here is where the fleet stands.</say>\n' +
        '<report>{"title":"Fleet","plans":[' +
        '{"slug":"rate-limit-layer-v2","title":"Rate-limit v2","status":"active",' +
        '"items":[{"id":"P-001","text":"Error classifier","status":"done"},' +
        '{"id":"P-003","text":"Per-call pacing","status":"wip"}]}]}</report>',
    );
    expect(r.say).toBe('Here is where the fleet stands.');
    expect(r.report).not.toBeNull();
    expect(r.report?.title).toBe('Fleet');
    expect(r.report?.plans).toHaveLength(1);
    expect(r.report?.plans[0]).toMatchObject({
      slug: 'rate-limit-layer-v2',
      title: 'Rate-limit v2',
      status: 'active',
    });
    expect(r.report?.plans[0].items).toEqual([
      { id: 'P-001', text: 'Error classifier', status: 'done' },
      { id: 'P-003', text: 'Per-call pacing', status: 'wip' },
    ]);
  });

  it('drops a malformed <report> (invalid JSON) with a warn; say survives', () => {
    const r = parseOperatorTurn('<say>ok</say><report>{not json}</report>');
    expect(r.say).toBe('ok');
    expect(r.report).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped malformed <report>'),
      expect.any(Object),
    );
  });

  it('strips a stray <report> (no <say>) from the prose fallback', () => {
    // Model forgot the <say> wrapper — the report must NOT leak as bubble text.
    const r = parseOperatorTurn(
      '<report>{"plans":[{"title":"P","items":[{"text":"x"}]}]}</report>',
    );
    expect(r.say).toBeNull();
    expect(r.report?.plans[0].title).toBe('P');
  });

  it('report is null when no tag is present', () => {
    expect(parseOperatorTurn('<say>hi</say>').report).toBeNull();
  });
});

describe('parseReportBody', () => {
  it('validates a minimal plan block', () => {
    const r = parseReportBody('{"plans":[{"title":"Alpha"}]}');
    expect(r).toEqual({ plans: [{ title: 'Alpha' }] });
  });

  it('falls back title→slug and item text→id', () => {
    const r = parseReportBody(
      '{"plans":[{"slug":"alpha","items":[{"id":"P-001"}]}]}',
    );
    expect(r?.plans[0].title).toBe('alpha');
    expect(r?.plans[0].slug).toBe('alpha');
    expect(r?.plans[0].items).toEqual([{ id: 'P-001', text: 'P-001', status: undefined }]);
  });

  it('skips plan blocks with no title/slug and items with no text/id', () => {
    const r = parseReportBody(
      '{"plans":[{"status":"active"},{"title":"Keep","items":[{"status":"done"},{"text":"real"}]}]}',
    );
    expect(r?.plans).toHaveLength(1);
    expect(r?.plans[0].title).toBe('Keep');
    expect(r?.plans[0].items).toEqual([{ id: undefined, text: 'real', status: undefined }]);
  });

  it('returns null on invalid JSON, non-object, missing/empty plans', () => {
    expect(parseReportBody('not json')).toBeNull();
    expect(parseReportBody('[]')).toBeNull();
    expect(parseReportBody('42')).toBeNull();
    expect(parseReportBody('{"plans":"nope"}')).toBeNull();
    expect(parseReportBody('{"plans":[]}')).toBeNull();
    expect(parseReportBody('{"plans":[{"status":"active"}]}')).toBeNull();
  });
});
