#!/usr/bin/env node
/**
 * tutorial-runner.mjs — the DETERMINISTIC Papercusp tutorial
 * (deterministic-onboarding-tutorial-2026-07-04 P-004/P-005;
 *  tutorial-polish-and-docs-search-2026-07-04 #1/#2/#4).
 *
 * The tutorial used to be 100% agent-driven: an LLM read a prompt + content pack and
 * "figured out" how to print each section, interpret [1]/[2], drive the GUI tabs, and
 * checkpoint. That is wasteful (an inference per section) and non-deterministic (it can
 * paraphrase / reorder / hallucinate). This runner replaces that spine with a SCRIPT:
 *
 *   - It fetches the whole tutorial in ONE call (GET /api/desktop/tutorial-script).
 *   - It prints each section's `## Brief` VERBATIM (with a friendly reveal).
 *   - Each section ends with an ARROW-KEY menu (Continue / More details / Search /
 *     Ask a question / Jump to a chapter / Finish) — like the Claude TUI. No LLM.
 *   - It can SEARCH the whole tutorial (type-to-filter) and jump to any section.
 *   - It checkpoints progress, narrates the finale GUI tour, and graduates — all
 *     deterministically.
 *   - The AGENT is invoked ONLY when the user asks a free-form QUESTION: a single
 *     one-shot call to the CLI they installed (`claude -p` / `codex exec` / …),
 *     grounded in the current section, then control returns to the script.
 *
 * Rendering uses chalk (truecolor, auto-degrades to plain when the terminal has no
 * color / isn't a TTY) plus hand-rolled gradient/typewriter/progress touches and an
 * ora spinner. Every animation is gated on `process.stdout.isTTY` and can be disabled
 * with PAPERCUSP_TUTORIAL_NO_ANIM=1, so piped / CI runs degrade to plain text.
 *
 * Sibling of onboard-launcher.mjs (the setup concierge) — same repo location so
 * `@inquirer/prompts` / chalk / ora resolve from the operator's node_modules, same
 * chat-styled rendering so the whole experience reads as one continuous conversation.
 *
 * Interactive:  papercusp tutorial            (also: node tutorial-runner.mjs --tutorial)
 * First-run:    launched by the concierge at handoff (deterministic tutorial)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ───────────────────────────────────────────────────────────────────────────

/** Parse argv. Pure. */
export function parseArgs(argv) {
  const out = { tutorial: false, operatorUrl: null, agent: null };
  for (const a of argv) {
    if (a === '--tutorial') out.tutorial = true;
    else if (a.startsWith('--operator-url=')) out.operatorUrl = a.slice('--operator-url='.length);
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
  }
  return out;
}

/**
 * Interpret a typed reply to the option line. Deterministic — NO LLM decides this.
 * Retained for the NON-TTY text fallback (when @inquirer's arrow-key select can't run,
 * e.g. a piped/headless stdin) and for tests. The interactive TTY path uses the
 * arrow-key select built from sectionChoices() instead.
 * Anything that isn't a recognized command IS a question for the agent.
 */
export function interpretReply(raw) {
  const t = (raw ?? '').trim();
  const lower = t.toLowerCase();
  if (t === '' || t === '1' || lower === 'continue' || lower === 'next' || lower === 'c') {
    return { kind: 'continue' };
  }
  if (t === '2' || lower === 'more' || lower === 'details' || lower === 'd') {
    return { kind: 'details' };
  }
  if (lower === 's' || lower === 'search') return { kind: 'search' };
  if (lower === 'm' || lower === 'menu') return { kind: 'menu' };
  if (lower === 'f' || lower === 'finish' || lower === 'done' || lower === 'quit' || lower === 'exit') {
    return { kind: 'finish' };
  }
  return { kind: 'question', text: t };
}

/** The one option line the NON-TTY text fallback ends with. */
export const OPTION_LINE =
  '[1] Continue · [2] More details · [s] Search · [m] Menu · [f] Finish · or just type your question';

/** Per-chapter emoji (pure). Falls back to a generic book. */
export const CHAPTER_EMOJI = { 1: '🧭', 2: '🎯', 3: '🐝', 4: '🧠', 5: '🏗️', 6: '🚧' };
export function chapterEmoji(n) {
  return CHAPTER_EMOJI[n] ?? '📘';
}

/**
 * Build the arrow-key menu choices for a section (pure — the interactive #1 menu).
 * "More details" is omitted when the section has none. Emoji + value/name pairs the
 * @inquirer select renders; the runner acts on `value`.
 */
export function sectionChoices(section) {
  const choices = [{ value: 'continue', name: '➡️  Continue' }];
  if (section?.details) choices.push({ value: 'details', name: '📖 More details' });
  choices.push(
    { value: 'search', name: '🔍 Search the tutorial' },
    { value: 'question', name: '💬 Ask a question' },
    { value: 'menu', name: '📚 Jump to a chapter' },
    { value: 'finish', name: '🏁 Finish' },
  );
  return choices;
}

/**
 * Rank tutorial sections against a search query (pure — powers #4). Case-insensitive
 * token match: a title hit weighs 3, a brief hit 1. Empty query → every section (so an
 * empty search box lists everything). Returns [{ idx, section, score }] best-first.
 */
export function searchSections(sections, query) {
  const q = (query ?? '').trim().toLowerCase();
  const list = sections ?? [];
  if (!q) return list.map((section, idx) => ({ idx, section, score: 0 }));
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  list.forEach((section, idx) => {
    const title = (section.title ?? '').toLowerCase();
    const brief = (section.brief ?? '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      if (brief.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ idx, section, score });
  });
  return scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
}

/** Render a text progress bar, e.g. "▓▓▓░░░ 50%". Pure. */
export function renderProgressBar(current, total, width = 12) {
  const t = Math.max(1, total);
  const frac = Math.max(0, Math.min(1, current / t));
  const filled = Math.round(frac * width);
  return `${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))} ${Math.round(frac * 100)}%`;
}

/**
 * Build the one-shot Q&A command for the installed agent CLI. `bin` is the resolved
 * absolute path (from the endpoint's agentBinaries) or null → fall back to the bare
 * command name (works when PATH is set, e.g. a real terminal). Pure.
 */
export function buildQaCommand(agent, bin, prompt) {
  const exe = bin || agent || 'claude';
  if (agent === 'codex') return { command: exe, args: ['exec', prompt] };
  // claude (default) + omp both accept a one-shot print flag; if omp differs the
  // graceful fallback in answerQuestion covers it.
  return { command: exe, args: ['-p', prompt] };
}

/** Build the grounded Q&A prompt for a section. Pure. */
export function buildQaPrompt(section, question) {
  const grounding = section
    ? [
        `Section: ${section.title}`,
        section.details || section.brief || '',
        section.docSlugs && section.docSlugs.length
          ? `Relevant docs: ${section.docSlugs.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '(no specific section context)';
  return (
    'You are the Papercusp onboarding tutor answering ONE question during a guided ' +
    'tutorial. Answer concisely (3–6 sentences), plainly, no preamble. Ground the ' +
    'answer in the section context below; if the question is outside it, say briefly ' +
    'what to check (a /internal/docs slug).\n\n' +
    `${grounding}\n\nUser question: ${question}`
  );
}

/** First section index of a chapter number (or -1). Pure. */
export function firstIndexOfChapter(sections, chapter) {
  return sections.findIndex((s) => s.chapter === chapter);
}

/** Resume index: the section AFTER the last delivered one (or 0). Pure. */
export function resumeIndex(sections, progress) {
  const last = progress?.last_section_id;
  if (!last) return 0;
  const i = sections.findIndex((s) => s.id === last);
  return i >= 0 ? Math.min(i + 1, sections.length) : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering (chalk auto-degrades to plain when !isTTY / NO_COLOR; animations are
// additionally gated on animOn()).
// ───────────────────────────────────────────────────────────────────────────
const dim = (s) => chalk.dim(s);
const bold = (s) => chalk.bold(s);
const accent = (s) => chalk.cyan(s);
const ok = (s) => chalk.green(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Animations on? Only in a real TTY, and never when explicitly disabled. */
function animOn() {
  return Boolean(process.stdout.isTTY) && process.env.PAPERCUSP_TUTORIAL_NO_ANIM !== '1';
}

/** Linear RGB gradient across a string (violet → cyan by default). Pure-ish (uses chalk). */
function gradient(text, from = [139, 92, 246], to = [34, 211, 238]) {
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  return chars
    .map((ch, i) => {
      const r = Math.round(from[0] + (to[0] - from[0]) * (i / n));
      const g = Math.round(from[1] + (to[1] - from[1]) * (i / n));
      const b = Math.round(from[2] + (to[2] - from[2]) * (i / n));
      return chalk.rgb(r, g, b)(ch);
    })
    .join('');
}

function say(msg) {
  process.stdout.write(`\n${msg}\n`);
}

/** Reveal text with a fast, skippable-feeling typewriter. Degrades to a plain write. */
async function typeOut(text, cps = 900) {
  if (!animOn()) {
    process.stdout.write(`${text}\n`);
    return;
  }
  const delay = 1000 / cps;
  for (const ch of text) {
    process.stdout.write(ch);
    if (ch !== '\n' && ch !== ' ') await sleep(delay);
  }
  process.stdout.write('\n');
}

/** One-time animated gradient welcome banner (settles to a static gradient). */
async function welcomeBanner() {
  const title = 'P A P E R C U S P';
  const tagline = 'your multi-agent coding platform';
  if (!animOn()) {
    say(bold(title));
    process.stdout.write(`${dim(tagline)}\n`);
    return;
  }
  process.stdout.write('\n  ');
  // A left→right "shine": one bright position sweeps across the gradient title.
  const chars = [...title];
  for (let pos = 0; pos <= chars.length; pos++) {
    const line = chars
      .map((ch, i) => {
        if (i === pos) return chalk.whiteBright.bold(ch);
        const n = Math.max(1, chars.length - 1);
        const r = Math.round(139 + (34 - 139) * (i / n));
        const g = Math.round(92 + (211 - 92) * (i / n));
        const b = Math.round(246 + (238 - 246) * (i / n));
        return chalk.rgb(r, g, b)(ch);
      })
      .join('');
    process.stdout.write(`\r  ${line}`);
    await sleep(45);
  }
  process.stdout.write(`\r  ${gradient(title)}\n`);
  process.stdout.write(`  ${dim(tagline)}\n`);
}

function operatorUrlFrom(args, env = process.env) {
  return (args.operatorUrl ?? env.PAPERCUSP_OPERATOR_URL ?? 'http://127.0.0.1:3070').replace(
    /\/$/,
    '',
  );
}

async function api(base, path, init) {
  const r = await fetch(`${base}/api${path}`, init);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

// ───────────────────────────────────────────────────────────────────────────
// Server IO
// ───────────────────────────────────────────────────────────────────────────
async function fetchScript(base, tutorial) {
  return api(base, `/desktop/tutorial-script${tutorial ? '?tutorial=1' : ''}`);
}

async function saveProgress(base, lastSectionId, completedIds) {
  try {
    await api(base, '/desktop/setup-wizard-state', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorial_progress: { last_section_id: lastSectionId, completed_ids: completedIds },
      }),
    });
  } catch {
    /* progress is best-effort — a failed checkpoint must never break the tutorial */
  }
}

/** Graduate: stamp finished_at (idempotent — matches setup:complete). First-run only. */
async function graduate(base) {
  try {
    const state = await api(base, '/desktop/setup-wizard-state');
    if (state?.finished_at) return { alreadyFinished: true };
    await api(base, '/desktop/setup-wizard-state', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finished_at: new Date().toISOString() }),
    });
    return { alreadyFinished: false };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

/** Run a SpawnSpec inheriting this terminal (interactive install/login flows). */
function runSpec(spec) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd || process.cwd(),
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Q&A — the ONE place an LLM is invoked, and only for a free-form question.
// ───────────────────────────────────────────────────────────────────────────
async function answerQuestion(agent, bin, section, question) {
  const { command, args } = buildQaCommand(agent, bin, buildQaPrompt(section, question));
  let spinner = null;
  if (animOn()) {
    try {
      const ora = (await import('ora')).default;
      spinner = ora({ text: accent('Asking the agent…'), color: 'cyan' }).start();
    } catch {
      spinner = null;
    }
  }
  if (!spinner) say(dim('Asking the agent…'));
  const answer = await new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish(out.trim() || null);
    }, 90_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      finish(out.trim() || null);
    });
  });
  if (spinner) {
    if (answer) spinner.succeed(accent('Answer'));
    else spinner.stop();
  }
  if (answer) {
    say(answer);
  } else {
    // Graceful fallback — the tutorial NEVER stalls on a failed Q&A.
    const docs = section?.docSlugs?.length
      ? ` For the fuller answer, see ${section.docSlugs.map((d) => `/internal/docs/${d}`).join(' or ')}.`
      : '';
    say(
      `I couldn't reach the agent for a live answer just now.${docs} ` +
        dim('Pick “More details”, or Continue.'),
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Phase A — optional setup (deterministic; the not-ready items are already
// filtered out server-side unless the preview flag is on).
// ───────────────────────────────────────────────────────────────────────────
async function runOptionalSetup(base, items, prompts) {
  const { confirm, input } = prompts;
  if (!items?.length) return;
  const want = await confirm({
    message: 'Want to run through a few optional setup items now? (~2 min — or skip to the tour)',
    default: false,
  });
  if (!want) {
    say(dim('Skipped — you can set these later in Settings.'));
    return;
  }
  for (const item of items) {
    say(`${bold(item.label)} — ${dim(item.why)}`);
    if (item.key === 'git-identity') {
      const doIt = await confirm({ message: 'Set your git name/email now?', default: true });
      if (!doIt) continue;
      const name = await input({ message: 'Git name:' });
      const email = await input({ message: 'Git email:' });
      if (name?.trim() && email?.trim()) {
        try {
          await api(base, '/desktop/git-identity', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), email: email.trim() }),
          });
          say(ok('Saved. ✓'));
        } catch (e) {
          say(dim(`(couldn't save git identity: ${e?.message ?? e} — set it later in Settings)`));
        }
      }
    } else if (item.key === 'github') {
      const doIt = await confirm({ message: 'Sign in to GitHub now?', default: false });
      if (!doIt) continue;
      try {
        const cmds = await api(base, '/desktop/setup-pty-commands');
        if (cmds.loginGithub) await runSpec(cmds.loginGithub);
      } catch (e) {
        say(dim(`(couldn't start GitHub sign-in: ${e?.message ?? e})`));
      }
    } else {
      // Informational items (backups, more API keys, and any preview items when the
      // flag is on) — the runner points, it doesn't half-wire a write.
      say(dim('You can configure this any time in Settings.'));
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Menus + search
// ───────────────────────────────────────────────────────────────────────────
async function chapterMenu(script, prompts, includeResume, resumeChapterTitle) {
  const { select } = prompts;
  const choices = [];
  if (includeResume && resumeChapterTitle) {
    choices.push({ value: '__resume', name: `↩️  Resume where you left off (${resumeChapterTitle})` });
  }
  choices.push({ value: '__begin', name: '⏮️  Start from the beginning' });
  for (const ch of script.chapters) {
    choices.push({ value: String(ch.number), name: `${chapterEmoji(ch.number)} Chapter ${ch.number} — ${ch.title}` });
  }
  choices.push({ value: '__finish', name: '🏁 Finish the tutorial' });
  return select({ message: 'Where would you like to go?', choices });
}

/**
 * Search the whole tutorial (#4) with @inquirer's type-to-filter `search` prompt.
 * Returns the chosen section index, or null if the user backed out.
 */
async function searchTutorial(script, prompts) {
  const { search } = prompts;
  const sections = script.sections ?? [];
  try {
    const idx = await search({
      message: '🔍 Search the tutorial (type to filter):',
      source: async (term) => {
        const hits = searchSections(sections, term ?? '');
        return hits.slice(0, 12).map(({ idx, section }) => ({
          name: `${chapterEmoji(section.chapter)} Ch${section.chapter} — ${section.title}`,
          value: idx,
          description: (section.brief ?? '').split('\n')[0].slice(0, 80),
        }));
      },
    });
    return typeof idx === 'number' ? idx : null;
  } catch (e) {
    if (e?.name === 'ExitPromptError') return null; // Ctrl+C out of search → back to the section
    throw e;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Finale — the GUI walkthrough (narrated deterministically).
// ───────────────────────────────────────────────────────────────────────────
function runFinale(script) {
  say(
    bold('The GUI — your inspection surface') +
      '\n' +
      'Now the last piece is the GUI. While you direct Papercusp from the terminal (like ' +
      'this), the GUI is useful for adjusting settings and for browsing the state and ' +
      'history of the app. Here is a walkthrough of the tabs, left to right — open the ' +
      bold('Papercusp') +
      ' GUI icon to follow along.',
  );
  let n = 1;
  for (const tab of script.guiTabTour ?? []) {
    say(`${bold(`${chapterEmoji(0)} ${n}. ${tab.label}`)} — ${tab.blurb}`);
    n += 1;
  }
  say(
    dim(
      'The strip may show fewer tabs than this — per-project tabs hide on "All Pots", and ' +
        'some are feature-flag-gated. That is expected.',
    ),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = operatorUrlFrom(args);
  const prompts = await import('@inquirer/prompts');
  const { select, input } = prompts;
  const interactive = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

  let script;
  try {
    script = await fetchScript(base, args.tutorial);
  } catch (e) {
    say(
      `I can't reach the Papercusp server at ${base} (${e?.message ?? e}).\n` +
        dim('Make sure the desktop app / server is running, then try again.'),
    );
    return 1;
  }

  const sections = script.sections ?? [];
  if (!sections.length) {
    say('No tutorial content is installed on this build. ' + dim('Nothing to run.'));
    return 0;
  }
  const totalChapters = script.chapters?.length ?? 0;

  const agent =
    args.agent ||
    (script.agentBinaries
      ? ['claude', 'codex', 'omp'].find((a) => script.agentBinaries[a]) || 'claude'
      : 'claude');
  const bin = script.agentBinaries?.[agent] ?? null;

  await welcomeBanner();
  say(
    args.tutorial
      ? bold('The Papercusp tutorial — welcome back.')
      : bold("You're set up. Here's a quick tour of Papercusp — about 10 minutes."),
  );

  // Phase A — optional setup (first-run only; the required steps are already done).
  if (!args.tutorial) {
    await runOptionalSetup(base, script.optionalSetup, prompts);
  }

  // Opening position: resume menu when there's prior progress or in tutorial mode.
  let idx = resumeIndex(sections, script.progress);
  const hasProgress = Boolean(script.progress?.last_section_id) && idx > 0 && idx < sections.length;
  if (args.tutorial || hasProgress) {
    const resumeCh = hasProgress
      ? script.chapters.find((c) => c.number === sections[idx].chapter)
      : null;
    const choice = await chapterMenu(
      script,
      prompts,
      hasProgress,
      resumeCh ? `Chapter ${resumeCh.number} — ${resumeCh.title}` : null,
    );
    if (choice === '__finish') {
      await finishUp(base, script, args);
      return 0;
    }
    if (choice === '__begin') idx = 0;
    else if (choice === '__resume') {
      /* keep computed idx */
    } else {
      const chNum = Number(choice);
      const ci = firstIndexOfChapter(sections, chNum);
      idx = ci >= 0 ? ci : 0;
    }
  }

  const completed = new Set(script.progress?.completed_ids ?? []);
  let lastChapter = null;

  // The deterministic section walk.
  while (idx < sections.length) {
    const s = sections[idx];
    if (s.chapter !== lastChapter) {
      const ch = script.chapters.find((c) => c.number === s.chapter);
      const bar = totalChapters ? dim(`  ${renderProgressBar(s.chapter, totalChapters, 12)}`) : '';
      say(
        accent(bold(`${chapterEmoji(s.chapter)}  Chapter ${s.chapter}${ch ? ` — ${ch.title}` : ''}`)) +
          bar,
      );
      lastChapter = s.chapter;
    }
    // Brief, VERBATIM from the content pack. No LLM. Friendly reveal.
    process.stdout.write(`\n${bold(s.title)}\n`);
    await typeOut(s.brief);

    let advanced = false;
    while (!advanced) {
      // Interactive TTY → arrow-key select (#1). Non-TTY → typed fallback.
      let action;
      let typedQuestion = null;
      if (interactive) {
        action = await select({ message: 'What next?', choices: sectionChoices(s), loop: false });
      } else {
        const reply = interpretReply(await input({ message: OPTION_LINE }));
        action = reply.kind;
        // The typed fallback already carries the question text — don't re-prompt.
        if (reply.kind === 'question') typedQuestion = reply.text;
      }

      if (action === 'continue') {
        completed.add(s.id);
        await saveProgress(base, s.id, [...completed]);
        idx += 1;
        advanced = true;
      } else if (action === 'details') {
        say(s.details || dim('(no extra details for this section — ask a question if you like)'));
      } else if (action === 'search') {
        const target = await searchTutorial(script, prompts);
        if (typeof target === 'number' && target >= 0) {
          idx = target;
          lastChapter = null; // re-print the chapter header on the jump
          advanced = true;
        }
      } else if (action === 'question') {
        const q = typedQuestion ?? (await input({ message: '💬 Your question:' }))?.trim();
        if (q) await answerQuestion(agent, bin, s, q);
      } else if (action === 'menu') {
        const choice = await chapterMenu(script, prompts, false, null);
        if (choice === '__finish') {
          await finishUp(base, script, args);
          return 0;
        }
        idx = choice === '__begin' ? 0 : Math.max(0, firstIndexOfChapter(sections, Number(choice)));
        lastChapter = null;
        advanced = true;
      } else if (action === 'finish') {
        await finishUp(base, script, args);
        return 0;
      }
    }
  }

  // Reached the natural end → the finale, then graduate.
  runFinale(script);
  await finishUp(base, script, args, /* skipFinale */ true);
  return 0;
}

/** Finale (unless already shown) + graduation + close. */
async function finishUp(base, script, args, skipFinale = false) {
  if (!skipFinale) runFinale(script);
  if (!args.tutorial) {
    const res = await graduate(base);
    if (res.error) say(dim(`(couldn't mark onboarding finished: ${res.error} — you can ignore this)`));
  }
  say(
    ok(bold("That's the tour.")) +
      ' Start an agent session any time with ' +
      bold('psu') +
      ', and re-open this tutorial from the ' +
      bold('Papercusp Tutorial') +
      ' icon or ' +
      bold('papercusp tutorial') +
      '.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      if (err?.name === 'ExitPromptError') process.exit(130); // Ctrl+C in a prompt — clean.
      console.error(`[tutorial] ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
