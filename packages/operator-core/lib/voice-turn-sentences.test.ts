/**
 * voice-turn-sentences — the incremental speakable-sentence extractor behind
 * the device voice-turn SSE route (on-desktop-direct-lan-voice-2026-07-14
 * P-001/P-004). Verifies: sentence boundaries across chunk splits, <say>
 * unwrapping, control-tag block dropping (markup is NEVER spoken — D-006),
 * deferred partial tags at the stream tail, literal '<' prose, decimal
 * guards, and flush() semantics.
 */
import { describe, expect, it } from 'vitest';
import { createSentenceExtractor } from './voice-turn-sentences';

function feedAll(chunks: string[]): { sentences: string[]; flushed: string[] } {
  const ex = createSentenceExtractor();
  const sentences: string[] = [];
  for (const c of chunks) sentences.push(...ex.feed(c));
  return { sentences, flushed: ex.flush() };
}

describe('plain prose sentence boundaries', () => {
  it('emits a sentence once the terminator + following whitespace arrive', () => {
    const ex = createSentenceExtractor();
    expect(ex.feed('Hello there')).toEqual([]);
    expect(ex.feed('. ')).toEqual(['Hello there.']);
  });

  it('holds an end-of-buffer period until the next chunk proves it final', () => {
    const ex = createSentenceExtractor();
    // "3." might be "3.5" — no whitespace seen yet, so nothing emits.
    expect(ex.feed('It costs 3.')).toEqual([]);
    expect(ex.feed('5 dollars today. Next')).toEqual(['It costs 3.5 dollars today.']);
    expect(ex.flush()).toEqual(['Next']);
  });

  it('splits on ! and ? and newline', () => {
    const { sentences, flushed } = feedAll(['One! Two? Three\nFour']);
    expect(sentences).toEqual(['One!', 'Two?', 'Three']);
    expect(flushed).toEqual(['Four']);
  });

  it('does not split inside a decimal number', () => {
    const { sentences, flushed } = feedAll(['Pi is 3.14 about. Done']);
    expect(sentences).toEqual(['Pi is 3.14 about.']);
    expect(flushed).toEqual(['Done']);
  });

  it('drops punctuation-only fragments (nothing speakable)', () => {
    const { sentences, flushed } = feedAll(['... \n !! \n']);
    expect(sentences).toEqual([]);
    expect(flushed).toEqual([]);
  });

  it('handles sentences split across many tiny chunks', () => {
    const { sentences } = feedAll(['He', 'llo the', 're. How a', 're you? ']);
    expect(sentences).toEqual(['Hello there.', 'How are you?']);
  });
});

describe('operator tag protocol', () => {
  it('unwraps <say> content — the tag literals are never spoken', () => {
    const { sentences, flushed } = feedAll(['<say>Hi there. All good.</say>']);
    expect(sentences).toEqual(['Hi there.']);
    expect(flushed).toEqual(['All good.']);
  });

  it('drops a <set_mode> block entirely', () => {
    const { sentences, flushed } = feedAll(['Sure thing. <set_mode>passive</set_mode>Done now. ']);
    expect(sentences).toEqual(['Sure thing.', 'Done now.']);
    expect(flushed).toEqual([]);
  });

  it('drops a <report> block spanning multiple chunks', () => {
    const { sentences, flushed } = feedAll([
      'Answer here. <repo',
      'rt>secret machinery ',
      'inside</report> Tail prose',
    ]);
    expect(sentences).toEqual(['Answer here.']);
    expect(flushed).toEqual(['Tail prose']);
  });

  it('drops a self-closing <continue/> tag', () => {
    const { sentences, flushed } = feedAll(['Okay. <continue/>Next part here']);
    expect(sentences).toEqual(['Okay.']);
    expect(flushed).toEqual(['Next part here']);
  });

  it('defers a partial tag at the chunk tail instead of speaking it', () => {
    const ex = createSentenceExtractor();
    expect(ex.feed('Wait for it. <sa')).toEqual(['Wait for it.']);
    expect(ex.feed('y>The answer. </say>')).toEqual(['The answer.']);
  });

  it('drops an unterminated tag/skip block at flush (markup noise, not speech)', () => {
    const ex = createSentenceExtractor();
    expect(ex.feed('Spoken bit. <report>never closed machinery')).toEqual(['Spoken bit.']);
    expect(ex.flush()).toEqual([]);
  });

  it('keeps a lone "<" that is not a tag as literal prose', () => {
    const { sentences } = feedAll(['2 < 5 is true. ']);
    expect(sentences).toEqual(['2 < 5 is true.']);
  });

  it('a tagless turn is fully spoken (parseOperatorTurn fallback parity)', () => {
    const { sentences, flushed } = feedAll(['Bare prose reply with no tags at all. Second bit']);
    expect(sentences).toEqual(['Bare prose reply with no tags at all.']);
    expect(flushed).toEqual(['Second bit']);
  });

  it('drops an unknown tag literal but keeps the prose after it', () => {
    const { flushed } = feedAll(['<thinking>real words here']);
    expect(flushed).toEqual(['real words here']);
  });
});
