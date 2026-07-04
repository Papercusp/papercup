#!/usr/bin/env node
/**
 * tutorial-runner.mjs — the DETERMINISTIC Papercusp tutorial
 * (deterministic-onboarding-tutorial-2026-07-04 P-004/P-005).
 *
 * The tutorial used to be 100% agent-driven: an LLM read a prompt + content pack and
 * "figured out" how to print each section, interpret [1]/[2], drive the GUI tabs, and
 * checkpoint. That is wasteful (an inference per section) and non-deterministic (it can
 * paraphrase / reorder / hallucinate). This runner replaces that spine with a SCRIPT:
 *
 *   - It fetches the whole tutorial in ONE call (GET /api/desktop/tutorial-script).
 *   - It prints each section's `## Brief` VERBATIM and the option line.
 *   - It handles [1] Continue / [2] More details / [m] Menu / [f] Finish with NO LLM.
 *   - It checkpoints progress, narrates the finale GUI tour, and graduates — all
 *     deterministically.
 *   - The AGENT is invoked ONLY when the user types a free-form QUESTION: a single
 *     one-shot call to the CLI they installed (`claude -p` / `codex exec` / …),
 *     grounded in the current section, then control returns to the script.
 *
 * Sibling of onboard-launcher.mjs (the setup concierge) — same repo location so
 * `@inquirer/prompts` resolves from the operator's node_modules, same chat-styled
 * rendering so the whole experience reads as one continuous conversation.
 *
 * Interactive:  papercusp tutorial            (also: node tutorial-runner.mjs --tutorial)
 * First-run:    launched by the concierge at handoff (deterministic tutorial)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
 * Interpret a reply to the option line. Deterministic — NO LLM decides this.
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
  if (lower === 'm' || lower === 'menu') return { kind: 'menu' };
  if (lower === 'f' || lower === 'finish' || lower === 'done' || lower === 'quit' || lower === 'exit') {
    return { kind: 'finish' };
  }
  return { kind: 'question', text: t };
}

/** The one option line every section ends with. */
export const OPTION_LINE =
  '[1] Continue · [2] More details · [m] Menu · [f] Finish · or just type your question';

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
// Rendering
// ───────────────────────────────────────────────────────────────────────────
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
function say(msg) {
  process.stdout.write(`\n${msg}\n`);
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
  say(dim('Asking the agent…'));
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
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out.trim() || null : out.trim() || null);
    });
  });
  if (answer) {
    say(answer);
  } else {
    // Graceful fallback — the tutorial NEVER stalls on a failed Q&A.
    const docs = section?.docSlugs?.length
      ? ` For the fuller answer, see ${section.docSlugs.map((d) => `/internal/docs/${d}`).join(' or ')}.`
      : '';
    say(
      `I couldn't reach the agent for a live answer just now.${docs} ` +
        dim('Type [2] for this section\'s details, or [1] to continue.'),
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
          say('Saved. ✓');
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
// Menus
// ───────────────────────────────────────────────────────────────────────────
async function chapterMenu(script, prompts, includeResume, resumeChapterTitle) {
  const { select } = prompts;
  const choices = [];
  if (includeResume && resumeChapterTitle) {
    choices.push({ value: '__resume', name: `Resume where you left off (${resumeChapterTitle})` });
  }
  choices.push({ value: '__begin', name: 'Start from the beginning' });
  for (const ch of script.chapters) {
    choices.push({ value: String(ch.number), name: `Chapter ${ch.number} — ${ch.title}` });
  }
  choices.push({ value: '__finish', name: 'Finish the tutorial' });
  return select({ message: 'Where would you like to go?', choices });
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
    say(`${bold(`${n}. ${tab.label}`)} — ${tab.blurb}`);
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
  const { input } = prompts;

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

  const agent =
    args.agent ||
    (script.agentBinaries
      ? ['claude', 'codex', 'omp'].find((a) => script.agentBinaries[a]) || 'claude'
      : 'claude');
  const bin = script.agentBinaries?.[agent] ?? null;

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
      say(bold(`── Chapter ${s.chapter}${ch ? ` — ${ch.title}` : ''} ──`));
      lastChapter = s.chapter;
    }
    // Brief, VERBATIM from the content pack. No LLM.
    say(`${bold(s.title)}\n${s.brief}`);

    let advanced = false;
    while (!advanced) {
      const reply = interpretReply(await input({ message: OPTION_LINE }));
      if (reply.kind === 'continue') {
        completed.add(s.id);
        await saveProgress(base, s.id, [...completed]);
        idx += 1;
        advanced = true;
      } else if (reply.kind === 'details') {
        say(s.details || dim('(no extra details for this section — ask a question if you like)'));
      } else if (reply.kind === 'question') {
        await answerQuestion(agent, bin, s, reply.text);
      } else if (reply.kind === 'menu') {
        const choice = await chapterMenu(script, prompts, false, null);
        if (choice === '__finish') {
          await finishUp(base, script, args);
          return 0;
        }
        idx = choice === '__begin' ? 0 : Math.max(0, firstIndexOfChapter(sections, Number(choice)));
        advanced = true;
      } else if (reply.kind === 'finish') {
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
    bold("That's the tour.") +
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
