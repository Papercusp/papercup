/**
 * Regression guard for the 2026-05-30 marker-split bug: any path that ships
 * an SU playbook must splice the client-tooling overlay at the marker, never
 * leak the literal marker. This is the shared splicer used by
 * desktop-install/papercusp-files.ts AND endpoint-route/.../agent-bundle.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  spliceToolingOverlay,
  CLIENT_TOOLING_OVERLAY_MARKER as MARKER,
} from '../splice-tooling-overlay';

describe('spliceToolingOverlay', () => {
  it('splices the overlay at the marker and drops the literal marker', () => {
    const out = spliceToolingOverlay(`# Base\n\n${MARKER}\n\n## Tail\n`, '## Tooling\nuse the thing');
    expect(out).not.toContain(MARKER);
    expect(out).toContain('## Tooling');
    expect(out).toContain('# Base');
    expect(out).toContain('## Tail');
  });

  it('marker present but NO overlay → marker removed, never shipped literally', () => {
    const out = spliceToolingOverlay(`# Base\n${MARKER}\n## Tail\n`, '');
    expect(out).not.toContain(MARKER);
    expect(out).toContain('# Base');
    expect(out).toContain('## Tail');
  });

  it('replaces ALL occurrences of the marker (defensive)', () => {
    const out = spliceToolingOverlay(`${MARKER}\nmid\n${MARKER}`, 'OV');
    expect(out).not.toContain(MARKER);
    expect(out.match(/OV/g)?.length).toBe(2);
  });

  it('pre-marker base + overlay → overlay appended', () => {
    const out = spliceToolingOverlay('# Base, no marker\n', '## Tooling');
    expect(out).toContain('# Base, no marker');
    expect(out).toContain('## Tooling');
    expect(out.endsWith('## Tooling\n')).toBe(true);
  });

  it('pre-marker base + no overlay → verbatim', () => {
    const base = '# Base, no marker\n';
    expect(spliceToolingOverlay(base, '')).toBe(base);
  });
});
