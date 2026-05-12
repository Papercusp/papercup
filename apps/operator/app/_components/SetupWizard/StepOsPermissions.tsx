'use client';

interface Perm {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly platforms: ReadonlyArray<'mac' | 'linux' | 'windows'>;
}

const PERMS: readonly Perm[] = [
  {
    id: 'microphone',
    title: 'Microphone',
    why: 'Required for any voice mode (continuous, hybrid, or single-utterance). Skip if you don\'t plan to use voice.',
    platforms: ['mac', 'linux', 'windows'],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    why: 'Lets Papercusp alert you when an agent run finishes, hits an error, or needs your input.',
    platforms: ['mac', 'linux', 'windows'],
  },
  {
    id: 'accessibility',
    title: 'Accessibility (macOS only)',
    why: 'Required if you want global keyboard shortcuts to work outside the app window.',
    platforms: ['mac'],
  },
];

export function StepOsPermissions() {
  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp requests these from your operating system on first use. You can skip any of them
        and grant them later from your system settings.
      </p>
      <div className="pc-perm-list">
        {PERMS.map((p) => (
          <div key={p.id} className="pc-perm">
            <div className="pc-perm__head">
              <span className="pc-perm__title">{p.title}</span>
              <span className="pc-perm__platforms">{p.platforms.join(' · ')}</span>
            </div>
            <p className="pc-perm__why">{p.why}</p>
          </div>
        ))}
      </div>
      <p className="pc-step__hint">
        Detection of granted state happens automatically the next time the relevant feature is used —
        we don't probe these from this screen.
      </p>
    </div>
  );
}
