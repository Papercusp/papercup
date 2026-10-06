/**
 * Roster mapping for the local-desktop live view
 * (`agent-virtual-desktops-2026-08-23` P-004).
 *
 * WHY THIS FILE EXISTS. Both filters in `toLocalDesktopRows` fail SILENTLY when
 * wrong, and neither shows up as an error anywhere near the mistake:
 *
 *   - a REMOTE row that leaks through renders a tile whose VNC session is then
 *     refused by the admission gate — so the bug surfaces as "this desktop is in
 *     the list but will not open", far from the mapper;
 *   - a display string that does not parse renders a tile with `display: NaN`,
 *     which posts `{"display": null}` and 400s.
 *
 * Neither is caught by typechecking, so they are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { toLocalDesktopRows } from './local-desktops';
import type { DesktopSessionRecord } from '../../../desktop/desktop-session-registry';

const rec = (over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord => ({
  id: 'ds-1',
  workspaceId: 'ws',
  harnessSlug: 'alpha',
  kind: 'xvfb-local',
  scope: 'pot',
  scopeRef: 'alpha',
  name: null,
  hostRef: null,
  ownerPid: 1,
  ownerBootId: 'boot',
  display: ':110',
  displayGeometry: { width: 1280, height: 1024, depth: 24 },
  captureGeometry: { width: 1024, height: 768 },
  state: 'ready',
  leaseHolder: null,
  viewerMode: 'none',
  viewerActor: null,
  capabilities: {},
  ttlSec: null,
  taskId: null,
  idleAfterSec: null,
  frozenAt: null,
  createdAt: new Date(),
  lastActiveAt: new Date(),
  releasedAt: null,
  ...over,
});

describe('toLocalDesktopRows (P-004)', () => {
  it('maps a local session, splitting the display into a number and its raw form', () => {
    const [row] = toLocalDesktopRows([rec()]);
    expect(row).toMatchObject({
      id: 'ds-1',
      slug: 'alpha',
      kind: 'xvfb-local',
      display: 110, // what the VNC route wants
      displayRaw: ':110', // what a human reads
      state: 'ready',
      viewerMode: 'none',
    });
  });

  it('DROPS remote rows — their display belongs to another host', () => {
    const rows = toLocalDesktopRows([
      rec({ id: 'local', hostRef: null }),
      rec({ id: 'remote', hostRef: 'frame-lat-1', kind: 'frame-slot' }),
    ]);
    // Positive control in the same call: the local row DID survive, so the empty
    // remote result is a real exclusion and not a mapper that drops everything.
    expect(rows.map((r) => r.id)).toEqual(['local']);
  });

  it('drops a display that does not parse to a number', () => {
    const rows = toLocalDesktopRows([
      rec({ id: 'ok', display: ':110' }),
      rec({ id: 'wayland', display: 'wayland-0' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });

  it('carries the viewer binding through so the tile can show who is watching', () => {
    const [row] = toLocalDesktopRows([rec({ viewerMode: 'takeover', viewerActor: 'user:a' })]);
    expect(row.viewerMode).toBe('takeover');
    expect(row.viewerActor).toBe('user:a');
  });

  it('carries BOTH geometries — display vs capture is the D-006 split', () => {
    const [row] = toLocalDesktopRows([rec()]);
    expect(row.displayGeometry).toEqual({ width: 1280, height: 1024, depth: 24 });
    expect(row.captureGeometry).toEqual({ width: 1024, height: 768 });
  });

  it('handles an empty registry without inventing rows', () => {
    expect(toLocalDesktopRows([])).toEqual([]);
  });
});
