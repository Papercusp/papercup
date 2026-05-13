'use client';

export function StepWelcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="pc-welcome">
      <h2 className="pc-welcome__hello">Set up Papercusp.</h2>
      <p className="pc-welcome__lead">
        Start with the three things Papercusp needs to build locally: a database, a
        project folder, and one coding agent. Optional accounts, voice, backups,
        and telemetry can wait.
      </p>

      <ul className="pc-welcome__checklist" aria-label="Setup essentials">
        <li>
          <span className="pc-welcome__step">1</span>
          <span>
            <strong>Local database</strong>
            <small>Bundled Postgres</small>
          </span>
        </li>
        <li>
          <span className="pc-welcome__step">2</span>
          <span>
            <strong>Workspace folder</strong>
            <small>Where projects live</small>
          </span>
        </li>
        <li>
          <span className="pc-welcome__step">3</span>
          <span>
            <strong>Coding agent</strong>
            <small>Claude Code or oh-my-pi</small>
          </span>
        </li>
      </ul>

      <div className="pc-welcome__actions">
        <button type="button" className="pc-btn pc-btn--primary pc-btn--large" onClick={onStart}>
          Start setup →
        </button>
        <span className="pc-welcome__action-note">Takes a few minutes. Skip optional steps anytime.</span>
      </div>
    </div>
  );
}
