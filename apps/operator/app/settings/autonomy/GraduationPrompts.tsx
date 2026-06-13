'use client';

/**
 * The inline graduation-eligible prompts (queen-autonomy-policy-2026-06-13 P-032 /
 * B-16 P-082) — where the owner RATIFIES a category earning a higher graduated
 * level. Reads the live `autonomy.graduation` sync query (per-category targets the
 * tripwire evidence has earned vs the current level); each eligible target offers a
 * one-click ratify that writes `graduatedLevel` via the same loopback
 * autonomy-policy-set route the main table uses.
 *
 * Owner-authority, NEVER an auto edit (honors frontier's chat-is-not-a-decision-rail
 * ruling): the engine only PROPOSES (computes the earned target); the raise happens
 * only when the owner clicks. Ratifying raises earned trust WITHIN the ceiling — it
 * never raises the ceiling itself. Empty until autonomy is armed + a category
 * accrues clean auto-passes; self-contained so the B-15 page drops it in.
 */
import { useState, type CSSProperties } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import { CEILING_SHORT_LABEL, type Ceiling } from './CeilingSlider';

/* Wire type — mirrors CategoryGraduationTarget (operator-core/lib/autonomy/tripwire/
 * graduation.ts) decorated with the category label, kept local per the client
 * wire-type decoupling convention. */
interface GraduationTarget {
  category: string;
  label: string;
  targetGraduatedLevel: Ceiling;
  currentGraduatedLevel: Ceiling;
  /** target > current AND the write is permitted (not locked/protected/pinned). */
  shouldWrite: boolean;
  reason: string;
  driver: { findingClass?: string; cleanStreak?: number } | null;
}

async function ratifyGraduation(category: string, graduatedLevel: Ceiling, reason: string): Promise<void> {
  const r = await fetch('/api/agent-mcp/autonomy-policy-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category, graduatedLevel, reason }),
  });
  const text = await r.text();
  let data: { ok?: boolean; error?: string } = {};
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${r.status}`);
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '10px 12px',
  marginBottom: 8,
  background: 'var(--bg)',
};

export default function GraduationPrompts() {
  const { data, loading, error, invalidate } = useSyncQuery<GraduationTarget>({
    queryName: 'autonomy.graduation',
  });
  const targets = data ?? [];
  const eligible = targets.filter((t) => t.shouldWrite);
  const [ratifying, setRatifying] = useState<string | null>(null);

  const onRatify = async (t: GraduationTarget) => {
    setRatifying(t.category);
    try {
      await ratifyGraduation(
        t.category,
        t.targetGraduatedLevel,
        `Owner ratified ${t.label} graduation to ${t.targetGraduatedLevel}`,
      );
      // The write invalidates autonomy.graduation + autonomy.policy server-side;
      // nudge the local query too so the card clears promptly.
      invalidate();
    } catch (err) {
      toast.error(`Couldn't ratify ${t.label}: ${err instanceof Error ? err.message : 'failed'}`);
    } finally {
      setRatifying(null);
    }
  };

  return (
    <section className="pc-settings-section" aria-label="Graduation" style={{ marginTop: 8 }}>
      <h2>Graduation</h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 13, marginTop: 0 }}>
        When a category earns a clean track record of auto-decisions, you can ratify it to a higher
        graduated level here. Ratifying lets earned trust take effect up to the ceiling you set — it
        never raises the ceiling itself, and the Queen never raises it on her own.
      </p>

      {error && (
        <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
          Couldn’t load graduation standings: {error.message}
        </p>
      )}
      {loading && eligible.length === 0 && (
        <p role="status" style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          Loading graduation standings…
        </p>
      )}
      {!loading && eligible.length === 0 && !error && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          No categories are graduation-eligible yet. As the Queen accumulates clean auto-passes
          within your ceilings (once autonomy is armed), promotions you can ratify appear here.
        </p>
      )}

      {eligible.map((t) => {
        const busy = ratifying === t.category;
        return (
          <div key={t.category} style={cardStyle}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--fg)' }}>
                <strong>{t.label}</strong> has earned{' '}
                <strong>{CEILING_SHORT_LABEL[t.targetGraduatedLevel]}</strong> autonomy{' '}
                <span style={{ color: 'var(--fg-mute)' }}>
                  (currently {CEILING_SHORT_LABEL[t.currentGraduatedLevel]})
                </span>
              </span>
              {t.driver?.cleanStreak != null && (
                <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                  {t.driver.cleanStreak} clean pass{t.driver.cleanStreak === 1 ? '' : 'es'}
                  {t.driver.findingClass ? ` · ${t.driver.findingClass}` : ''}
                </span>
              )}
              <button
                type="button"
                onClick={() => void onRatify(t)}
                disabled={busy}
                style={{
                  marginLeft: 'auto',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '4px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--accent)',
                  background: busy ? 'var(--bg-2)' : 'var(--accent)',
                  color: busy ? 'var(--fg-mute)' : 'var(--accent-fg, #fff)',
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {busy ? 'Ratifying…' : `Ratify → ${CEILING_SHORT_LABEL[t.targetGraduatedLevel]}`}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
