import { describe, it, expect } from 'vitest';
import {
  spliceToolingOverlay,
  spliceAtMarker,
  CLIENT_TOOLING_OVERLAY_MARKER,
  WIRE_SCHEMAS_MARKER,
  COORD_LEGEND_MARKER,
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

  it('the three markers are distinct + the generated-section splices compose independently', () => {
    expect(new Set([CLIENT_TOOLING_OVERLAY_MARKER, WIRE_SCHEMAS_MARKER, COORD_LEGEND_MARKER]).size).toBe(3);
    const base = `${CLIENT_TOOLING_OVERLAY_MARKER}\n\n${WIRE_SCHEMAS_MARKER}\n\n${COORD_LEGEND_MARKER}`;
    let out = spliceToolingOverlay(base, 'OVERLAY');
    out = spliceAtMarker(out, WIRE_SCHEMAS_MARKER, 'WIRE');
    out = spliceAtMarker(out, COORD_LEGEND_MARKER, 'COORD');
    expect(out).toBe('OVERLAY\n\nWIRE\n\nCOORD');
  });

  it('an empty coord legend removes its marker (never ships the literal comment)', () => {
    const base = `# Doc\n\n${COORD_LEGEND_MARKER}\n\n## Next`;
    expect(spliceAtMarker(base, COORD_LEGEND_MARKER, '')).not.toContain(COORD_LEGEND_MARKER);
  });
});
