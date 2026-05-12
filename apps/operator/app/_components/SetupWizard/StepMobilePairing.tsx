'use client';

import RouteLink from '../RouteLink';

export function StepMobilePairing() {
  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Optional. Pair the Papercusp mobile companion to drive your desktop from your phone — start
        runs, voice-chat with the operator, or watch progress while you're away from the keyboard.
      </p>
      <ul className="pc-bullets">
        <li>Install the Papercusp companion app on your phone (iOS or Android).</li>
        <li>Open it; tap <strong>Pair with desktop</strong>.</li>
        <li>Scan the QR code generated on the desktop pairing screen.</li>
      </ul>
      <p>
        <RouteLink href="/settings/mobile" style={{ color: 'var(--accent)' }}>
          Open Settings → Mobile access →
        </RouteLink>
      </p>
      <p className="pc-step__hint">
        Pairing is fully optional. Everything Papercusp does works without the mobile app.
      </p>
    </div>
  );
}
