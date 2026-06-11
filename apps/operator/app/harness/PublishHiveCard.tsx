'use client';

/**
 * PublishHiveCard — one-click "publish the hive" affordance.
 *
 * Extracted from the retired ShareWizard's P-016 hive pointer card
 * (comb-retire-per-harness-sharing-2026-06-11 P-004/P-005). Sharing happens at
 * the HIVE level: publishing lists the hive on the P2P directory (visibility
 * 'public') with all member repos, joinable in one click. Per-harness sharing
 * is retired; surfaces that used to launch the ShareWizard embed this card.
 */

import React, { useState } from 'react';

export interface HivePublishOutcome {
  ok: boolean;
  announced?: boolean;
  error?: string;
}

/** Default publish: POST /api/discovery/set-hive (public visibility). */
async function defaultPublishHive(hiveSlug: string): Promise<HivePublishOutcome> {
  try {
    const res = await fetch('/api/discovery/set-hive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiveId: hiveSlug, title: hiveSlug, visibility: 'public' }),
    });
    const body = (await res.json().catch(() => ({}))) as { announced?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, announced: body.announced };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

export function PublishHiveCard({
  hiveSlug,
  publishHive = defaultPublishHive,
}: {
  hiveSlug: string;
  /** Injection point for tests. Default: POST /api/discovery/set-hive. */
  publishHive?: (hiveSlug: string) => Promise<HivePublishOutcome>;
}) {
  // In-flight/outcome lifecycle — render state, not URL state.
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<HivePublishOutcome | null>(null);

  return (
    <div
      data-testid="publish-hive-card"
      style={{
        border: '1px solid var(--accent, #4a90d9)',
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Share hive <code>{hiveSlug}</code>
      </div>
      <div style={{ color: 'var(--fg-dim)', marginBottom: 10 }}>
        Sharing happens at the hive level — publishing lists the hive on the P2P
        directory with all its member repos, joinable in one click.
      </div>
      {outcome && (
        <div
          data-testid="publish-hive-outcome"
          style={{ marginBottom: 8, color: outcome.ok ? 'var(--success, #4ade80)' : 'var(--error, #e64646)' }}
        >
          {outcome.ok
            ? `Hive published${outcome.announced ? ' + announced to the directory' : ' (announce pending transport)'}.`
            : `Hive publish failed: ${outcome.error ?? 'unknown error'}`}
        </div>
      )}
      <button
        type="button"
        data-testid="publish-hive-button"
        disabled={busy || outcome?.ok === true}
        onClick={() => {
          setBusy(true);
          void publishHive(hiveSlug).then((o) => {
            setBusy(false);
            setOutcome(o);
          });
        }}
        style={{
          padding: '8px 14px',
          background: 'var(--accent, #38bdf8)',
          color: '#0a1424',
          border: 0,
          borderRadius: 5,
          fontSize: 13,
          fontWeight: 600,
          cursor: busy || outcome?.ok === true ? 'default' : 'pointer',
          opacity: busy || outcome?.ok === true ? 0.7 : 1,
        }}
      >
        {busy ? 'Publishing…' : outcome?.ok ? 'Published' : 'Publish the hive'}
      </button>
    </div>
  );
}
