import { describe, expect, it } from 'vitest';
import {
  OPTIONAL_SETUP_ITEMS,
  PREVIEW_ITEM_KEYS,
  optionalSetupItemsMarkdown,
  visibleOptionalSetupItems,
} from './optional-setup-items';

describe('optional-setup-items — preview gating', () => {
  it('the three not-ready features are the preview set', () => {
    // Owner-directed 2026-07-04: telemetry consent, mobile pairing, auto-update channel
    // are not ready and must be gated.
    expect([...PREVIEW_ITEM_KEYS].sort()).toEqual(
      ['mobile-pairing', 'telemetry', 'update-channel'].sort(),
    );
  });

  it('a default install (preview OFF) never sees the not-ready items', () => {
    const visible = visibleOptionalSetupItems(false).map((i) => i.key);
    for (const k of PREVIEW_ITEM_KEYS) {
      expect(visible, `${k} must be hidden when preview is OFF`).not.toContain(k);
    }
    // The ready items are always offered.
    expect(visible).toEqual(['git-identity', 'github', 'backups', 'api-keys']);
  });

  it('a tester (preview ON) sees every item', () => {
    expect(visibleOptionalSetupItems(true)).toEqual(OPTIONAL_SETUP_ITEMS);
    expect(visibleOptionalSetupItems(true).length).toBe(OPTIONAL_SETUP_ITEMS.length);
  });

  it('every item has a stable unique key + a non-empty label/why', () => {
    const keys = OPTIONAL_SETUP_ITEMS.map((i) => i.key);
    expect(new Set(keys).size, 'keys must be unique').toBe(keys.length);
    for (const i of OPTIONAL_SETUP_ITEMS) {
      expect(i.label.trim().length, `${i.key} label`).toBeGreaterThan(0);
      expect(i.why.trim().length, `${i.key} why`).toBeGreaterThan(0);
    }
  });

  it('every preview item is marked input:"preview" (no write wired for a not-ready feature)', () => {
    for (const i of OPTIONAL_SETUP_ITEMS) {
      if (i.preview) expect(i.input, `${i.key}`).toBe('preview');
    }
  });

  it('the markdown table drops preview rows when the flag is OFF', () => {
    const off = optionalSetupItemsMarkdown(false);
    expect(off).not.toMatch(/Telemetry|Mobile pairing|Auto-update/);
    expect(off).toMatch(/Git identity/);
    const on = optionalSetupItemsMarkdown(true);
    expect(on).toMatch(/Telemetry consent/);
    expect(on).toMatch(/Mobile pairing/);
    expect(on).toMatch(/Auto-update channel/);
  });
});
