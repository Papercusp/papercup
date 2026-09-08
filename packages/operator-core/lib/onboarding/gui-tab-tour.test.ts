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

  it('ids + labels + order match exactly', () => {
    // NOT skipIf(existsSync): AdvShell.tsx is committed superproject source, not a
    // build artifact, so it is always present in a real checkout. Skipping on its
    // absence would silently DISARM this guard exactly when the file is moved or
    // renamed — the case the assertion below is written to report (EI-21850497063792053).
    expect(
      existsSync(shellPath),
      `AdvShell.tsx not found at ${shellPath} — this drift guard measured NOTHING. If the file moved, update this path; do not skip.`,
    ).toBe(true);
    const src = readFileSync(shellPath, 'utf8');
    const arrayStart = src.indexOf('export const ADV_TABS');
    expect(arrayStart, 'ADV_TABS not found — did AdvShell.tsx move or rename it?').toBeGreaterThan(-1);
    const arrayEnd = src.indexOf('] as const', arrayStart);
    expect(arrayEnd).toBeGreaterThan(arrayStart);
    const body = src.slice(arrayStart, arrayEnd);

    const sharedLabels = new Map(
      [...src.matchAll(/^\s{2}([a-z][A-Za-z0-9_]*):\s*'([^']+)'/gm)].map((match) => [match[1], match[2]]),
    );
    const entries: Array<{ id: string; label: string }> = [];
    const re = /\{\s*id:\s*'([^']+)',\s*label:\s*(?:'([^']+)'|ADV_MORE_LABELS\.([A-Za-z0-9_]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const label = m[2] ?? sharedLabels.get(m[3]);
      expect(label, `unresolved label expression for ADV tab ${m[1]}`).toBeTruthy();
      entries.push({ id: m[1], label: label! });
    }

    expect(entries.length, 'parsed no ADV_TABS entries — formatting changed?').toBeGreaterThan(5);
    expect(GUI_TAB_TOUR.map((t) => ({ id: t.id, label: t.label }))).toEqual(entries);
  });
});
