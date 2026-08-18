'use client';

/**
 * Coverage — the `/admin/testing` view of the surface census
 * (deterministic-coverage-census-2026-08-17 P-005).
 *
 * WHAT THIS PANEL MAY NOT DO, stated first because it is the one way it would go wrong:
 * it may not compute a coverage number. Every percentage, count and marker it renders
 * arrives from `readCoverage` through the `testing.coverage` sync query — the same
 * derivation the `testing:coverage` tool and both state cells resolve through.
 *
 * The temptation is specific and would look like ordinary UI code: the panel is handed a
 * `rows` array, so totalling it or dividing by its length is the obvious next line. It
 * would also be wrong every time, because `rows` is capped by `limit` while the
 * aggregates are computed across the whole population — a client-side ratio would be
 * computed over one PAGE and would always look better than the truth.
 *
 * So the only arithmetic below is `formatPct`, which formats a number the server
 * computed, and renders `null` as NOT MEASURED rather than as 0%.
 */

import { useMemo } from 'react';
import { parseAsBoolean, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';

type Rung = 'l1' | 'l2' | 'l3' | 'l4';

const RUNG_LABEL: Record<Rung, string> = {
  l1: 'L1 executed',
  l2: 'L2 conformant',
  l3: 'L3 intent-tested',
  l4: 'L4 hardened',
};

interface FidelityMarker {
  counts: Record<string, number>;
  weakest: string | null;
  declaredPct: number | null;
}

interface Aggregate {
  surfaces: number;
  meets: number;
  below: number;
  waived: number;
  pct: number | null;
  fidelity: FidelityMarker;
  basis: { countedOver: string; boundedByLimit: boolean; limitAppliesTo: string };
}

interface CoveragePayload {
  scope: { workspace: string; harness: string };
  verdict: 'measured' | 'not-measured';
  censusUnknown: string[] | null;
  census: {
    surfaces: number;
    retired: number;
    lastCensusAt: string | null;
    ageMs: number | null;
    providersRegistered: number;
    providersEnabled: number;
    fidelity: FidelityMarker;
  };
  coverage: Aggregate & { floor: Rung; floorMeans: string; byRung: Record<Rung, Aggregate> };
  byKind: Array<Aggregate & { kind: string }>;
  rows: Array<{
    kind: string;
    surfaceId: string;
    sourceFile: string | null;
    fidelity: string;
    depth: number;
    waived: boolean;
  }>;
  count: number;
  total: number;
  truncatedByLimit: boolean;
}

/**
 * The single most important function in this file.
 *
 * `null` means the ratio HAS NO DENOMINATOR — an empty census — and it must never render
 * as "0%". Those read identically to a human skimming a dashboard and mean opposite
 * things: one says nothing is proven, the other says nobody measured. A dash plus the
 * NOT MEASURED banner is the honest rendering.
 */
export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/** The weakest fidelity in a population caps what its number means — so it is shown WITH
 *  the number, never in a legend elsewhere on the page. */
function FidelityChip({ marker }: { marker: FidelityMarker }): React.ReactElement | null {
  if (marker.weakest === null) return null;
  const weak = marker.weakest !== 'declared';
  return (
    <span
      className="pc-test-chip"
      title={
        `Weakest fidelity in this population: ${marker.weakest}. ` +
        `${marker.declaredPct ?? 0}% of these surfaces were derived from a live code registry ` +
        `(declared — cannot drift). A coverage number over a weak census is not the same claim ` +
        `as one over a declared census.`
      }
      style={{
        marginLeft: 6,
        fontSize: 11,
        opacity: 0.75,
        color: weak ? 'var(--pc-warn, #b45309)' : undefined,
      }}
    >
      {marker.weakest}
      {marker.declaredPct !== null && marker.declaredPct < 100 ? ` · ${marker.declaredPct}% declared` : ''}
    </span>
  );
}

export default function CoverageTab(): React.ReactElement {
  const [rung, setRung] = useQueryState('rung', parseAsStringEnum<Rung>(['l1', 'l2', 'l3', 'l4']).withDefault('l1'));
  const [gapsOnly, setGapsOnly] = useQueryState('gaps', parseAsBoolean.withDefault(true));

  const { data } = useSyncQuery<CoveragePayload>({
    queryName: 'testing.coverage',
    args: useMemo(() => ({ rung, gapsOnly, limit: 100 }), [rung, gapsOnly]),
  });

  const payload = data?.[0];

  if (!payload) {
    return (
      <div className="pc-test-tab-header">
        <div>Coverage</div>
        <div style={{ opacity: 0.7 }}>Loading the census…</div>
      </div>
    );
  }

  const { census, coverage } = payload;
  const notMeasured = payload.verdict === 'not-measured';

  return (
    <div>
      <div className="pc-test-tab-header">
        <div>
          Coverage — {payload.scope.harness}
          <FidelityChip marker={census.fidelity} />
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label>
            Floor{' '}
            <select value={rung} onChange={(e) => void setRung(e.target.value as Rung)}>
              {(Object.keys(RUNG_LABEL) as Rung[]).map((r) => (
                <option key={r} value={r}>
                  {RUNG_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={gapsOnly} onChange={(e) => void setGapsOnly(e.target.checked)} /> gaps only
          </label>
        </div>
      </div>

      {/*
        The not-measured banner. Deliberately loud and deliberately ABOVE the numbers:
        an empty census renders a page full of zeroes and dashes that a reader would
        otherwise interpret as "we measured, and it is bad" rather than "nothing measured".
      */}
      {notMeasured && (
        <div
          className="pc-test-card"
          role="status"
          style={{ borderLeft: '3px solid var(--pc-warn, #b45309)', marginBottom: 12 }}
        >
          <div className="pc-test-card-title">NOT MEASURED — this is not 0% coverage</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            No censused surfaces in scope, so every ratio below has no denominator and is shown as “—”.
          </div>
          <ul style={{ fontSize: 12, marginTop: 6 }}>
            {(payload.censusUnknown ?? []).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="pc-test-card">
        <div className="pc-test-card-title">
          Census
          <FidelityChip marker={census.fidelity} />
        </div>
        <div className="pc-test-card-row">
          <span>Surfaces</span>
          <span>{census.surfaces}</span>
        </div>
        <div className="pc-test-card-row">
          <span>Retired</span>
          <span>{census.retired}</span>
        </div>
        <div className="pc-test-card-row">
          <span>Providers registered / enabled</span>
          {/* Zero here is the WI-39809 state: the census loop has nothing to iterate and
              cannot write a row, however healthy its fires look. */}
          <span>
            {census.providersRegistered} / {census.providersEnabled}
          </span>
        </div>
        <div className="pc-test-card-row">
          <span>Last census</span>
          <span>{census.lastCensusAt ?? 'never'}</span>
        </div>
      </div>

      <div className="pc-test-card">
        <div className="pc-test-card-title">
          At floor {RUNG_LABEL[coverage.floor]} — {formatPct(coverage.pct)}
          <FidelityChip marker={coverage.fidelity} />
        </div>
        <div className="pc-test-card-row">
          <span>Meets / below / waived</span>
          <span>
            {coverage.meets} / {coverage.below} / {coverage.waived}
          </span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
          Counted over {coverage.basis.countedOver}; the row list below is capped, these totals are not.
        </div>
      </div>

      <table className="pc-test-table">
        <thead>
          <tr>
            <th>Rung</th>
            <th>Meets</th>
            <th>Below</th>
            <th>Coverage</th>
            <th>Fidelity</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(RUNG_LABEL) as Rung[]).map((r) => (
            <tr key={r}>
              <td>{RUNG_LABEL[r]}</td>
              <td>{coverage.byRung[r].meets}</td>
              <td>{coverage.byRung[r].below}</td>
              <td>{formatPct(coverage.byRung[r].pct)}</td>
              <td>
                <FidelityChip marker={coverage.byRung[r].fidelity} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="pc-test-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Surfaces</th>
            <th>Meets</th>
            <th>Below</th>
            <th>Coverage</th>
            <th>Fidelity</th>
          </tr>
        </thead>
        <tbody>
          {payload.byKind.map((k) => (
            <tr key={k.kind}>
              <td>{k.kind}</td>
              <td>{k.surfaces}</td>
              <td>{k.meets}</td>
              <td>{k.below}</td>
              <td>{formatPct(k.pct)}</td>
              <td>
                {/* Per-kind, NOT the census-wide marker: a global caveat copied onto every
                    row would flag a fully-declared kind as weak, and a caveat that is
                    always present is one readers learn to skip. */}
                <FidelityChip marker={k.fidelity} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pc-test-card-title">
        {gapsOnly ? 'Gaps' : 'Surfaces'} — showing {payload.count} of {payload.total}
        {payload.truncatedByLimit ? ' (truncated)' : ''}
      </div>
      <table className="pc-test-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Surface</th>
            <th>Source file</th>
            <th>Depth</th>
            <th>Fidelity</th>
          </tr>
        </thead>
        <tbody>
          {payload.rows.map((row) => (
            <tr key={`${row.kind}:${row.surfaceId}`}>
              <td>{row.kind}</td>
              <td>{row.surfaceId}</td>
              <td>{row.sourceFile ?? '—'}</td>
              <td>{row.depth}</td>
              <td>
                {row.fidelity}
                {row.waived ? ' · waived' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
