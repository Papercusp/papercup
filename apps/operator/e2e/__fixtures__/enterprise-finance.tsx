import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
// Relative import keeps this component in the affected fixture spec's import closure.
import { EnterpriseAllocationPanel, type EnterpriseFinanceAccount } from '../../../../packages/operator-ui/src/billing/enterprise-allocations';

const initialAccount: EnterpriseFinanceAccount = {
  controlWorkspaceId: 'finance-browser-control', organizationId: 'finance-org-a',
  userId: 'finance-admin', sessionId: 'finance-session-a',
};

function Fixture() {
  const [account, setAccount] = useState<EnterpriseFinanceAccount | null>(initialAccount);
  const [canManage, setCanManage] = useState(true);
  return <main>
    <p role="note">Controlled browser fixture: billing HTTP responses and account identity are substituted.</p>
    <nav aria-label="Fixture account controls">
      <button onClick={() => setAccount({ ...initialAccount, organizationId: 'finance-org-b', sessionId: 'finance-session-b' })}>Switch to organization B</button>
      <button onClick={() => setCanManage(false)}>Remove billing permission</button>
      <button onClick={() => setAccount(null)}>Sign out</button>
    </nav>
    <EnterpriseAllocationPanel account={account} canManage={canManage} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<NuqsAdapter><Fixture /></NuqsAdapter>);
