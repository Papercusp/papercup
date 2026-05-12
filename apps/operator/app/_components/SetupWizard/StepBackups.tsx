'use client';

import RouteLink from '../RouteLink';

export function StepBackups() {
  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp uses <strong>Kopia</strong> to take local snapshots of your projects.{' '}
        <strong>Agents shouldn't delete git history</strong> — but if one ever does, this is a layer
        they can't touch. <strong>Enabled by default.</strong>
      </p>
      <ul className="pc-bullets">
        <li>Snapshots run before destructive agent operations and after each harness run.</li>
        <li>Restore from any snapshot via the Backups settings page.</li>
        <li>Storage is local-only by default; no cloud upload unless you configure one.</li>
      </ul>
      <p>
        <RouteLink href="/settings/backups" style={{ color: 'var(--accent)' }}>
          Open Settings → Backups →
        </RouteLink>
      </p>
      <p className="pc-step__hint">
        Default retention keeps 200 latest + 48 hourly + 30 daily + 12 weekly + 12 monthly
        snapshots. Adjust in the Backups settings page.
      </p>
    </div>
  );
}
