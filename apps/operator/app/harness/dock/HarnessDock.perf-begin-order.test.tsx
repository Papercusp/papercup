// @vitest-environment jsdom
//
// HarnessDock — the BEGIN side of PERF_INTERACTIONS.harnessDockOpen must run
// before DockviewReact's onReady settle point (WI-7021).
//
// WHY THIS FILE EXISTS. WI-7021 found harness-dock-open never emitting a
// measure on EITHER route (/adv and /workbench), even though the dock
// genuinely, fully mounted with real hydrated data every time. The mark was
// being written (beginInteraction ran) but never consumed — the exact "SILENT
// ZERO" failure mode perf-marks.ts's top-of-file doc comment already names,
// just not yet applied to this component.
//
// THE MECHANISM. dockview-react's real <DockviewReact onReady={...}> component
// calls `props.onReady({ api })` from its OWN vendored
// `React.useEffect(() => { ...; props.onReady({ api }); }, [])` — a PASSIVE
// effect (verified by reading node_modules/dockview/dist/dockview.js directly,
// not assumed). React runs effects in phases, and within a phase CHILD BEFORE
// PARENT. DockviewReact sits several components below HarnessDock in the tree
// (HarnessDock -> DockWorkspace -> DockviewReact), so on first mount, with a
// PASSIVE begin in HarnessDock, the order is:
//
//     DockviewReact's passive onReady effect (child)  ->  HarnessDock's passive begin effect (parent)
//
// i.e. endInteraction(harnessDockOpen) (invoked from onApiReady, which
// onReady calls) runs BEFORE beginInteraction ever wrote a start mark. It
// no-ops silently (no matching start), then a moment later beginInteraction
// writes a start mark nothing will ever consume — the interaction never emits
// a measure, on any route, regardless of how genuinely the dock mounted.
//
// THE FIX. ALL layout effects (the whole tree) run before ANY passive effect,
// so a begin in a layout effect precedes DockviewReact's passive onReady
// effect regardless of child-before-parent ordering. These tests pin that
// contract from both ends, mirroring
// LearningTab.perf-begin-order.test.tsx's pattern: the ordering behaviour (so
// the guarantee is asserted, not assumed) and the source of HarnessDock
// itself (so a revert to `useEffect` fails here rather than silently in
// production).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useEffect, useLayoutEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/** Records begin/end in call order — the ordering IS the property under
 *  test, not a wall-clock duration (which would be flaky and wouldn't
 *  localise the failure anyway). */
let calls: string[] = [];

/** Models dockview-react's REAL onReady wiring, verified against
 *  node_modules/dockview/dist/dockview.js: a passive
 *  `React.useEffect(() => { ...; props.onReady({ api }); }, [])` that fires
 *  exactly once, on mount, several levels below the component that begins the
 *  interaction. */
function DockviewReadyChild({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    calls.push('end'); // onReady -> onApiReady -> endInteraction
    onReady();
  }, [onReady]);
  return <div data-testid="dockview" />;
}

/** Mirrors HarnessDock: begins the interaction on first mount, in whichever
 *  effect phase `phase` selects, then renders a DockWorkspace-like tree that
 *  bottoms out at DockviewReadyChild. */
function Parent({ phase }: { phase: 'passive' | 'layout' }) {
  const useChosenEffect = phase === 'layout' ? useLayoutEffect : useEffect;
  useChosenEffect(() => {
    calls.push('begin');
  }, []);
  return (
    <div>
      <DockviewReadyChild onReady={() => {}} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  calls = [];
});

describe('harness-dock-open begin/settle ordering', () => {
  it('PASSIVE begin lets the child onReady settle FIRST — the WI-7021 silent-zero bug', () => {
    render(<Parent phase="passive" />);
    // The child's passive mount effect (deeper in the tree) fires before the
    // parent's own passive mount effect, so endInteraction runs with no start
    // mark yet written. This assertion documents the DEFECT.
    expect(calls).toEqual(['end', 'begin']);
  });

  it('LAYOUT begin runs before the child settles, so the measure is real', () => {
    render(<Parent phase="layout" />);
    // ALL layout effects (whole tree) run before ANY passive effect, so begin
    // (layout) precedes the child's onReady (passive) regardless of nesting.
    expect(calls).toEqual(['begin', 'end']);
  });
});

describe('HarnessDock source contract', () => {
  // Resolved from cwd rather than import.meta.url: Vite rewrites module URLs
  // to a non-file scheme, so fileURLToPath throws here. Both candidates are
  // tried so the test is indifferent to whether the runner starts in the
  // workspace or the repo root.
  const REL = 'app/harness/dock/HarnessDock.tsx';
  const sourcePath = [
    resolve(process.cwd(), REL),
    resolve(process.cwd(), 'apps/operator', REL),
  ].find(existsSync);
  if (!sourcePath) throw new Error(`HarnessDock.tsx not found from ${process.cwd()}`);
  const source = readFileSync(sourcePath, 'utf8');

  it('begins harness-dock-open in a LAYOUT effect, not a passive one', () => {
    // Guards the real component, not the model above: the behavioural tests
    // prove what layout-vs-passive DOES, this proves HarnessDock still picks
    // the correct one. A revert to useEffect reds here.
    const beginIndex = source.indexOf(
      'beginInteraction(PERF_INTERACTIONS.harnessDockOpen)',
    );
    expect(beginIndex).toBeGreaterThan(-1);

    // The nearest effect opener above the begin call must be the layout one.
    const preceding = source.slice(0, beginIndex);
    const lastLayout = preceding.lastIndexOf('useLayoutEffect(');
    const lastPassive = preceding.lastIndexOf('useEffect(');
    expect(lastLayout).toBeGreaterThan(-1);
    expect(lastLayout).toBeGreaterThan(lastPassive);
  });
});
