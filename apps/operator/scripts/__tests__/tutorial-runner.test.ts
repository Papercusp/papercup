import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module (same pattern as the other script tests)
import {
  OPTION_LINE,
  SHELL_TABS,
  chapterEmoji,
  consumeSse,
  defaultTab,
  firstIndexOfChapter,
  interpretReply,
  nextTab,
  parseArgs,
  renderProgressBar,
  renderTabBar,
  resolveShellKey,
  resumeIndex,
  searchSections,
  sectionChoices,
  setupChecklist,
} from '../tutorial-runner.mjs';

describe('parseArgs', () => {
  it('parses tutorial / operator-url / agent / tab', () => {
    expect(parseArgs(['--tutorial', '--agent=codex', '--operator-url=http://x:3070', '--tab=setup'])).toEqual({
      tutorial: true,
      agent: 'codex',
      operatorUrl: 'http://x:3070',
      tab: 'setup',
    });
  });
  it('defaults to first-run with no agent / no tab', () => {
    expect(parseArgs([])).toEqual({ tutorial: false, agent: null, operatorUrl: null, tab: null });
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

describe('consumeSse — parses the docs-qa SSE stream (WI-2844)', () => {
  // Build a fetch-style body whose getReader() yields the given string parts.
  function bodyOf(...parts) {
    const enc = new TextEncoder();
    let i = 0;
    return {
      getReader() {
        return {
          read() {
            return i < parts.length
              ? Promise.resolve({ done: false, value: enc.encode(parts[i++]) })
              : Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  it('emits (event, JSON-parsed data) per frame', async () => {
    const events = [];
    await consumeSse(
      bodyOf(
        'event: citation\ndata: {"slug":"system/plans","title":"Plans"}\n\n' +
          'event: delta\ndata: {"text":"hi "}\n\nevent: delta\ndata: {"text":"there"}\n\n',
      ),
      (e, d) => events.push([e, d]),
    );
    expect(events).toEqual([
      ['citation', { slug: 'system/plans', title: 'Plans' }],
      ['delta', { text: 'hi ' }],
      ['delta', { text: 'there' }],
    ]);
  });

  it('reassembles a frame split across chunks (needs_backend)', async () => {
    const events = [];
    await consumeSse(bodyOf('event: needs_bac', 'kend\ndata: {"message":"none"}\n\n'), (e, d) =>
      events.push([e, d]),
    );
    expect(events).toEqual([['needs_backend', { message: 'none' }]]);
  });

  it('ignores frames with no data line (heartbeats)', async () => {
    const events = [];
    await consumeSse(bodyOf(': keep-alive\n\nevent: error\ndata: {"message":"boom"}\n\n'), (e, d) =>
      events.push([e, d]),
    );
    expect(events).toEqual([['error', { message: 'boom' }]]);
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

// ── Unified Tutorial|Setup shell (#4 + B2-#1) ──
// chalk may emit color codes in CI; strip them and assert on plain substrings.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('nextTab / defaultTab / SHELL_TABS — the tab model (#4)', () => {
  it('SHELL_TABS lists both tabs, tutorial first', () => {
    expect(SHELL_TABS).toEqual(['tutorial', 'setup']);
  });
  it('nextTab toggles', () => {
    expect(nextTab('tutorial')).toBe('setup');
    expect(nextTab('setup')).toBe('tutorial');
  });
  it('defaultTab: explicit --tab wins, else the tutorial tab', () => {
    expect(defaultTab({ tab: 'setup' })).toBe('setup');
    expect(defaultTab({ tab: 'tutorial' })).toBe('tutorial');
    expect(defaultTab({ tutorial: true })).toBe('tutorial'); // `papercusp tutorial`
    expect(defaultTab({})).toBe('tutorial'); // first-run handoff → the tour
    expect(defaultTab({ tab: 'bogus' })).toBe('tutorial'); // unknown → safe default
  });
});

describe('renderTabBar — the always-visible tab bar + shortcut hints (#4 + B2-#1)', () => {
  it('brackets the ACTIVE tab (owner-chosen mockup) so it reads without color', () => {
    const t = strip(renderTabBar('tutorial'));
    expect(t).toContain('[ Tutorial ]');
    expect(t).not.toContain('[ Setup');
    const s = strip(renderTabBar('setup'));
    expect(s).toContain('[ Setup ]');
    expect(s).not.toContain('[ Tutorial ]');
  });
  it('shows a ✓ on Setup once setup is complete', () => {
    expect(strip(renderTabBar('tutorial', { setupComplete: true }))).toContain('Setup ✓');
    expect(strip(renderTabBar('tutorial', { setupComplete: false }))).not.toContain('Setup ✓');
  });
  it('advertises every global shortcut with an icon hint (B2-#1)', () => {
    const bar = strip(renderTabBar('tutorial'));
    expect(bar).toContain('Tab'); // switch
    expect(bar).toContain('search');
    expect(bar).toContain('chapters');
    expect(bar).toContain('ask');
    expect(bar).toContain('🔍'); // the requested "ctrl+s with a search icon"
  });
});

describe('resolveShellKey — global hotkeys live on every screen (B2-#1)', () => {
  it('Tab → switch tab', () => {
    expect(resolveShellKey({ name: 'tab' })).toBe('tab');
  });
  it('Ctrl+S OR "/" → search (some terminals swallow ^S as XOFF)', () => {
    expect(resolveShellKey({ ctrl: true, name: 's' })).toBe('search');
    expect(resolveShellKey({ sequence: '/' })).toBe('search');
  });
  it('"#" → jump to chapter, "?" → ask a question', () => {
    expect(resolveShellKey({ sequence: '#' })).toBe('jump');
    expect(resolveShellKey({ sequence: '?' })).toBe('ask');
  });
  it('non-shortcut keys (arrows, enter, plain letters) are NOT globals', () => {
    expect(resolveShellKey({ name: 'up' })).toBeNull();
    expect(resolveShellKey({ name: 'down' })).toBeNull();
    expect(resolveShellKey({ name: 'return' })).toBeNull();
    expect(resolveShellKey({ sequence: 'x', name: 'x' })).toBeNull();
    expect(resolveShellKey({ name: 's' })).toBeNull(); // plain 's' (no ctrl) is not search
    expect(resolveShellKey(null)).toBeNull();
  });
});

describe('setupChecklist — the Setup-tab status model (#4)', () => {
  it('a signed-in framework marks framework + signin done; embeddings stays optional until saved', () => {
    const steps = setupChecklist(
      { claudeInstalled: true, claudeSignedIn: true, embeddingsKeyPresent: false },
      { claude: 'Claude Code' },
    );
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.status]));
    expect(byKey).toEqual({ framework: 'done', signin: 'done', embeddings: 'optional' });
    expect(steps.find((s) => s.key === 'framework')!.detail).toContain('Claude Code');
  });
  it('installed-but-not-signed-in → signin is a TODO', () => {
    const steps = setupChecklist({ codexInstalled: true, codexSignedIn: false }, { codex: 'Codex' });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.status]));
    expect(byKey.framework).toBe('done');
    expect(byKey.signin).toBe('todo');
  });
  it('a fresh machine → framework + signin TODO; embeddings saved → done', () => {
    expect(setupChecklist({}, {}).map((s) => s.status)).toEqual(['todo', 'todo', 'optional']);
    const withKey = setupChecklist(
      { claudeInstalled: true, claudeSignedIn: true, embeddingsKeyPresent: true },
      {},
    );
    expect(withKey.find((s) => s.key === 'embeddings')!.status).toBe('done');
  });
  it('degrades gracefully with no snapshot', () => {
    expect(setupChecklist(undefined).map((s) => s.key)).toEqual(['framework', 'signin', 'embeddings']);
  });
});
