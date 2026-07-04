import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module (same pattern as the other script tests)
import {
  OPTION_LINE,
  buildQaCommand,
  buildQaPrompt,
  firstIndexOfChapter,
  interpretReply,
  parseArgs,
  resumeIndex,
} from '../tutorial-runner.mjs';

describe('parseArgs', () => {
  it('parses tutorial / operator-url / agent', () => {
    expect(parseArgs(['--tutorial', '--agent=codex', '--operator-url=http://x:3070'])).toEqual({
      tutorial: true,
      agent: 'codex',
      operatorUrl: 'http://x:3070',
    });
  });
  it('defaults to first-run with no agent', () => {
    expect(parseArgs([])).toEqual({ tutorial: false, agent: null, operatorUrl: null });
  });
});

describe('interpretReply — the deterministic navigation (NO LLM decides this)', () => {
  it('1 / empty / continue → continue', () => {
    for (const r of ['1', '', '  ', 'continue', 'CONTINUE', 'next', 'c']) {
      expect(interpretReply(r).kind, r).toBe('continue');
    }
  });
  it('2 / more / details → details', () => {
    for (const r of ['2', 'more', 'Details', 'd']) {
      expect(interpretReply(r).kind, r).toBe('details');
    }
  });
  it('m / menu → menu; f / finish / quit → finish', () => {
    expect(interpretReply('m').kind).toBe('menu');
    expect(interpretReply('menu').kind).toBe('menu');
    for (const r of ['f', 'finish', 'done', 'quit', 'exit']) {
      expect(interpretReply(r).kind, r).toBe('finish');
    }
  });
  it('anything else IS a question, carrying the raw text', () => {
    const q = interpretReply('what is a harness?');
    expect(q.kind).toBe('question');
    expect(q.text).toBe('what is a harness?');
    // A number that isn't 1/2 is still a question, not a mis-fired command.
    expect(interpretReply('3').kind).toBe('question');
  });
  it('the option line advertises exactly the handled commands', () => {
    expect(OPTION_LINE).toContain('[1] Continue');
    expect(OPTION_LINE).toContain('[2] More details');
    expect(OPTION_LINE).toContain('[m] Menu');
    expect(OPTION_LINE).toContain('[f] Finish');
    expect(OPTION_LINE).toContain('type your question');
  });
});

describe('buildQaCommand — one-shot to the installed CLI', () => {
  it('claude/omp use print mode; codex uses exec', () => {
    expect(buildQaCommand('claude', '/abs/claude', 'Q')).toEqual({
      command: '/abs/claude',
      args: ['-p', 'Q'],
    });
    expect(buildQaCommand('codex', '/abs/codex', 'Q')).toEqual({
      command: '/abs/codex',
      args: ['exec', 'Q'],
    });
    expect(buildQaCommand('omp', null, 'Q').args).toEqual(['-p', 'Q']);
  });
  it('falls back to the bare command name when no absolute bin is known', () => {
    expect(buildQaCommand('claude', null, 'Q').command).toBe('claude');
  });
});

describe('buildQaPrompt — grounds the answer in the section', () => {
  const section = {
    title: 'Plans',
    brief: 'A plan is a durable list of items.',
    details: 'Plans live in Postgres and agents work from them.',
    docSlugs: ['system/plans'],
  };
  it('includes the section title, its details, docs, and the question', () => {
    const p = buildQaPrompt(section, 'how do I start one?');
    expect(p).toContain('Section: Plans');
    expect(p).toContain('Plans live in Postgres');
    expect(p).toContain('system/plans');
    expect(p).toContain('User question: how do I start one?');
  });
  it('degrades gracefully with no section', () => {
    expect(buildQaPrompt(null, 'hi')).toContain('User question: hi');
  });
});

describe('resume math', () => {
  const sections = [
    { id: 'ch1-01', chapter: 1 },
    { id: 'ch1-02', chapter: 1 },
    { id: 'ch2-01', chapter: 2 },
  ];
  it('resumeIndex returns the section AFTER the last delivered', () => {
    expect(resumeIndex(sections, { last_section_id: 'ch1-01' })).toBe(1);
    expect(resumeIndex(sections, { last_section_id: 'ch2-01' })).toBe(3); // clamped to end
    expect(resumeIndex(sections, null)).toBe(0);
    expect(resumeIndex(sections, { last_section_id: 'gone' })).toBe(0);
  });
  it('firstIndexOfChapter finds a chapter start', () => {
    expect(firstIndexOfChapter(sections, 2)).toBe(2);
    expect(firstIndexOfChapter(sections, 9)).toBe(-1);
  });
});
