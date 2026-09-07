/**
 * work-item-fetch-hint — unit tests (EI-20451119672468393).
 *
 * The shared builder every carry surface (compaction-recovery, carry-brief cold
 * render, orient-shape reshaper, turn-start orientation) uses for its
 * `work_items:get` re-fetch hints, so the harness qualification cannot drift
 * per-surface. WI-<n> ids are not globally unique, so an unqualified hint from
 * a cross-harness carry surface can miss or mis-resolve.
 */
import { describe, expect, it } from 'vitest';
import { workItemFetchHint } from './work-item-fetch-hint';

describe('workItemFetchHint', () => {
  it('qualifies with the canonical harness when known', () => {
    expect(workItemFetchHint('WI-3496', 'papercusp')).toBe(
      "work_items:get { id: 'WI-3496', harness: 'papercusp' }",
    );
  });

  it('omits the canonical harness for workspace-unique EI issue ids', () => {
    expect(workItemFetchHint('EI-22547630371995201', 'portal')).toBe(
      "work_items:get { id: 'EI-22547630371995201' }",
    );
  });

  it('omits the harness key for operator/global-scoped (null) and unknown (undefined) items', () => {
    expect(workItemFetchHint('EI-1', null)).toBe("work_items:get { id: 'EI-1' }");
    expect(workItemFetchHint('EI-1')).toBe("work_items:get { id: 'EI-1' }");
  });
});
