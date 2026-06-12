/**
 * distill.test.ts — lesson distillation (P-022 / FB-08): signature
 * normalization, tolerant response parsing, short-transcript skip. Fake LLM,
 * zero IO.
 */
import { describe, expect, it } from 'vitest';
import type { ReplayTranscript } from '../replay/types';
import {
  buildDistillSystemPrompt,
  distillLessonsFromTranscript,
  lessonSignature,
  parseDistilledLessons,
} from './distill';

describe('lessonSignature', () => {
  it('is whitespace/case-insensitive (one signature per semantic lesson)', () => {
    const a = lessonSignature('Always run  tests\nbefore claiming done.');
    const b = lessonSignature('always run tests before claiming DONE.');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinct lessons get distinct signatures', () => {
    expect(lessonSignature('lesson one')).not.toBe(lessonSignature('lesson two'));
  });
});

describe('parseDistilledLessons', () => {
  it('parses a clean JSON array', () => {
    const out = parseDistilledLessons('[{"title":"T","lesson":"Do X."}]', 3);
    expect(out).toEqual([{ title: 'T', lessonText: 'Do X.' }]);
  });

  it('extracts the array from surrounding prose / fences (tolerant)', () => {
    const out = parseDistilledLessons('Here you go:\n```json\n[{"title":"T","lesson":"L"}]\n```\nDone!', 3);
    expect(out).toHaveLength(1);
  });

  it('caps at maxLessons, skips junk entries, defaults missing titles', () => {
    const out = parseDistilledLessons(
      '[{"lesson":"first"}, 42, {"title":"no lesson field"}, {"lesson":"second"}, {"lesson":"third"}]',
      2,
    );
    expect(out).toEqual([
      { title: 'first', lessonText: 'first' },
      { title: 'second', lessonText: 'second' },
    ]);
  });

  it('returns [] on garbage / non-array / empty responses', () => {
    expect(parseDistilledLessons('no json here', 3)).toEqual([]);
    expect(parseDistilledLessons('{"lesson":"an object, not an array"}', 3)).toEqual([]);
    expect(parseDistilledLessons('[not valid', 3)).toEqual([]);
    expect(parseDistilledLessons('[]', 3)).toEqual([]);
  });
});

function transcript(turnCount: number): ReplayTranscript {
  return {
    ref: '/tmp/fake.jsonl',
    turns: Array.from({ length: turnCount }, (_, index) => ({
      index,
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${index}`,
    })),
  };
}

describe('distillLessonsFromTranscript', () => {
  it('skips transcripts too short to teach anything — zero LLM cost', async () => {
    let calls = 0;
    const out = await distillLessonsFromTranscript(
      transcript(2),
      async () => {
        calls += 1;
        return { text: '[]', costUsd: 1 };
      },
      { maxLessons: 3 },
    );
    expect(out).toEqual({ lessons: [], costUsd: 0 });
    expect(calls).toBe(0);
  });

  it('renders the transcript into the prompt and returns parsed lessons + cost', async () => {
    let seen: { system: string; user: string } | null = null;
    const out = await distillLessonsFromTranscript(
      transcript(6),
      async ({ system, user }) => {
        seen = { system, user };
        return { text: '[{"title":"T","lesson":"L"}]', costUsd: 0.01 };
      },
      { maxLessons: 2 },
    );
    expect(out.lessons).toEqual([{ title: 'T', lessonText: 'L' }]);
    expect(out.costUsd).toBe(0.01);
    expect(seen!.system).toBe(buildDistillSystemPrompt(2));
    expect(seen!.user).toContain('turn 3'); // rendered turns made it into the prompt
    expect(seen!.user).toContain('/tmp/fake.jsonl');
  });
});
