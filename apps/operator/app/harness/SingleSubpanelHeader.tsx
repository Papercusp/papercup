'use client';

// Small subpanel header chip (inbox / git) used by the legacy harness
// dashboard's split panes and by ProposalsPanel. Extracted verbatim from
// HarnessDashboard so consumers don't import the 5,259-line monolith just for
// this symbol — the last non-render coupling to it.

import { Inbox, GitBranch } from 'lucide-react';

export function SingleSubpanelHeader({ id, label }: { id: 'inbox' | 'git'; label: string }) {
  const Icon = id === 'inbox' ? Inbox : GitBranch;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2,
      padding: '4px 6px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-2)',
      flexShrink: 0,
    }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: 'var(--fg)',
          background: 'var(--bg-3)',
          border: '1px solid var(--border)',
          borderRadius: 4,
        }}
      >
        <Icon size={12} />
        {label}
      </span>
    </div>
  );
}
