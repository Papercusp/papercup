// @vitest-environment jsdom
// SCRATCH REPRO — NOT committed, delete after use. WI-37386.
//
// Attempt #2 at reproducing "Maximum update depth exceeded" via a SUSTAINED
// (not bursty) external re-render source — simulating a polling refetch
// (SSE→polling fallback) feeding ColumnFilterBar's ancestor with a new `rows`
// reference every ~5ms, driving the REAL (unmocked) Tooltip + Select +
// Popover primitives, not the ColumnFilterBar.test.tsx stand-ins.

import { describe, it, expect, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useState, useEffect } from 'react';
import type { FilterableColumn } from '@papercusp/grid-core';

vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => true }));

import { ColumnFilterBar } from '../filters/ColumnFilterBar';

type Row = { kind: string; name: string };

const COLS: FilterableColumn<Row>[] = [
  { key: 'kind', header: 'Kind', filter: { type: 'enum', accessor: (r) => r.kind } },
  { key: 'name', header: 'Name', filter: { type: 'text', accessor: () => '' } },
];

function mkController(tick: number) {
  return {
    filterableColumns: COLS,
    valueFor: () => undefined,
    setValue: () => {},
    remove: () => {},
    // Fresh array identity every call — simulates a polling refetch reshaping
    // the live option counts (a real useColumnFilters controller recomputes
    // this from `rows`, which the sync layer replaces wholesale each poll).
    optionsFor: () => [
      { value: 'Bug', count: tick % 5 },
      { value: 'Change', count: tick % 3 },
    ],
  };
}

/**
 * `kind` is ACTIVE (rendered as a Tooltip-wrapped removable chip) and `name`
 * is addable (rendered via the real Select "+Add filter…" dropdown) — so a
 * single re-render exercises BOTH suspect primitives at once, matching the
 * two independent crash traces (Tooltip in DepGraphPanel, Select in
 * WorkItemsPanel).
 */
function PollingHarness() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5);
    return () => clearInterval(id);
  }, []);
  return (
    <ColumnFilterBar
      controller={mkController(tick)}
      activeChips={[{ colKey: 'kind', label: `Kind: Bug (${tick})`, clear: () => {} }]}
      hasActive
      clearAll={() => {}}
    />
  );
}

describe('WI-37386 scratch repro — sustained polling-style re-renders', () => {
  it('does not throw "Maximum update depth exceeded" under ~1s of 5ms-cadence re-renders', async () => {
    vi.useFakeTimers();
    const capturedErrors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(String).join(' '));
    };

    let caught: unknown = null;
    try {
      render(<PollingHarness />);
      // 200 ticks * 5ms = ~1s of sustained cadence — well past the 40-tick
      // burst that did NOT reproduce in the prior (non-sustained) attempt.
      for (let i = 0; i < 200; i++) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          vi.advanceTimersByTime(5);
        });
      }
    } catch (e) {
      caught = e;
    } finally {
      console.error = origConsoleError;
      vi.useRealTimers();
      cleanup();
    }

    const crashLine = capturedErrors.find((l) => l.includes('Maximum update depth exceeded'));
    if (crashLine) {
      // eslint-disable-next-line no-console
      console.log('REPRO HIT:', crashLine);
    }
    if (caught) {
      // eslint-disable-next-line no-console
      console.log('REPRO THREW:', String(caught));
    }
    expect(caught, 'render loop threw').toBeNull();
    expect(crashLine, 'console.error captured a Maximum update depth exceeded').toBeUndefined();
  });
});
