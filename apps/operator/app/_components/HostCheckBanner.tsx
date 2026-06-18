/**
 * One-time shared-host acknowledgement banner.
 *
 * Fires `GET /api/provision/host-check` on first mount; if the response
 * is `{ decision: 'gate' }`, surfaces a sticky banner asking the user to
 * acknowledge before any provision script can run. Once acknowledged
 * (`POST /api/provision/host-check { acknowledge: true }`), the banner
 * vanishes for the lifetime of the host signature.
 *
 * Spec: /docs/snapshots/build-scripts#single-user-host-detection.
 */
'use client';

import { useEffect, useState } from 'react';

interface HostCheckResult {
  decision: 'allow' | 'allow-acked' | 'gate';
  signals: { activeUsers: string[]; configuredUsers: string[]; isShared: boolean };
}

export function HostCheckBanner() {
  const [result, setResult] = useState<HostCheckResult | null>(null);
  const [acking, setAcking] = useState(false);

  useEffect(() => {
    fetch('/api/provision/host-check', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d?.ok && setResult(d))
      .catch(() => { /* endpoint may not be available — silent */ });
  }, []);

  if (!result || result.decision !== 'gate') return null;

  async function acknowledge() {
    setAcking(true);
    try {
      const r = await fetch('/api/provision/host-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledge: true }),
      });
      if (r.ok) setResult({ ...result!, decision: 'allow-acked' });
    } finally {
      setAcking(false);
    }
  }

  const userCount = Math.max(result.signals.activeUsers.length, result.signals.configuredUsers.length);

  return (
    <div role="alert" style={banner}>
      <div style={{ flex: 1 }}>
        <strong>Shared host detected.</strong>{' '}
        Papercusp V1 is designed for single-user dev/desktop. This host appears to have{' '}
        <strong>{userCount} users</strong>{' '}
        ({result.signals.activeUsers.length} active, {result.signals.configuredUsers.length} configured).
        Provisioning scripts can still run, but you should be aware of cross-user side effects.
      </div>
      <button onClick={acknowledge} disabled={acking} style={btn}>
        {acking ? 'Saving…' : 'I understand'}
      </button>
    </div>
  );
}

const banner: React.CSSProperties = {
  position: 'fixed', top: 56, left: 0, right: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', gap: 16,
  padding: '10px 16px', fontSize: 13,
  background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn-border)',
  color: 'var(--warn)',
};
const btn: React.CSSProperties = {
  padding: '6px 14px', background: 'var(--warn)', color: 'var(--accent-ink)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
};
