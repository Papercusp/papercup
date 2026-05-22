'use client';

import { useEffect, useState } from 'react';
import RouteLink from '../RouteLink';

interface QrPayload {
  server: string;
  pairToken: string;
  workspaceId: string;
}

interface MintResp {
  qrPayload: QrPayload;
  expiresAt: number;
}

export function StepMobilePairing() {
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/device/desktop/mint-pair-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'default' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as MintResp;
      setQr(j.qrPayload);
      setExpiresAt(j.expiresAt);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const expired = qr && now > expiresAt;
  const remainingSec = qr && !expired ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0;

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Optional. Pair the Papercusp companion app to drive your desktop from your phone — start
        runs, voice-chat with the operator, or watch progress while you're away from the keyboard.
      </p>

      {!qr && (
        <>
          <ol className="pc-bullets">
            <li>Install the Papercusp companion app on your phone (iOS or Android).</li>
            <li>Open it; tap <strong>Pair with desktop</strong>.</li>
            <li>Click below to generate a QR code, then scan it.</li>
          </ol>
          <div className="pc-step__actions">
            <button
              type="button"
              className="pc-btn pc-btn--primary"
              onClick={() => void mint()}
              disabled={busy}
            >
              {busy ? 'Generating…' : 'Generate pairing QR code'}
            </button>
          </div>
        </>
      )}

      {qr && (
        <>
          <div className="pc-qr">
            <img
              src={`/api/device/qr.svg?payload=${encodeURIComponent(JSON.stringify(qr))}`}
              alt="Pairing QR code"
              className="pc-qr__img"
            />
            <div className="pc-qr__caption">
              {expired ? (
                <>
                  <strong>Expired.</strong>{' '}
                  <button type="button" className="pc-link-btn" onClick={() => void mint()}>
                    Generate a new one
                  </button>
                </>
              ) : (
                <>
                  <strong>Scan from the companion app.</strong>{' '}
                  Expires in <code>{remainingSec}s</code>.
                </>
              )}
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="pc-step__progress" data-status="error">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Couldn't generate.</strong>
            <span>{error}</span>
          </div>
        </div>
      )}

      <p className="pc-step__hint">
        Manage paired devices later in{' '}
        <RouteLink href="/settings/mobile" style={{ color: 'var(--accent)' }}>
          Settings → Mobile access
        </RouteLink>
        . Pairing is fully optional; everything works without the mobile app.
      </p>
    </div>
  );
}
