/**
 * FLAGS.SLACK_ORG_CONNECTOR defaults ON — slack-messages-to-bug-reports-2026-10-05 P-001 (R-1).
 *
 * The flag was a deliberate owner-authority dark flag until a legal read of Slack's 2025
 * API terms for the customer-owned internal-app model was on record. That read is
 * enterprise-data-sources-2026-10-01 D-029, and the owner approved switching the
 * connector on (directive #1417, answer 7). A fresh install must therefore report it ON.
 *
 * The calibration test runs first: it proves the registry is the real one (a dark flag is
 * still dark), so a passing absence assertion below means "measured and absent", never
 * "nothing was measured".
 */
import { describe, expect, it } from 'vitest';
import { DARK_FLAGS, FLAG_DEFAULTS, FLAGS } from './types';

describe('papercusp-slack-org-connector default', () => {
  it('calibration: the registry is populated and still holds a known owner-authority dark flag', () => {
    expect(DARK_FLAGS.size).toBeGreaterThan(10);
    expect(DARK_FLAGS.get(FLAGS.GMAIL_AUTO_SEND)?.case).toBe('owner-authority');
    expect(FLAG_DEFAULTS[FLAGS.GMAIL_AUTO_SEND]).toBe(false);
  });

  it('defaults ON and is not registered dark', () => {
    expect(FLAGS.SLACK_ORG_CONNECTOR).toBe('papercusp-slack-org-connector');
    expect(FLAG_DEFAULTS[FLAGS.SLACK_ORG_CONNECTOR]).toBe(true);
    expect(DARK_FLAGS.has(FLAGS.SLACK_ORG_CONNECTOR)).toBe(false);
  });
});
