'use client';

/**
 * Walks a queue of `pendingProvisioning` entries from a snapshot fork.
 * Per plugin: shows a consent dialog (display name, description, allowed
 * hosts, script hash), then on approve POSTs /api/provision/run and
 * mounts <ProvisionStream> for live output. On done (success or failure)
 * advances to the next plugin. When all done, calls onAllDone.
 *
 * Skip semantics: each plugin can be skipped, leaving it un-provisioned.
 * The user can run setup later from the harness's plugin settings.
 *
 * Spec: /docs/snapshots/build-scripts (consent + live-stream UI).
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { ProvisionStream } from './ProvisionStream';
import type { PendingProvisioningEntry } from './ForkCompletionForm';

interface Props {
  /** New harness slug returned by /instantiate. */
  harnessSlug: string;
  /** Queue of plugins with provision.setup declared. */
  queue: PendingProvisioningEntry[];
  /** Called when the queue is exhausted (or skipped). */
  onAllDone?: (summary: { ran: string[]; failed: string[]; skipped: string[] }) => void;
}

type PerPluginStatus = 'pending' | 'awaiting-consent' | 'running' | 'success' | 'failed' | 'skipped';

export function ForkProvisioningProgress({ harnessSlug, queue, onAllDone }: Props) {
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PerPluginStatus>('awaiting-consent');
  const [history, setHistory] = useState<{ plugin: string; outcome: PerPluginStatus }[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<string | undefined>(undefined);

  const current = queue[index];
  const allDone = index >= queue.length;

  function recordAndAdvance(outcome: PerPluginStatus) {
    if (!current) return;
    setHistory((prev) => [...prev, { plugin: current.plugin, outcome }]);
    setStatus('awaiting-consent');
    setRunStartedAt(undefined);
    const next = index + 1;
    setIndex(next);
    if (next >= queue.length) {
      const ran = [...history, { plugin: current.plugin, outcome }]
        .filter((h) => h.outcome === 'success').map((h) => h.plugin);
      const failed = [...history, { plugin: current.plugin, outcome }]
        .filter((h) => h.outcome === 'failed').map((h) => h.plugin);
      const skipped = [...history, { plugin: current.plugin, outcome }]
        .filter((h) => h.outcome === 'skipped').map((h) => h.plugin);
      onAllDone?.({ ran, failed, skipped });
    }
  }

  async function approveAndRun() {
    if (!current) return;
    setStatus('running');
    setRunStartedAt(new Date().toISOString());
    try {
      const r = await fetch('/api/provision/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          harness: harnessSlug,
          plugin: current.plugin,
          phase: 'setup',
          consentConfirmed: true,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) {
        toast.error(`${current.plugin}: ${d.error ?? `HTTP ${r.status}`}`);
        // Don't auto-advance; let user see the failure in the stream.
        // The ProvisionStream's onDone fires on terminal kinds.
      }
    } catch (e: any) {
      toast.error(`run crashed: ${e?.message ?? e}`);
      setStatus('failed');
    }
  }

  function skipCurrent() {
    if (!current) return;
    recordAndAdvance('skipped');
  }

  if (allDone) {
    return (
      <div style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Provisioning complete</h3>
        <ul style={{ paddingLeft: 18 }}>
          {history.map((h, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              <strong>{h.plugin}</strong>{' '}
              <span style={{
                color: h.outcome === 'success' ? '#3fb950'
                  : h.outcome === 'failed' ? '#f85149'
                  : '#8b949e',
              }}>
                {h.outcome}
              </span>
            </li>
          ))}
        </ul>
        <p style={{ color: '#8b949e', marginTop: 16 }}>
          Redirecting to the harness dashboard…
        </p>
      </div>
    );
  }

  if (!current) return null;

  return (
    <div style={{ padding: 16, maxWidth: 920 }}>
      <h3 style={{ marginTop: 0 }}>
        Provisioning {index + 1} / {queue.length}: {current.displayName ?? current.plugin}
      </h3>
      {history.length > 0 && (
        <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 12 }}>
          Done:{' '}
          {history.map((h, i) => (
            <span key={i} style={{ marginRight: 8 }}>
              {h.plugin}{' '}
              <span style={{
                color: h.outcome === 'success' ? '#3fb950'
                  : h.outcome === 'failed' ? '#f85149'
                  : '#8b949e',
              }}>({h.outcome})</span>
            </span>
          ))}
        </div>
      )}

      {status === 'awaiting-consent' && (
        <ConsentCard
          entry={current}
          onApprove={approveAndRun}
          onSkip={skipCurrent}
        />
      )}

      {status === 'running' && (
        <div>
          <ProvisionStream
            harness={harnessSlug}
            plugin={current.plugin}
            since={runStartedAt}
            rows={24}
            onDone={(o) => {
              if (o.kind === 'success') {
                toast.success(`${current.plugin} provisioned`);
                recordAndAdvance('success');
              } else if (o.kind === 'failed') {
                toast.error(`${current.plugin} failed`);
                recordAndAdvance('failed');
              }
            }}
          />
          <button onClick={skipCurrent} style={skipBtnRunning}>
            Skip remaining (mark this plugin as skipped)
          </button>
        </div>
      )}
    </div>
  );
}

function ConsentCard({
  entry,
  onApprove,
  onSkip,
}: {
  entry: PendingProvisioningEntry;
  onApprove: () => void;
  onSkip: () => void;
}) {
  return (
    <div style={consentCard}>
      <div style={{ marginBottom: 12 }}>
        <strong>{entry.plugin}</strong>
        {entry.version && <span style={{ color: '#8b949e', marginLeft: 8 }}>v{entry.version}</span>}
        {entry.publisher && <span style={{ color: '#8b949e', marginLeft: 8 }}>by {entry.publisher}</span>}
      </div>
      {entry.description && (
        <p style={{ marginTop: 0, marginBottom: 12, fontSize: 13 }}>{entry.description}</p>
      )}
      <div style={{ fontSize: 12, color: '#8b949e' }}>
        <div>script: <code>{entry.scriptPath}</code></div>
        {entry.cloudProvider && (
          <div>cloud: {entry.cloudProvider.id}{entry.cloudProvider.region ? ` (${entry.cloudProvider.region})` : ''}</div>
        )}
        {entry.allowedHosts && entry.allowedHosts.length > 0 && (
          <div>outbound: {entry.allowedHosts.join(', ')}</div>
        )}
        {entry.timeoutSec && <div>timeout: {entry.timeoutSec}s</div>}
      </div>
      <p style={{ fontSize: 12, color: '#8b949e', marginTop: 12, marginBottom: 12 }}>
        This script runs in a sandbox with the listed restrictions.
        Stdout, stderr, and recorded resources stream to the audit log.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onApprove} style={approveBtn}>Approve and run</button>
        <button onClick={onSkip} style={skipBtn}>Skip</button>
      </div>
    </div>
  );
}

const consentCard: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: 16,
};
const approveBtn: React.CSSProperties = {
  background: '#238636',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '6px 14px',
  cursor: 'pointer',
  fontSize: 13,
};
const skipBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#c9d1d9',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '6px 14px',
  cursor: 'pointer',
  fontSize: 13,
};
const skipBtnRunning: React.CSSProperties = {
  ...skipBtn,
  marginTop: 8,
  fontSize: 12,
};
