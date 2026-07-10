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

// ── <handoff_to_mug> tag (sentinel-herald P-014) ──────────────────
describe('handoff_to_mug tags', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('parses a full handoff tag (summary + harness + feature + tier + urgent + capability)', () => {
    const r = parseOperatorTurn(
      '<say>On it — filing the auth rewrite and flagging the Mug.</say>\n' +
        '<handoff_to_mug summary="rewrite the auth module" harness="papercup" ' +
        'feature="auth-module" tier="high" urgent="true" capability="cup:spawn">',
    );
    expect(r.say).toBe('On it — filing the auth rewrite and flagging the Mug.');
    expect(r.handoffs).toEqual([
      {
        summary: 'rewrite the auth module',
        harness: 'papercup',
        featureId: 'auth-module',
        tier: 'high',
        capability: 'cup:spawn',
        urgent: true,
      },
    ]);
  });

  it('defaults tier to high and urgent to false when omitted (user-asked-work default)', () => {
    const r = parseOperatorTurn('<handoff_to_mug summary="scope out the wiki revamp">');
    expect(r.handoffs).toHaveLength(1);
    expect(r.handoffs[0]).toMatchObject({
      summary: 'scope out the wiki revamp',
      harness: null,
      featureId: null,
      tier: 'high',
      capability: null,
      urgent: false,
    });
  });

  it('accepts tier=low|medium and falls back unknown tier to high', () => {
    expect(parseOperatorTurn('<handoff_to_mug summary="x" tier="low">').handoffs[0].tier).toBe('low');
    expect(parseOperatorTurn('<handoff_to_mug summary="x" tier="medium">').handoffs[0].tier).toBe('medium');
    expect(parseOperatorTurn('<handoff_to_mug summary="x" tier="bogus">').handoffs[0].tier).toBe('high');
  });

  it('parses urgent truthy variants (true/1/yes), everything else false', () => {
    expect(parseOperatorTurn('<handoff_to_mug summary="x" urgent="1">').handoffs[0].urgent).toBe(true);
    expect(parseOperatorTurn('<handoff_to_mug summary="x" urgent="yes">').handoffs[0].urgent).toBe(true);
    expect(parseOperatorTurn('<handoff_to_mug summary="x" urgent="nope">').handoffs[0].urgent).toBe(false);
  });

  it('drops a handoff with no summary (warn emitted)', () => {
    const r = parseOperatorTurn('<handoff_to_mug harness="papercup">');
    expect(r.handoffs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped malformed <handoff_to_mug>'),
      expect.any(Object),
    );
  });

  it('collects multiple handoff tags in one turn (small batch)', () => {
    const r = parseOperatorTurn(
      '<say>Filing both.</say>\n' +
        '<handoff_to_mug summary="first thing" harness="a">\n' +
        '<handoff_to_mug summary="second thing" harness="b">',
    );
    expect(r.handoffs.map((h) => h.summary)).toEqual(['first thing', 'second thing']);
    expect(r.handoffs.map((h) => h.harness)).toEqual(['a', 'b']);
  });

  it('handoffs default to [] when no tag present', () => {
    expect(parseOperatorTurn('<say>just chatting</say>').handoffs).toEqual([]);
  });

  it('strips a stray <handoff_to_mug> (no <say>) from the prose fallback', () => {
    // Model forgot the <say> wrapper — the control tag must NOT leak as bubble text.
    const r = parseOperatorTurn('<handoff_to_mug summary="do the thing">');
    expect(r.say).toBeNull();
    expect(r.handoffs[0].summary).toBe('do the thing');
  });

  // cup-lexicon-full-rename-2026-07-09 P-006 (dual-accept, leader-mandated amendment):
  // a live session may still hold the OLD prompt text in-context for the rest of its
  // lifetime, so the parser must keep accepting `<handoff_to_queen>` too. Drop this
  // coverage once confirmed no old-prompt sessions remain (Slice H / P-010 cleanup).
  describe('legacy <handoff_to_queen> dual-accept', () => {
    it('still parses the old tag literal identically to the new one', () => {
      const r = parseOperatorTurn(
        '<handoff_to_queen summary="rewrite the auth module" harness="papercup" tier="high" urgent="true">',
      );
      expect(r.handoffs).toEqual([
        {
          summary: 'rewrite the auth module',
          harness: 'papercup',
          featureId: null,
          tier: 'high',
          capability: null,
          urgent: true,
        },
      ]);
    });

    it('mixes old and new tags in the same turn', () => {
      const r = parseOperatorTurn(
        '<handoff_to_mug summary="first thing" harness="a">\n' +
          '<handoff_to_queen summary="second thing" harness="b">',
      );
      expect(r.handoffs.map((h) => h.summary)).toEqual(['first thing', 'second thing']);
    });
  });
});

// ── <delegate_deep> tag (voice-unified-sentinel-pipeline-2026-07-01) ────────
describe('delegate_deep tags', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('parses a full delegate_deep tag (summary + brief + harness)', () => {
    const r = parseOperatorTurn(
      '<say>This needs a proper pass.</say>\n' +
        '<delegate_deep summary="compare the migration options" brief="Focus on rollback safety and hidden costs." harness="papercup">',
    );
    expect(r.say).toBe('This needs a proper pass.');
    expect(r.deepDelegations).toEqual([
      {
        summary: 'compare the migration options',
        brief: 'Focus on rollback safety and hidden costs.',
        harness: 'papercup',
      },
    ]);
  });

  it('brief defaults to null when omitted', () => {
    const r = parseOperatorTurn('<delegate_deep summary="why is the CPU spiking?">');
    expect(r.deepDelegations).toEqual([
      {
        summary: 'why is the CPU spiking?',
        brief: null,
        harness: null,
      },
    ]);
  });

  it('drops a delegate_deep tag with no summary (warn emitted)', () => {
    const r = parseOperatorTurn('<delegate_deep brief="ctx">');
    expect(r.deepDelegations).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped malformed <delegate_deep>'),
      expect.any(Object),
    );
  });

  it('collects multiple delegate_deep tags in one turn', () => {
    const r = parseOperatorTurn(
      '<say>I will look at both.</say>\n' +
        '<delegate_deep summary="first question" harness="a">\n' +
        '<delegate_deep summary="second question" harness="b">',
    );
    expect(r.deepDelegations.map((d) => d.summary)).toEqual(['first question', 'second question']);
    expect(r.deepDelegations.map((d) => d.harness)).toEqual(['a', 'b']);
  });

  it('deep delegations default to [] when no tag present', () => {
    expect(parseOperatorTurn('<say>just chatting</say>').deepDelegations).toEqual([]);
  });

  it('strips a stray <delegate_deep> (no <say>) from the prose fallback', () => {
    const r = parseOperatorTurn('<delegate_deep summary="do the analysis">');
    expect(r.say).toBeNull();
    expect(r.deepDelegations[0].summary).toBe('do the analysis');
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
