'use client';

import { useId, useState } from 'react';
import { Button } from '@/app/harness/Button';
import { readHostedBrowserApiMarker } from '@/lib/hosted-browser-api';

export function CustomerDataControls() {
  const headingId = useId();
  const [busy, setBusy] = useState<'user' | 'organization' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (!readHostedBrowserApiMarker()) return null;

  const download = async (scope: 'user' | 'organization') => {
    setBusy(scope);
    setMessage(null);
    setFailed(false);
    let url: string | undefined;
    try {
      const response = await fetch(`/api/hosted/browser/data/${scope}/export`, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (!response.ok) {
        throw new Error(response.status === 403
          ? 'You need organization administrator access to download these records.'
          : response.status === 401 ? 'Sign in again to download your data.'
            : 'Your download is unavailable. Please try again.');
      }
      url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `papercusp-${scope}-data.json`;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
      setMessage(scope === 'user' ? 'Your account data download is ready.' : 'Your organization data download is ready.');
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'Your download is unavailable. Please try again.');
    } finally {
      if (url) URL.revokeObjectURL(url);
      setBusy(null);
    }
  };

  return <section className="pc-settings-section" aria-labelledby={headingId}>
    <h2 id={headingId}>Your data</h2>
    <p>Download your account records for this organization. Organization owners and administrators can also download the organization’s records.</p>
    <Button variant="neutral" disabled={busy !== null} onClick={() => void download('user')}>
      {busy === 'user' ? 'Preparing download…' : 'Download my data'}
    </Button>
    <Button variant="neutral" disabled={busy !== null} onClick={() => void download('organization')}>
      {busy === 'organization' ? 'Preparing download…' : 'Download organization data'}
    </Button>
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>;
}
