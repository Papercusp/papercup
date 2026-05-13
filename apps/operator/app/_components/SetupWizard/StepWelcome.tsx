'use client';

/**
 * Welcome card rendered on first visit to the wizard (no `?step=`
 * query param). Calls `onStart` to advance to the first real step;
 * does not mutate any persisted state.
 */
export function StepWelcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="pc-welcome">
      <h2 className="pc-welcome__hello">Set up Papercusp in a few minutes.</h2>
      <p className="pc-welcome__lead">
        We’ll check the essentials, save where projects live, and make sure at least one coding
        agent can run. Everything else is optional and can be revisited later.
      </p>

      <div className="pc-welcome__panel">
        <h3>Required to start building</h3>
        <ul className="pc-welcome__essentials">
          <li>
            <strong>Local database</strong>
            <span>Wait for bundled Postgres to be ready.</span>
          </li>
          <li>
            <strong>Workspace folder</strong>
            <span>Choose where Papercusp creates projects.</span>
          </li>
          <li>
            <strong>Coding agent</strong>
            <span>Install or detect Claude Code / oh-my-pi.</span>
          </li>
        </ul>
      </div>

      <p className="pc-welcome__fineprint">
        Optional steps cover accounts, API keys, voice, mobile pairing, backups, updates, and
        telemetry. Skip anything you don’t need right now.
      </p>

      <div className="pc-welcome__actions">
        <button type="button" className="pc-btn pc-btn--primary pc-btn--large" onClick={onStart}>
          Start setup →
        </button>
      </div>
    </div>
  );
}
