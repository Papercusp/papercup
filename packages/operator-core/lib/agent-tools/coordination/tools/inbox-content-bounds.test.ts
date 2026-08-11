import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INBOX_LIMIT,
  INBOX_ENTRY_BUDGET,
  INBOX_TIER_DEFAULTS,
  inboxBodyCharCap,
  senderBodyDeliveryDiagnostics,
} from './inbox-content-bounds';

describe('coordination inbox content budgets', () => {
  it('keeps the sender projection tied to the inbox defaults', () => {
    expect(INBOX_TIER_DEFAULTS.full.bodyChars).toBe(600);
    expect(inboxBodyCharCap('full', 1)).toBe(600);
    expect(inboxBodyCharCap('full', DEFAULT_INBOX_LIMIT)).toBe(
      Math.floor(INBOX_ENTRY_BUDGET / DEFAULT_INBOX_LIMIT),
    );
  });

  it('reports both a definite truncation and a crowded-page possibility', () => {
    expect(senderBodyDeliveryDiagnostics('x'.repeat(2_260))).toEqual({
      bodyTruncated: true,
      bodyMayBeTruncated: true,
      bodyAuthoredChars: 2_260,
      bodyFullChars: 2_260,
      bodyDeliveredChars: 600,
      bodyDeliveryCap: 600,
      bodyCrowdedPageCap: 300,
    });
  });

  it('does not flag a body that fits every default full-tier page cap', () => {
    expect(senderBodyDeliveryDiagnostics('x'.repeat(300))).toMatchObject({
      bodyTruncated: false,
      bodyMayBeTruncated: false,
      bodyAuthoredChars: 300,
      bodyDeliveredChars: 300,
    });
  });

  it('returns no diagnostic when no body was authored', () => {
    expect(senderBodyDeliveryDiagnostics(undefined)).toBeUndefined();
  });
});
