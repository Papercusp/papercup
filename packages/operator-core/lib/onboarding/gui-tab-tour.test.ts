import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUI_TAB_TOUR, guiTabTourMarkdown } from './gui-tab-tour';

describe('guiTabTourMarkdown', () => {
  it('renders one numbered dispatch line per stop, in order, plus the visibility note', () => {
    const md = guiTabTourMarkdown();
    GUI_TAB_TOUR.forEach((t, i) => {
      expect(md).toContain(`${i + 1}. **${t.label}**`);
      expect(md).toContain(`params:{tab:'${t.id}'}`);
      expect(md).toContain(t.blurb);
    });
    expect(md).toContain("path:'/adv'");
    expect(md).toContain('feature-flag-gated');
  });

  it('every stop has a non-trivial blurb (the tutor narrates from it)', () => {
    for (const t of GUI_TAB_TOUR) {
      expect(t.blurb.length, t.id).toBeGreaterThan(40);
    }
  });
});

describe('DRIFT GUARD: GUI_TAB_TOUR vs the real ADV_TABS strip (AdvShell.tsx)', () => {
  // operator-core can't import the vite app's TSX, so parse the source: every
  // `{ id: '<id>', label: '<label>', …` entry of the ADV_TABS array literal, in
  // order. Add/remove/rename/reorder a tab in AdvShell.tsx and this test fails
  // until the tour registry is updated too — that's the point (P-018).
  const shellPath = join(
    __dirname,
    '../../../../apps/operator-vite/src/components/adv/AdvShell.tsx',
  );

  it.skipIf(!existsSync(shellPath))('ids + labels + order match exactly', () => {
    const src = readFileSync(shellPath, 'utf8');
    const arrayStart = src.indexOf('export const ADV_TABS');
    expect(arrayStart, 'ADV_TABS not found — did AdvShell.tsx move or rename it?').toBeGreaterThan(-1);
    const arrayEnd = src.indexOf('] as const', arrayStart);
    expect(arrayEnd).toBeGreaterThan(arrayStart);
    const body = src.slice(arrayStart, arrayEnd);

    const entries: Array<{ id: string; label: string }> = [];
    const re = /\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) entries.push({ id: m[1], label: m[2] });

    expect(entries.length, 'parsed no ADV_TABS entries — formatting changed?').toBeGreaterThan(5);
    expect(GUI_TAB_TOUR.map((t) => ({ id: t.id, label: t.label }))).toEqual(entries);
  });
});
