import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { EnterpriseAllocationPanel, type EnterpriseFinanceAccount } from '../../../../packages/operator-ui/src/billing/enterprise-allocations';

function Fixture() {
  const [account, setAccount] = useState<EnterpriseFinanceAccount | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [session, setSession] = useState('admin');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    document.cookie = `test-session=${session}; Path=/; SameSite=Strict`;
    setReady(false);
    void fetch('/api/hosted/billing/subscription', { signal: abort.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('subscription unavailable');
        const data = await response.json();
        if (abort.signal.aborted) return;
        setAccount({ ...data.organization, userId: `fixture-${session}`, sessionId: `fixture-${session}` });
        setCanManage(data.canManage);
        setReady(true);
      }).catch(() => { if (!abort.signal.aborted) { setAccount(null); setReady(true); } });
    return () => abort.abort();
  }, [session]);
  return <main>
    <p role="note">Private PostgreSQL and real billing HTTP; synthetic accounts and amounts.</p>
    <nav aria-label="Fixture account controls">
      <button onClick={() => setSession('other-org')}>Switch to organization B</button>
      <button onClick={() => setSession('member')}>Remove billing permission</button>
    </nav>
    {ready ? <EnterpriseAllocationPanel account={account} canManage={canManage} /> : <p>Loading account…</p>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<NuqsAdapter><Fixture /></NuqsAdapter>);
