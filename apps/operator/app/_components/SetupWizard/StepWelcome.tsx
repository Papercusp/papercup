'use client';

import { SETUP_STEPS } from './steps';

/**
 * Welcome card rendered on first visit to the wizard (no `?step=`
 * query param). Sets context for what's about to happen before
 * dumping the user into the OS permissions step.
 *
 * The "Get started" button just navigates to ?step=os-permissions —
 * the wizard's first real step. It does not flip any state.
 */
export function StepWelcome({ onStart }: { onStart: () => void }) {
  const required = SETUP_STEPS.filter((s) => s.required).length;
  const optional = SETUP_STEPS.length - required;

  return (
    <div className="pc-welcome">
      <h2 className="pc-welcome__hello">Welcome to Papercusp.</h2>
      <p className="pc-welcome__lead">
        Papercusp is an autonomous-harness framework — you describe a goal, a coordinated team of
        AI agents plans, builds, verifies, and iterates on it. This wizard gets you set up.
      </p>

      <div className="pc-welcome__grid">
        <div>
          <h3>How long this takes</h3>
          <p>
            About 5–10 minutes. Most steps just verify something Papercusp already detected. A few
            are quick choices (workspace folder, voice device, opt-ins).
          </p>
        </div>
        <div>
          <h3>What you'll go through</h3>
          <p>
            {SETUP_STEPS.length} steps total — {required} required, {optional} optional. The left
            rail tracks your progress. You can revisit any step from Settings later.
          </p>
        </div>
        <div>
          <h3>What's required</h3>
          <p>
            A coding agent (Claude Code or oh-my-pi), a workspace folder, and the local database
            (auto-bootstrapped). Everything else is skippable.
          </p>
        </div>
        <div>
          <h3>Privacy</h3>
          <p>
            Telemetry is <strong>off by default</strong>. You decide whether to share crash reports
            on the last step. Your API keys never leave your machine.
          </p>
        </div>
      </div>

      <div className="pc-welcome__actions">
        <button type="button" className="pc-btn pc-btn--primary pc-btn--large" onClick={onStart}>
          Get started →
        </button>
      </div>
    </div>
  );
}
