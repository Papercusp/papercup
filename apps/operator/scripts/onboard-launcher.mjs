#!/usr/bin/env node
/**
 * onboard-launcher.mjs — the `papercusp onboard` concierge
 * (plan agent-first-onboarding-2026-07-03, P-002).
 *
 * The FIRST thing a new user talks to. Runs full-window in the desktop's
 * Onboarding Console terminal (P-003) — a scripted, chat-styled exchange that
 * works BEFORE any LLM exists: pick an agent framework → guided install →
 * sign-in → (optional) OpenAI embeddings key → then `exec` the chosen agent
 * CLI in this very terminal with the tutor launch-context, so concierge →
 * live agent reads as ONE continuous conversation.
 *
 * All stage logic is SERVER-SIDE (`GET /api/desktop/onboarding-status` → the
 * pure resolver in operator-core/lib/onboarding/stage-resolver.ts). This
 * script only renders chat, runs spawns, and re-polls — which makes the whole
 * flow resumable for free: quit anywhere, relaunch, land in the same stage.
 *
 * Sibling of psu-launcher.mjs on purpose: it lives in the repo so
 * `@inquirer/prompts` resolves from the operator's node_modules, and the
 * handoff (P-005) rides the exact `psu` wrapper machinery psu already proved
 * on all three CLIs.
 *
 * Interactive:  papercusp onboard          (also: node onboard-launcher.mjs)
 * Scripting:    onboard --framework=<claude|codex|omp-meridian> [--operator-url=…]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const FRAMEWORKS = ['claude', 'codex', 'omp-meridian'];

/** Owner-specified intro banner — verbatim (plan D: intro message). */
export const INTRO_BANNER =
  'Welcome to papercusp, the ultimate framework for orchestrating agents and ' +
  'getting real work done with them.  The sky is the limit, so let your ' +
  'imagination loose, come up with impossible ideas, simply describe it to ' +
  'the agents, and watch your creations come to life.  What follows is a ' +
  'brief 10 minute setup procedure and tutorial.';

/** Detection poll cadence — same 5s the GUI wizard's StepAgents uses. */
export const DETECT_POLL_MS = 5_000;

/** The `psu` agent id each framework hands off to. Pure; exported for tests. */
export function mapFrameworkToAgent(framework) {
  return framework === 'omp-meridian' ? 'omp' : framework;
}

/**
 * The handoff argv for `psu`. P-005 threads the tutor launch-context +
 * harness through here; until then this launches a plain tracked su session
 * on the chosen agent. Pure; exported for tests.
 */
export function buildHandoffArgs(framework, env = process.env) {
  const args = ['--no-picker', `--agent=${mapFrameworkToAgent(framework)}`, '--no-plan'];
  if (env.PAPERCUSP_ONBOARD_HARNESS) args.push(`--harness=${env.PAPERCUSP_ONBOARD_HARNESS}`);
  if (env.PAPERCUSP_ONBOARD_LAUNCH_CONTEXT) {
    args.push(`--launch-context=${env.PAPERCUSP_ONBOARD_LAUNCH_CONTEXT}`);
  }
  return args;
}

/** Parse argv (pure; exported for tests). */
export function parseArgs(argv) {
  const out = { framework: null, operatorUrl: null, tutorialOnly: false };
  for (const a of argv) {
    if (a.startsWith('--framework=')) out.framework = a.slice('--framework='.length);
    else if (a.startsWith('--operator-url=')) out.operatorUrl = a.slice('--operator-url='.length);
    else if (a === '--tutorial') out.tutorialOnly = true; // P-014: tutorial-only re-entry
  }
  if (out.framework && !FRAMEWORKS.includes(out.framework)) {
    throw new Error(`unknown --framework=${out.framework} (expected ${FRAMEWORKS.join(' | ')})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chat rendering — the concierge SPEAKS like the agent will, so the handoff
// reads as one conversation. Keep it plain text + light ANSI; no TUI chrome.
// ---------------------------------------------------------------------------
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
function say(msg) {
  process.stdout.write(`\n${msg}\n`);
}

function operatorUrlFrom(args, env = process.env) {
  return (
    args.operatorUrl ?? env.PAPERCUSP_OPERATOR_URL ?? 'http://127.0.0.1:3070'
  ).replace(/\/$/, '');
}

async function api(base, path, init) {
  const r = await fetch(`${base}/api${path}`, init);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

/** One status poll: snapshot + resolved stage, given the session's choices. */
async function fetchStage(base, session) {
  const q = new URLSearchParams();
  if (session.chosen) q.set('chosen', session.chosen);
  if (session.forcePick) q.set('forcePick', '1');
  if (session.embeddingsSkipped) q.set('embeddingsSkipped', '1');
  if (session.tutorial) q.set('tutorial', '1'); // P-014: finished machine → handoff, not done
  const qs = q.toString();
  return api(base, `/desktop/onboarding-status${qs ? `?${qs}` : ''}`);
}

/** Spawn a SpawnSpec inheriting THIS terminal (install/login flows are interactive). */
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = operatorUrlFrom(args);
  const { select, confirm, password } = await import('@inquirer/prompts');

  // The session's choices — the ONLY client-side state; everything else is
  // re-detected server-side each poll (resumable by construction).
  const session = {
    chosen: args.framework,
    forcePick: false,
    embeddingsSkipped: false,
    tutorial: args.tutorialOnly,
  };

  // Tutorial re-entry gets a one-liner, not the first-run setup banner.
  say(
    args.tutorialOnly
      ? bold('Re-opening the Papercusp tutorial — one moment.')
      : bold(INTRO_BANNER),
  );

  let announcedWait = false;
  for (;;) {
    let status;
    try {
      status = await fetchStage(base, session);
    } catch (e) {
      say(
        `I can't reach the Papercusp server at ${base} (${e?.message ?? e}).\n` +
          dim(
            'If the desktop app is still starting, I will keep retrying. ' +
              'You can also run the classic GUI wizard at /setup?force=1.',
          ),
      );
      await sleep(DETECT_POLL_MS);
      continue;
    }
    const { stage, labels } = status;

    switch (stage.stage) {
      case 'done': {
        say(
          'This machine is already set up — onboarding is complete. ' +
            `Start an agent session any time with ${bold('psu')}, or re-run the tutorial ` +
            `via the Papercusp Tutorial icon or ${bold('papercusp tutorial')}.`,
        );
        return 0;
      }

      case 'pick': {
        // The one preconfigured opening question.
        const detected = new Set(stage.detected);
        session.chosen = await select({
          message: 'Which agent framework do you want to use?',
          choices: stage.frameworks.map((f) => ({
            value: f,
            name:
              `${labels[f]}${detected.has(f) ? dim('  (already installed)') : ''}` +
              (f === 'claude' ? dim('  — recommended, simplest') : ''),
            description:
              f === 'claude'
                ? 'Just the claude CLI signed into your Claude subscription.'
                : f === 'codex'
                  ? 'The codex CLI (OpenAI), driven the same way.'
                  : 'The multi-provider path — routes through other providers.',
          })),
        });
        session.forcePick = false;
        break;
      }

      case 'install': {
        // Auto-skip confirmation happens implicitly: resolver only reaches
        // install for the CHOSEN framework.
        say(`Installing ${bold(labels[stage.framework])} — streaming the installer here.`);
        const cmds = await api(base, '/desktop/setup-pty-commands');
        const spec = cmds.installFramework?.[stage.framework];
        if (!spec) {
          say(`No installer available for ${labels[stage.framework]} on this OS — pick another framework.`);
          session.chosen = null;
          session.forcePick = true;
          break;
        }
        const code = await runSpec(spec);
        if (code !== 0) {
          say(
            `The installer exited with code ${code}. ` +
              dim(
                'You can also install manually in another terminal — I re-check every few seconds and move on the moment it appears.',
              ),
          );
          await sleep(DETECT_POLL_MS);
        }
        break; // loop re-resolves: install done → login; not yet → install again
      }

      case 'login': {
        say(`${bold(labels[stage.framework])} is installed — let's sign you in.`);
        const cmds = await api(base, '/desktop/setup-pty-commands');
        const specKey = {
          claude: 'loginClaude',
          codex: 'loginCodex',
          'omp-meridian': 'loginOmp',
        }[stage.framework];
        await runSpec(cmds[specKey]);
        // Not signed in yet (user aborted / flow needs a browser round-trip)?
        // The loop re-resolves; announce the wait once so it isn't spammy.
        if (!announcedWait) {
          announcedWait = true;
          say(dim('Waiting for sign-in to register — I re-check every few seconds.'));
        }
        await sleep(DETECT_POLL_MS);
        break;
      }

      case 'embeddings': {
        say(
          'One more (optional but recommended): an OpenAI API key for ' +
            bold('embeddings') +
            ' — it makes search and agent memory dramatically better.',
        );
        const wants = await confirm({ message: 'Add an OpenAI embeddings key now?', default: true });
        if (!wants) {
          session.embeddingsSkipped = true;
          say(dim('Skipped — you can add it later in Settings or by re-running onboarding.'));
          break;
        }
        const key = await password({ message: 'Paste your OpenAI API key (input hidden):', mask: '*' });
        if (!key?.trim()) {
          session.embeddingsSkipped = true;
          break;
        }
        await api(base, '/credentials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ openai_api_key: key.trim() }),
        });
        say('Saved. ✓');
        break; // re-resolve → handoff
      }

      case 'handoff': {
        // Pre-detection auto-skip lands here without a pick — confirm it.
        // Tutorial re-entry auto-accepts: the user asked for the tutorial,
        // not a framework decision (pass --framework=… to override).
        if (!session.chosen) {
          if (args.tutorialOnly) {
            session.chosen = stage.framework;
          } else {
            const useIt = await confirm({
              message: `Found ${labels[stage.framework]} already installed and signed in — use it?`,
              default: true,
            });
            if (!useIt) {
              session.forcePick = true;
              break;
            }
            session.chosen = stage.framework;
          }
        }
        say(
          args.tutorialOnly
            ? `Re-opening the tutorial — right here in this window.`
            : `You're all set — starting the tutorial now. ` +
                dim("(same window; I'll walk you through it and you can ask questions any time)"),
        );
        // deterministic-onboarding-tutorial-2026-07-04 P-006: the tutorial is now a
        // DETERMINISTIC scripted walkthrough (tutorial-runner.mjs) — it prints the
        // content pack verbatim and only invokes the agent for free-form questions.
        // Fall back to the agentic psu tutor ONLY if the runner script is missing or
        // exits abnormally.
        const runnerPath = fileURLToPath(new URL('./tutorial-runner.mjs', import.meta.url));
        if (existsSync(runnerPath)) {
          const runnerArgs = [
            runnerPath,
            `--agent=${mapFrameworkToAgent(session.chosen)}`,
            `--operator-url=${base}`,
          ];
          if (args.tutorialOnly) runnerArgs.push('--tutorial');
          const rc = await new Promise((resolve) => {
            const child = spawn(process.execPath, runnerArgs, { stdio: 'inherit' });
            child.on('exit', (c) => resolve(c ?? 0));
            child.on('error', () => resolve(-1));
          });
          if (rc === 0 || rc === 130) return rc; // clean exit / Ctrl+C
          say(dim('(the guided tutorial exited early — starting your agent session instead)'));
        }
        // Fallback: the agentic psu tutor (original behavior). Render the tutor
        // launch-context server-side and thread it through the env seam
        // buildHandoffArgs reads. Failure is non-fatal — the session still launches.
        try {
          const lc = await api(
            base,
            `/desktop/onboarding-launch-context?agent=${mapFrameworkToAgent(session.chosen)}` +
              `&mode=${args.tutorialOnly ? 'tutorial' : 'first-run'}`,
          );
          if (lc?.path) process.env.PAPERCUSP_ONBOARD_LAUNCH_CONTEXT = lc.path;
        } catch (e) {
          say(dim(`(couldn't prepare the tutorial brief: ${e?.message ?? e} — launching anyway)`));
        }
        const code = await new Promise((resolve) => {
          const child = spawn('psu', buildHandoffArgs(session.chosen), { stdio: 'inherit' });
          child.on('exit', (c) => resolve(c ?? 0));
          child.on('error', (e) => {
            say(`Couldn't launch the agent session (${e?.message ?? e}). Try running ${bold('psu')} yourself.`);
            resolve(1);
          });
        });
        return code;
      }

      default: {
        say(dim(`Unknown stage ${JSON.stringify(stage)} — re-checking…`));
        await sleep(DETECT_POLL_MS);
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      // ExitPromptError = user hit Ctrl+C in a prompt — a clean, resumable exit.
      if (err?.name === 'ExitPromptError') process.exit(130);
      console.error(`[onboard] ${err?.stack ?? err}`);
      console.error('[onboard] Fallback: the classic GUI wizard is at /setup?force=1');
      process.exit(1);
    },
  );
}
