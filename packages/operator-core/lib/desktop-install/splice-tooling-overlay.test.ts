import { describe, it, expect } from 'vitest';
import {
  spliceToolingOverlay,
  spliceAtMarker,
  CLIENT_TOOLING_OVERLAY_MARKER,
  WIRE_SCHEMAS_MARKER,
} from './splice-tooling-overlay';

describe('spliceAtMarker — generated-section splice contract', () => {
  it('replaces the marker with the content', () => {
    const base = `# Doc\n\n${WIRE_SCHEMAS_MARKER}\n\n## Next`;
    expect(spliceAtMarker(base, WIRE_SCHEMAS_MARKER, '## Wire schemas\n\n- x')).toBe('# Doc\n\n## Wire schemas\n\n- x\n\n## Next');
  });

  it('replaces ALL occurrences of the marker', () => {
    const base = `${WIRE_SCHEMAS_MARKER}\nmid\n${WIRE_SCHEMAS_MARKER}`;
    expect(spliceAtMarker(base, WIRE_SCHEMAS_MARKER, 'X')).toBe('X\nmid\nX');
  });

  it('empty content REMOVES the marker (never ships the literal comment)', () => {
    const base = `# Doc\n\n${WIRE_SCHEMAS_MARKER}\n\n## Next`;
    const out = spliceAtMarker(base, WIRE_SCHEMAS_MARKER, '');
    expect(out).not.toContain(WIRE_SCHEMAS_MARKER);
  });

  it('absent marker + content → appended; absent marker + empty → unchanged', () => {
    expect(spliceAtMarker('# Doc', WIRE_SCHEMAS_MARKER, 'SECTION')).toBe('# Doc\n\nSECTION\n');
    expect(spliceAtMarker('# Doc', WIRE_SCHEMAS_MARKER, '')).toBe('# Doc');
  });

  it('the two markers are distinct + the wire-schemas splice does not disturb the tooling overlay', () => {
    expect(WIRE_SCHEMAS_MARKER).not.toBe(CLIENT_TOOLING_OVERLAY_MARKER);
    const base = `${CLIENT_TOOLING_OVERLAY_MARKER}\n\n${WIRE_SCHEMAS_MARKER}`;
    const step1 = spliceToolingOverlay(base, 'OVERLAY');
    const step2 = spliceAtMarker(step1, WIRE_SCHEMAS_MARKER, 'LEGEND');
    expect(step2).toBe('OVERLAY\n\nLEGEND');
  });
});
