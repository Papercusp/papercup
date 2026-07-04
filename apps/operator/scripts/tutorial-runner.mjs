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
import { createPrompt, isEnterKey, useKeypress, useState } from '@inquirer/core';

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ───────────────────────────────────────────────────────────────────────────

/** Parse argv. Pure. */
export function parseArgs(argv) {
  const out = { tutorial: false, operatorUrl: null, agent: null, tab: null };
  for (const a of argv) {
    if (a === '--tutorial') out.tutorial = true;
    else if (a.startsWith('--operator-url=')) out.operatorUrl = a.slice('--operator-url='.length);
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
    // --tab=setup|tutorial: which tab the unified shell opens on (#4). Bare `papercusp
    // setup` passes --tab=setup; `papercusp tutorial` passes --tutorial (tutorial tab).
    else if (a.startsWith('--tab=')) out.tab = a.slice('--tab='.length);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Unified Tutorial|Setup shell — tab model + global hotkeys (owner batch #4 + B2-#1).
// These are PURE (no chalk) so the tab/keymap/checklist logic is unit-tested.
// ───────────────────────────────────────────────────────────────────────────

/** The two always-visible tabs, in bar order. */
export const SHELL_TABS = ['tutorial', 'setup'];

/** Toggle to the other tab (Tab key). Pure. */
export function nextTab(active) {
  return active === 'tutorial' ? 'setup' : 'tutorial';
}

/**
 * Which tab the shell opens on. An explicit `--tab=` wins; otherwise the tour (the
 * concierge already finished setup at first-run handoff, and `papercusp tutorial`
 * re-entry wants the tour). `papercusp setup` passes `--tab=setup`. Pure.
 */
export function defaultTab(args) {
  if (args?.tab === 'setup' || args?.tab === 'tutorial') return args.tab;
  return 'tutorial';
}

/**
 * Map a raw keypress (readline key object) to a GLOBAL shell action, or null when the
 * key isn't a global shortcut (the screen then handles it locally — arrows/enter).
 * Live on EVERY screen (B2-#1). Pure — tested with synthetic key objects.
 *   Tab           → 'tab'    (switch tab)
 *   Ctrl+S or '/' → 'search' ('/' because some terminals swallow Ctrl+S as XOFF)
 *   '#'           → 'jump'   (jump to a chapter)
 *   '?'           → 'ask'    (ask a question)
 */
export function resolveShellKey(key) {
  if (!key) return null;
  if (key.name === 'tab') return 'tab';
  if (key.ctrl && key.name === 's') return 'search';
  const seq = key.sequence;
  if (seq === '/') return 'search';
  if (seq === '#') return 'jump';
  if (seq === '?') return 'ask';
  return null;
}

/**
 * The Setup-tab checklist derived from the onboarding-status `snapshot` (#4). Pure —
 * returns ordered steps { key, label, status: 'done'|'todo'|'optional', detail }. The
 * Setup tab renders these + offers the incomplete ones as actions. Drives the SAME
 * stage machine the first-run concierge uses (stage-resolver), so the two never drift.
 */
export function setupChecklist(snapshot, labels = {}) {
  const s = snapshot ?? {};
  const installed =
    Boolean(s.claudeInstalled) || Boolean(s.codexInstalled) || Boolean(s.ompInstalled);
  const signedIn =
    (s.claudeInstalled && s.claudeSignedIn) ||
    (s.codexInstalled && s.codexSignedIn) ||
    (s.ompInstalled && s.ompSignedIn);
  const which = s.claudeInstalled
    ? labels.claude ?? 'Claude'
    : s.codexInstalled
      ? labels.codex ?? 'Codex'
      : s.ompInstalled
        ? labels['omp-meridian'] ?? 'OMP'
        : null;
  return [
    {
      key: 'framework',
      label: 'Agent framework',
      status: installed ? 'done' : 'todo',
      detail: which ? `${which} installed` : 'none installed yet',
    },
    {
      key: 'signin',
      label: 'Sign in',
      status: signedIn ? 'done' : installed ? 'todo' : 'todo',
      detail: signedIn ? 'signed in' : 'not signed in',
    },
    {
      key: 'embeddings',
      label: 'Embeddings key',
      status: s.embeddingsKeyPresent ? 'done' : 'optional',
      detail: s.embeddingsKeyPresent ? 'saved' : 'recommended — better search & memory',
    },
  ];
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

/**
 * Build the grounded Q&A prompt for a section. Pure. (B2-#2)
 *
 * Papercusp ships thorough, actively-maintained docs, so the prompt does two
 * things: (1) ATTACHES the current section's own grounding + its linked doc
 * pages, and (2) instructs the agent to answer with our STANDARD doc tooling
 * (docs:search / docs:get) — explicitly NOT forcing the current section, because
 * the user's question may be open-ended or about a completely different area.
 */
export function buildQaPrompt(section, question) {
  const grounding = section
    ? [`Section the user is currently reading: ${section.title}`, section.details || section.brief || '']
        .filter(Boolean)
        .join('\n')
    : '(no specific section context)';
  const docs =
    section?.docSlugs?.length
      ? section.docSlugs.map((d) => `- /internal/docs/${d}`).join('\n')
      : '(no docs are specifically linked to this section)';
  return (
    'You are the Papercusp onboarding tutor answering ONE question a user asked during ' +
    'the guided tutorial.\n\n' +
    `${grounding}\n\n` +
    'Documentation grounding this section:\n' +
    `${docs}\n\n` +
    'Papercusp has thorough, well-maintained documentation. Answer using your standard ' +
    'doc tooling: search with `docs:search` and read pages with `docs:get` (fall back to ' +
    'fetching `/internal/docs/<slug>` if those tools are unavailable). The question MAY be ' +
    'about this section OR about something else entirely — do NOT assume it is about this ' +
    'section: if it is open-ended or off-topic, search the docs for the right page instead ' +
    'of forcing an answer out of the section above.\n\n' +
    'Answer concisely (3–6 sentences), plainly, no preamble; cite pages by their ' +
    '`/internal/docs/<slug>` path.\n\n' +
    `User question: ${question}`
  );
}

/** Human labels for the Q&A backend picker (B2-#3). */
export const AGENT_LABELS = { claude: 'Claude (claude)', codex: 'Codex (codex)', omp: 'OMP (omp)' };

/** Installed Q&A backends — those with a resolved binary path — in preference order. Pure. */
export function installedQaBackends(agentBinaries) {
  return ['claude', 'codex', 'omp'].filter((a) => agentBinaries?.[a]);
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

/**
 * The always-visible tab bar + shortcut hints (owner batch #4 + B2-#1). The active tab
 * is bracketed `[ Tutorial ]` (the owner-chosen mockup) so it reads even without color.
 * Uses chalk (auto-degrades to plain). The `[ … ]` marker is what tests key off.
 */
export function renderTabBar(activeTab, { setupComplete = false } = {}) {
  const label = (name, key) => {
    const text = key === 'setup' && setupComplete ? `${name} ✓` : name;
    return activeTab === key ? accent(bold(`[ ${text} ]`)) : dim(`  ${text}  `);
  };
  const hints = dim('Tab ⇄ switch · ^S 🔍 search · # 📖 chapters · ? 💬 ask');
  return `${label('Tutorial', 'tutorial')} ${label('Setup', 'setup')}    ${hints}`;
}

/** Render the Setup-tab checklist (a status glyph per step). Uses chalk. */
function renderChecklist(steps) {
  const glyph = { done: ok('✓'), todo: accent('○'), optional: dim('◍') };
  return steps
    .map((st) => `  ${glyph[st.status] ?? '·'} ${bold(st.label)} ${dim(`— ${st.detail}`)}`)
    .join('\n');
}

/**
 * The unified-shell SCREEN: a pinned header (tab bar + hints) above an arrow-selectable
 * menu, with the GLOBAL hotkeys (resolveShellKey) live on EVERY screen (#4 + B2-#1).
 * Resolves to an action the shell loop dispatches on:
 *   { key: 'tab' | 'search' | 'jump' | 'ask' }   a global shortcut fired
 *   { key: 'select', value }                      a menu item was chosen (↑/↓ + ⏎)
 * Custom @inquirer/core prompt because the high-level `select` can't intercept Tab/^S.
 */
const shellScreen = createPrompt((config, done) => {
  const choices = config.choices ?? [];
  const [cursor, setCursor] = useState(0);
  useKeypress((key) => {
    const global = resolveShellKey(key);
    if (global) {
      done({ key: global });
      return;
    }
    if (isEnterKey(key)) {
      done({ key: 'select', value: choices[cursor]?.value });
      return;
    }
    if (key.name === 'up') setCursor((c) => (c - 1 + choices.length) % choices.length);
    else if (key.name === 'down') setCursor((c) => (c + 1) % choices.length);
  });
  const menu = choices
    .map((c, i) => `${i === cursor ? accent('❯ ') : '  '}${c.name}`)
    .join('\n');
  return `${config.header}\n\n${menu}`;
});

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

/**
 * Resolve which backend answers a question (B2-#3). Caches the choice for the
 * session (passed back in via `cached`) so we don't re-prompt on every question.
 * Returns null when NO backend is installed → caller routes to setup (B2-#3b).
 */
async function resolveQaBackend(script, prompts, cached) {
  if (cached) return cached;
  const installed = installedQaBackends(script.agentBinaries ?? {});
  if (installed.length === 0) return null;
  if (installed.length === 1) {
    return { agent: installed[0], bin: script.agentBinaries[installed[0]] };
  }
  // More than one installed → let the user choose which answers (B2-#3).
  const { select } = prompts;
  const agent = await select({
    message: 'Which agent should answer your question?',
    choices: installed.map((a) => ({ value: a, name: AGENT_LABELS[a] ?? a })),
  });
  return { agent, bin: script.agentBinaries?.[agent] ?? null };
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
// Setup tab (#4) — the concierge folded into a re-entrant tab. Drives the SAME
// server-side stage machine (GET /desktop/onboarding-status → stage-resolver) and
// pty specs (/desktop/setup-pty-commands) the first-run concierge uses, so the two
// setup surfaces can never drift.
// ───────────────────────────────────────────────────────────────────────────

/** Friendly label for the actionable stage (the Setup tab's "continue" button). */
const SETUP_STEP_LABEL = {
  pick: 'choose & install a framework',
  install: 'install your framework',
  login: 'sign in',
  embeddings: 'add an embeddings key',
};

/** One onboarding-status poll, threading the session's picked framework so the
 *  resolver can advance past pick/login (it returns `pick` for an installed-but-
 *  not-signed-in framework unless `chosen` is set — see stage-resolver). */
async function fetchOnboardingStatus(base, session = {}) {
  const q = new URLSearchParams();
  if (session.chosen) q.set('chosen', session.chosen);
  if (session.forcePick) q.set('forcePick', '1');
  if (session.embeddingsSkipped) q.set('embeddingsSkipped', '1');
  const qs = q.toString();
  return api(base, `/desktop/onboarding-status${qs ? `?${qs}` : ''}`);
}

/** Run ONE setup step for the current stage (reuses the concierge's pty specs).
 *  Mutates `session` (chosen / embeddingsSkipped) so the next poll advances. */
async function runSetupStep(base, status, prompts, session) {
  const { select, confirm, password } = prompts;
  const { stage, labels } = status;
  switch (stage.stage) {
    case 'pick': {
      const detected = new Set(stage.detected ?? []);
      const chosen = await select({
        message: 'Which agent framework do you want to install?',
        choices: (stage.frameworks ?? []).map((f) => ({
          value: f,
          name:
            `${labels[f] ?? f}${detected.has(f) ? dim('  (already installed)') : ''}` +
            (f === 'claude' ? dim('  — recommended, simplest') : ''),
        })),
      });
      session.chosen = chosen;
      const cmds = await api(base, '/desktop/setup-pty-commands');
      const spec = cmds.installFramework?.[chosen];
      if (spec) {
        say(`Installing ${bold(labels[chosen] ?? chosen)} — streaming the installer here.`);
        await runSpec(spec);
      } else {
        say(dim(`No installer for ${labels[chosen] ?? chosen} on this OS — try another framework.`));
        session.chosen = null;
      }
      return;
    }
    case 'install': {
      say(`Installing ${bold(labels[stage.framework] ?? stage.framework)} — streaming the installer here.`);
      const cmds = await api(base, '/desktop/setup-pty-commands');
      const spec = cmds.installFramework?.[stage.framework];
      if (spec) await runSpec(spec);
      else say(dim('No installer available on this OS.'));
      return;
    }
    case 'login': {
      say(`${bold(labels[stage.framework] ?? stage.framework)} is installed — let's sign you in.`);
      const cmds = await api(base, '/desktop/setup-pty-commands');
      const specKey = { claude: 'loginClaude', codex: 'loginCodex', 'omp-meridian': 'loginOmp' }[
        stage.framework
      ];
      if (cmds[specKey]) await runSpec(cmds[specKey]);
      return;
    }
    case 'embeddings': {
      const wants = await confirm({
        message: 'Add an OpenAI embeddings key now? (recommended — better search & memory)',
        default: true,
      });
      if (!wants) {
        session.embeddingsSkipped = true;
        say(dim('Skipped — add it later in Settings or here any time.'));
        return;
      }
      const key = await password({ message: 'Paste your OpenAI API key (hidden):', mask: '*' });
      if (!key?.trim()) {
        session.embeddingsSkipped = true;
        return;
      }
      try {
        await api(base, '/credentials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ openai_api_key: key.trim() }),
        });
        say(ok('Saved. ✓'));
      } catch (e) {
        say(dim(`(couldn't save the key: ${e?.message ?? e})`));
      }
      return;
    }
    default:
      return; // handoff/done — nothing to run
  }
}

/**
 * The Setup tab loop. Renders the checklist + the next actionable step; runs it; re-polls.
 * Returns { switchTo:'tutorial' } on Tab / any tutorial-global key / "go to tutorial",
 * or { exit:true } on Finish.
 */
async function runSetupTab(shell) {
  const { base, prompts, interactive } = shell;
  const st = shell.setup;
  if (!st.entered) {
    st.entered = true;
    say(bold('Setup — finish or adjust your Papercusp setup any time.'));
  }
  for (;;) {
    let status;
    try {
      status = await fetchOnboardingStatus(base, st.session);
    } catch (e) {
      say(dim(`(can't reach the server for setup status: ${e?.message ?? e})`));
      return { switchTo: 'tutorial' };
    }
    const steps = setupChecklist(status.snapshot, status.labels);
    shell.setupComplete = steps.filter((s) => s.key !== 'embeddings').every((s) => s.status === 'done');
    const stageName = status.stage?.stage;
    const actionable = ['pick', 'install', 'login', 'embeddings'].includes(stageName);

    const header =
      renderTabBar('setup', { setupComplete: shell.setupComplete }) +
      '\n\n' +
      renderChecklist(steps) +
      '\n' +
      dim('What next?');

    const choices = [];
    if (actionable) {
      choices.push({ value: 'step', name: accent(`▶ Continue setup — ${SETUP_STEP_LABEL[stageName]}`) });
    } else {
      choices.push({ value: 'tutorial', name: ok('✓ Required setup complete — go to the Tutorial') });
    }
    if (status.optionalSetup?.length) {
      choices.push({ value: 'optional', name: '⚙️  Optional items (git identity, GitHub, …)' });
    }
    choices.push({ value: 'tutorial', name: '📘 Go to the Tutorial tab' });
    choices.push({ value: 'finish', name: '🏁 Finish' });

    let action;
    if (interactive) {
      const r = await shellScreen({ header, choices });
      // Tab or any tutorial-global shortcut on the Setup tab → hop to the Tutorial tab
      // (those actions — search/jump/ask — are section-scoped and live there).
      if (r.key === 'tab' || r.key === 'search' || r.key === 'jump' || r.key === 'ask') {
        return { switchTo: 'tutorial' };
      }
      action = r.value;
    } else {
      action = actionable ? 'step' : 'finish';
    }

    if (action === 'step') {
      await runSetupStep(base, status, prompts, st.session);
      continue;
    }
    if (action === 'optional') {
      await runOptionalSetup(base, status.optionalSetup, prompts);
      continue;
    }
    if (action === 'tutorial') return { switchTo: 'tutorial' };
    if (action === 'finish') {
      await finishUp(base, shell.script, shell.args);
      return { exit: true };
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tutorial tab — the deterministic section walk, now driven by the keypress
// shellScreen so the global shortcuts (search/jump/ask/tab) work on every screen.
// ───────────────────────────────────────────────────────────────────────────

/** Handle ONE tutorial-section screen. Returns { switchTo } / { exit } / {} (stayed). */
async function tutorialSectionAction(shell, s) {
  const { prompts, base, script, sections, interactive } = shell;
  const t = shell.tut;
  let action;
  let typedQuestion = null;
  if (interactive) {
    const header =
      renderTabBar('tutorial', { setupComplete: shell.setupComplete }) + '\n' + dim('What next?');
    const r = await shellScreen({ header, choices: sectionChoices(s) });
    if (r.key === 'tab') return { switchTo: 'setup' };
    if (r.key === 'search') action = 'search';
    else if (r.key === 'jump') action = 'menu';
    else if (r.key === 'ask') action = 'question';
    else action = r.value; // menu select
  } else {
    const reply = interpretReply(await prompts.input({ message: OPTION_LINE }));
    action = reply.kind;
    if (reply.kind === 'question') typedQuestion = reply.text;
  }

  if (action === 'continue') {
    t.completed.add(s.id);
    await saveProgress(base, s.id, [...t.completed]);
    t.idx += 1;
    return {};
  }
  if (action === 'details') {
    say(s.details || dim('(no extra details for this section — ask a question if you like)'));
    return {};
  }
  if (action === 'search') {
    const target = await searchTutorial(script, prompts);
    if (typeof target === 'number' && target >= 0) {
      t.idx = target;
      t.lastChapter = null; // re-print the chapter header on the jump
    }
    return {};
  }
  if (action === 'question') {
    const q = typedQuestion ?? (await prompts.input({ message: '💬 Your question:' }))?.trim();
    if (q) {
      const backend = await resolveQaBackend(script, prompts, shell.qaBackend);
      if (!backend) {
        // B2-#3b: no agent backend installed → REAL auto-route to the Setup tab.
        say(dim('No agent backend is installed yet — taking you to Setup to install one.'));
        return { switchTo: 'setup' };
      }
      shell.qaBackend = backend; // cache the session's choice (B2-#3)
      await answerQuestion(backend.agent, backend.bin, s, q);
    }
    return {};
  }
  if (action === 'menu') {
    const choice = await chapterMenu(script, prompts, false, null);
    if (choice === '__finish') {
      await finishUp(base, script, shell.args);
      return { exit: true };
    }
    t.idx = choice === '__begin' ? 0 : Math.max(0, firstIndexOfChapter(sections, Number(choice)));
    t.lastChapter = null;
    return {};
  }
  if (action === 'finish') {
    await finishUp(base, script, shell.args);
    return { exit: true };
  }
  return {};
}

/** The Tutorial tab loop. Returns { switchTo:'setup' } on Tab, { exit:true } at the end. */
async function runTutorialTab(shell) {
  const { script, sections, prompts, base, args, interactive } = shell;
  const t = shell.tut;
  const totalChapters = script.chapters?.length ?? 0;

  // First entry only: greeting + the resume/chapter menu (re-entry or prior progress).
  if (!t.entered) {
    t.entered = true;
    say(
      args.tutorial
        ? bold('The Papercusp tutorial — welcome back.')
        : bold("You're set up. Here's a quick tour of Papercusp — about 10 minutes."),
    );
    const hasProgress =
      Boolean(script.progress?.last_section_id) && t.idx > 0 && t.idx < sections.length;
    if (args.tutorial || hasProgress) {
      const resumeCh = hasProgress
        ? script.chapters.find((c) => c.number === sections[t.idx].chapter)
        : null;
      const choice = await chapterMenu(
        script,
        prompts,
        hasProgress,
        resumeCh ? `Chapter ${resumeCh.number} — ${resumeCh.title}` : null,
      );
      if (choice === '__finish') {
        await finishUp(base, script, args);
        return { exit: true };
      }
      if (choice === '__begin') t.idx = 0;
      else if (choice === '__resume') {
        /* keep computed idx */
      } else {
        const ci = firstIndexOfChapter(sections, Number(choice));
        t.idx = ci >= 0 ? ci : 0;
      }
    }
  }

  while (t.idx < sections.length) {
    const s = sections[t.idx];
    if (s.chapter !== t.lastChapter) {
      const ch = script.chapters.find((c) => c.number === s.chapter);
      const bar = totalChapters ? dim(`  ${renderProgressBar(s.chapter, totalChapters, 12)}`) : '';
      say(
        accent(bold(`${chapterEmoji(s.chapter)}  Chapter ${s.chapter}${ch ? ` — ${ch.title}` : ''}`)) +
          bar,
      );
      t.lastChapter = s.chapter;
    }
    // Print the Brief VERBATIM once per visit (not re-typed when the user stays on a
    // section for details/search/ask). A jump resets t.shownIdx via idx change.
    if (t.shownIdx !== t.idx) {
      process.stdout.write(`\n${bold(s.title)}\n`);
      await typeOut(s.brief);
      t.shownIdx = t.idx;
    }

    const res = await tutorialSectionAction(shell, s);
    if (res.switchTo) return { switchTo: res.switchTo };
    if (res.exit) return { exit: true };
  }

  // Reached the natural end → the finale, then graduate.
  runFinale(script);
  await finishUp(base, script, args, /* skipFinale */ true);
  return { exit: true };
}

/** The top-level unified-shell loop: run the active tab until it hands control back. */
async function runShell(shell) {
  for (;;) {
    const result =
      shell.activeTab === 'tutorial' ? await runTutorialTab(shell) : await runSetupTab(shell);
    if (result?.exit) return 0;
    if (result?.switchTo) {
      shell.activeTab = result.switchTo;
      continue;
    }
    return 0;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = operatorUrlFrom(args);
  // Kick off the network fetch IMMEDIATELY so it overlaps the dynamic import + the
  // welcome-banner animation below, instead of blocking the user before anything
  // shows (perf #1). Settle-wrap so an early rejection can't trip an unhandled
  // rejection while we're mid-import / mid-animation.
  const scriptResult = fetchScript(base, args.tutorial).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

  const prompts = await import('@inquirer/prompts');
  const interactive = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

  // The banner animates (~0.8s) while the fetch is in flight — the fetch latency is
  // hidden under work we'd do anyway rather than added in front of it.
  await welcomeBanner();

  const settled = await scriptResult;
  if (!settled.ok) {
    const e = settled.error;
    say(
      `I can't reach the Papercusp server at ${base} (${e?.message ?? e}).\n` +
        dim('Make sure the desktop app / server is running, then try again.'),
    );
    return 1;
  }
  const script = settled.value;

  const sections = script.sections ?? [];
  if (!sections.length) {
    say('No tutorial content is installed on this build. ' + dim('Nothing to run.'));
    return 0;
  }
  // The Q&A backend is chosen lazily when the user actually asks a question
  // (resolveQaBackend — B2-#3), not once at startup. Seed the session cache from
  // an explicit --agent (the concierge's chosen framework) so first-run users are
  // not re-prompted; re-entry (`papercusp tutorial`, no --agent) resolves at
  // ask-time: pick when >1 installed, route to setup when none (B2-#3b).
  let qaBackend =
    args.agent && script.agentBinaries?.[args.agent]
      ? { agent: args.agent, bin: script.agentBinaries[args.agent] }
      : null;

  // ── Unified Tutorial | Setup shell (#4) ──
  // Shared, MUTABLE state so a Tab-switch preserves tutorial position + progress
  // across tabs (you resume the same section you left).
  const shell = {
    base,
    args,
    prompts,
    interactive,
    script,
    sections,
    setupComplete: false,
    qaBackend,
    activeTab: defaultTab(args),
    tut: {
      idx: resumeIndex(sections, script.progress),
      completed: new Set(script.progress?.completed_ids ?? []),
      lastChapter: null,
      shownIdx: -1,
      entered: false,
    },
    setup: {
      entered: false,
      // The Setup tab's own concierge session; seed the picked framework from --agent
      // so a first-run handoff doesn't re-ask which framework.
      session: {
        chosen: args.agent === 'omp' ? 'omp-meridian' : args.agent || null,
        forcePick: false,
        embeddingsSkipped: false,
      },
    },
  };

  // Interactive: the full tabbed shell with global hotkeys (Tab / ^S / # / ?).
  // Non-TTY (piped / CI — no raw keypresses): the legacy sequential walk — optional
  // setup then the Tutorial via the typed fallback; the Setup tab is TTY-only.
  if (interactive) return runShell(shell);
  if (!args.tutorial) await runOptionalSetup(base, script.optionalSetup, prompts);
  await runTutorialTab(shell);
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
      ', and re-open this any time from the ' +
      bold('Papercusp Tutorial & Setup') +
      ' icon, or ' +
      bold('papercusp tutorial') +
      ' / ' +
      bold('papercusp setup') +
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
