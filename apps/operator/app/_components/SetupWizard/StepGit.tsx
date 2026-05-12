'use client';

import { useEffect, useState } from 'react';

interface GitIdentity {
  name?: string;
  email?: string;
  source?: 'global' | 'system' | 'none';
}

export function StepGit() {
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/desktop/git-identity', { cache: 'no-store' });
        if (r.ok) {
          const j = (await r.json()) as GitIdentity;
          setIdentity(j);
        } else {
          setIdentity({ source: 'none' });
        }
      } catch {
        setIdentity({ source: 'none' });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const configured = Boolean(identity?.name && identity?.email);

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Every commit Papercusp makes — on your behalf or via an agent — needs a name and email. We
        read these from your existing <code>git config</code>; nothing to set up if you've used git
        before.
      </p>
      <div className="pc-step__progress" data-status={loading ? 'loading' : configured ? 'ok' : 'missing'}>
        <div className="pc-step__progress-dot" />
        <div className="pc-step__progress-text">
          {loading && <span>Checking…</span>}
          {!loading && configured && (
            <>
              <strong>Ready.</strong>
              <span>
                {identity?.name} &lt;{identity?.email}&gt; (from {identity?.source ?? 'config'})
              </span>
            </>
          )}
          {!loading && !configured && (
            <>
              <strong>Not configured.</strong>
              <span>Run the commands below in a terminal.</span>
            </>
          )}
        </div>
      </div>
      {!configured && !loading && (
        <pre className="pc-code">{`git config --global user.name "Your Name"
git config --global user.email "you@example.com"`}</pre>
      )}
      <p className="pc-step__hint">
        GitHub sign-in (for pushing private repos and opening PRs) is configured separately under{' '}
        <a href="/settings/publishing">Settings → Publishing</a> when you need it.
      </p>
    </div>
  );
}
