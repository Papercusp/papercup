'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * <AcceptancePanel> — the harness Tests tab's "Acceptance" (Project) view.
 *
 * P-062 / P-063 of harness-tests-tab-and-tester-promotion-2026-05-26. Lists
 * the VAL assertions (`harness_plan_assertions`) for the harness with their
 * status, and lets a human flip `requires_test` per VAL — turning it off for
 * non-testable claims (copy, design-spec, judgement) so the tester/validator
 * gate skips them. Mounted as the `acceptance` custom tab inside
 * <TestingShell> (the Built-in tier still renders via <DomainTestPanel>).
 *
 * Per-VAL covering-test rollup is Phase G; this view is VALs + status + the
 * requires_test toggle.
 */

interface Assertion {
  val_id: string;
  plan_slug: string;
  item_id: string;
  verify_text: string;
  status: string;
  requires_test: boolean;
}

const STATUS_TONE: Record<string, string> = {
  passed: 'var(--ok, #34d399)',
  failed: 'var(--bad, #f87171)',
  validating: 'var(--accent, #38bdf8)',
  todo: 'var(--fg-mute, #7f9bb4)',
};

const msg: React.CSSProperties = { padding: '16px 20px', color: 'var(--fg-mute, #7f9bb4)', fontSize: 13 };

export default function AcceptancePanel({ slug }: { slug: string }) {
  const base = `/api/harness/${encodeURIComponent(slug)}/testing`;
  const [rows, setRows] = useState<Assertion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetch(`${base}/assertions`)
      .then((r) => (r.ok ? (r.json() as Promise<{ assertions?: Assertion[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setRows(d.assertions ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = useCallback(
    async (a: Assertion) => {
      const next = !a.requires_test;
      setSaving(a.val_id);
      setRows((cur) => cur?.map((x) => (x.val_id === a.val_id ? { ...x, requires_test: next } : x)) ?? cur);
      try {
        const r = await fetch(`${base}/assertions/${encodeURIComponent(a.val_id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requires_test: next }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch {
        // Revert the optimistic flip on failure.
        setRows((cur) => cur?.map((x) => (x.val_id === a.val_id ? { ...x, requires_test: a.requires_test } : x)) ?? cur);
      } finally {
        setSaving(null);
      }
    },
    [base],
  );

  if (error) return <div style={msg}>Could not load acceptance criteria: {error}</div>;
  if (!rows) return <div style={msg}>Loading acceptance criteria…</div>;
  if (rows.length === 0) {
    return (
      <div style={msg}>
        No VAL assertions yet — promote a plan with inline <code>[VAL-…]</code> bullets to populate the
        acceptance contract.
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 20px' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Acceptance criteria</h3>
      <p style={{ margin: '0 0 16px', color: 'var(--fg-mute)', fontSize: 12 }}>
        VAL assertions from this harness's plans. Turn <strong>Requires test</strong> off for non-testable
        claims (copy, design-spec, judgement) — the tester / validator gate skips those.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-mute)', fontSize: 11, textTransform: 'uppercase' }}>
            <th style={{ padding: '6px 8px' }}>VAL</th>
            <th style={{ padding: '6px 8px' }}>Verify</th>
            <th style={{ padding: '6px 8px' }}>Status</th>
            <th style={{ padding: '6px 8px' }}>Requires test</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.val_id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '8px', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>{a.val_id}</td>
              <td style={{ padding: '8px', color: 'var(--fg-dim)' }}>{a.verify_text}</td>
              <td style={{ padding: '8px' }}>
                <span style={{ color: STATUS_TONE[a.status] ?? 'var(--fg-mute)', fontWeight: 700 }}>{a.status}</span>
              </td>
              <td style={{ padding: '8px' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={a.requires_test}
                    disabled={saving === a.val_id}
                    onChange={() => void toggle(a)}
                  />
                  <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>{a.requires_test ? 'required' : 'exempt'}</span>
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
