import { describe, expect, it } from 'vitest';
import {
  OPTIONAL_SETUP_ITEMS,
  PREVIEW_ITEM_KEYS,
  optionalSetupItemsMarkdown,
  requiredOptionalSetupItems,
  statusStepForItemKey,
  visibleOptionalSetupItems,
} from './optional-setup-items';

describe('optional-setup-items — preview gating', () => {
  it('the two still-not-ready features are the preview set (telemetry shipped, dropped its preview tag)', () => {
    // Owner-directed 2026-07-10: telemetry consent shipped (setup:set_telemetry + the flush
    // pipeline), so it is no longer preview-gated. Mobile pairing + auto-update channel remain.
    expect([...PREVIEW_ITEM_KEYS].sort()).toEqual(['mobile-pairing', 'update-channel'].sort());
    expect([...PREVIEW_ITEM_KEYS]).not.toContain('telemetry');
  });

  it('a default install (preview OFF) never sees the not-ready items but DOES see telemetry', () => {
    const visible = visibleOptionalSetupItems(false).map((i) => i.key);
    for (const k of PREVIEW_ITEM_KEYS) {
      expect(visible, `${k} must be hidden when preview is OFF`).not.toContain(k);
    }
    // The ready items — now including telemetry consent — are always offered.
    expect(visible).toEqual(['git-identity', 'github', 'backups', 'api-keys', 'telemetry']);
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

  it('the markdown table drops the still-preview rows but keeps telemetry when the flag is OFF', () => {
    const off = optionalSetupItemsMarkdown(false);
    expect(off).not.toMatch(/Mobile pairing|Auto-update/);
    expect(off).toMatch(/Telemetry consent/); // shipped → always shown
    expect(off).toMatch(/Git identity/);
    const on = optionalSetupItemsMarkdown(true);
    expect(on).toMatch(/Telemetry consent/);
    expect(on).toMatch(/Mobile pairing/);
    expect(on).toMatch(/Auto-update channel/);
  });
});

describe('optional-setup-items — required (answerable-no) items', () => {
  it('telemetry is the one required item: input confirm, not preview, required true', () => {
    const required = requiredOptionalSetupItems();
    expect(required.map((i) => i.key)).toEqual(['telemetry']);
    const tel = required[0];
    expect(tel.input).toBe('confirm');
    expect(tel.preview).toBe(false);
    expect(tel.required).toBe(true);
  });

  it('required items are a subset of the always-visible (non-preview) items', () => {
    // A required item gated behind the preview flag could never be answered by a fresh
    // install — required implies shipped/visible. Guard that invariant.
    const visibleDefault = new Set(visibleOptionalSetupItems(false).map((i) => i.key));
    for (const i of requiredOptionalSetupItems()) {
      expect(visibleDefault, `${i.key} required but hidden by default`).toContain(i.key);
    }
  });

  it('statusStepForItemKey maps telemetry to its setup-status step (default = key itself)', () => {
    expect(statusStepForItemKey('telemetry')).toBe('telemetry');
    expect(statusStepForItemKey('update-channel')).toBe('auto-update');
    expect(statusStepForItemKey('git-identity')).toBe('git');
    expect(statusStepForItemKey('unknown-thing')).toBe('unknown-thing');
  });
});
