import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module (same pattern as the other script tests)
import {
  OPTION_LINE,
  buildQaCommand,
  buildQaPrompt,
  chapterEmoji,
  firstIndexOfChapter,
  installedQaBackends,
  interpretReply,
  parseArgs,
  renderProgressBar,
  resumeIndex,
  searchSections,
  sectionChoices,
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
  it('includes the section title, its details, its docs, and the question', () => {
    const p = buildQaPrompt(section, 'how do I start one?');
    expect(p).toContain('Plans'); // section title
    expect(p).toContain('Plans live in Postgres'); // section details
    expect(p).toContain('/internal/docs/system/plans'); // linked docs, as a path
    expect(p).toContain('User question: how do I start one?');
  });
  it('instructs the agent to use our doc tooling and NOT force the section (B2-#2)', () => {
    const p = buildQaPrompt(section, 'how do I start one?');
    expect(p).toContain('docs:search');
    expect(p).toContain('docs:get');
    expect(p).toMatch(/do NOT assume it is about this section|something else entirely/);
  });
  it('degrades gracefully with no section', () => {
    expect(buildQaPrompt(null, 'hi')).toContain('User question: hi');
  });
});

describe('installedQaBackends — which agents can answer (B2-#3)', () => {
  it('returns only backends with a resolved path, in preference order', () => {
    expect(installedQaBackends({ claude: '/u/claude', codex: null, omp: '/u/omp', pi: '/u/pi' })).toEqual([
      'claude',
      'omp',
    ]);
  });
  it('is empty when nothing is installed (caller routes to setup — B2-#3b)', () => {
    expect(installedQaBackends({ claude: null, codex: null, omp: null, pi: null })).toEqual([]);
    expect(installedQaBackends({})).toEqual([]);
    expect(installedQaBackends(undefined)).toEqual([]);
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

describe('interpretReply — search command (non-TTY fallback)', () => {
  it('s / search → search', () => {
    expect(interpretReply('s').kind).toBe('search');
    expect(interpretReply('SEARCH').kind).toBe('search');
  });
});

describe('sectionChoices — the arrow-key section menu (#1)', () => {
  it('always offers continue first, then search/question/menu/finish', () => {
    const values = sectionChoices({ title: 'X', brief: 'b', details: null }).map((c) => c.value);
    expect(values[0]).toBe('continue');
    expect(values).toEqual(['continue', 'search', 'question', 'menu', 'finish']);
  });
  it('includes "details" only when the section has details', () => {
    const withD = sectionChoices({ details: 'more' }).map((c) => c.value);
    expect(withD).toContain('details');
    const noD = sectionChoices({ details: null }).map((c) => c.value);
    expect(noD).not.toContain('details');
  });
});

describe('searchSections — tutorial search ranking (#4)', () => {
  const sections = [
    { title: 'Plans', brief: 'a durable list of work items', chapter: 2 },
    { title: 'Work items', brief: 'the unit of work an agent claims', chapter: 2 },
    { title: 'Loops', brief: 'keep an agent working on a plan', chapter: 2 },
  ];
  it('ranks a title hit above a brief-only hit', () => {
    const hits = searchSections(sections, 'plan');
    // "Plans" (title) must rank above "Loops" (brief mentions 'plan')
    expect(hits[0].section.title).toBe('Plans');
    expect(hits.map((h) => h.section.title)).toContain('Loops');
  });
  it('empty query returns every section (idx preserved)', () => {
    const hits = searchSections(sections, '');
    expect(hits).toHaveLength(3);
    expect(hits[0].idx).toBe(0);
  });
  it('no match returns empty', () => {
    expect(searchSections(sections, 'zzzznomatch')).toEqual([]);
  });
});

describe('renderProgressBar', () => {
  it('renders proportional fill + percent', () => {
    expect(renderProgressBar(0, 6, 6)).toBe('░░░░░░ 0%');
    expect(renderProgressBar(3, 6, 6)).toBe('▓▓▓░░░ 50%');
    expect(renderProgressBar(6, 6, 6)).toBe('▓▓▓▓▓▓ 100%');
  });
  it('clamps out-of-range + guards total=0', () => {
    expect(renderProgressBar(9, 6, 6)).toBe('▓▓▓▓▓▓ 100%');
    expect(renderProgressBar(1, 0, 6)).toBe('▓▓▓▓▓▓ 100%');
  });
});

describe('chapterEmoji', () => {
  it('maps known chapters and falls back for unknown', () => {
    expect(chapterEmoji(1)).toBe('🧭');
    expect(chapterEmoji(3)).toBe('🐝');
    expect(chapterEmoji(99)).toBe('📘');
  });
});
