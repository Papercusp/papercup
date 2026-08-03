import { describe, expect, it } from 'vitest';
import { readRepoFile } from '@papercusp/test-config';

/**
 * Guard: root CLAUDE.md must not present WebSocket as a LIVE sync transport
 * while `HarnessSyncProvider` hardcodes SSE.
 *
 * WI-12 (2026-08-03). CLAUDE.md claimed "SSE-primary on desktop, WS in browser,
 * REST fallback" and "browser WS is a dev fallback" for ~3 months after the
 * 2026-05-07 SSE cutover retired the Zero-WebSocket branch. Both claims
 * contradicted the very file CLAUDE.md names as its source of truth —
 * `apps/operator/providers/HarnessSyncProvider.tsx` passes a literal
 * `syncType="SSE"` with NO runtime branch — and the canonical doc
 * (`/internal/docs/system/repo-conventions` § deployment model), whose own
 * "stale docs to mistrust" list already flagged this exact wording class.
 *
 * Why it earns a guard rather than just a fix: CLAUDE.md is spliced into every
 * agent prompt in this repo, so the drift was re-delivered on every turn, and
 * it pointed agents at a browser-vs-desktop transport difference that does not
 * exist. The real degraded path is POLLING, which is catastrophic here (~40
 * registered queries re-fetched per tick against a 6-connection-per-host cap).
 *
 * The guard is deliberately two-sided:
 *  - if the provider ever stops hardcoding SSE, this test fails to say the
 *    docs (and this test's premise) now need updating;
 *  - if CLAUDE.md mentions WS again without a retirement marker, it fails.
 */

const PROVIDER_REL = 'apps/operator/providers/HarnessSyncProvider.tsx';
const CLAUDE_MD_REL = 'CLAUDE.md';

/** Any mention of the WebSocket transport, however spelled. */
const WS_MENTION = /\bWS\b|WebSocket|WEBSOCKETS/i;

/** A mention is acceptable only if its paragraph also says WS is not in play. */
const RETIREMENT_MARKER = /retired|no longer|nothing selects|never selects|not selected|removed|stale/i;

describe('CLAUDE.md sync-transport claims track HarnessSyncProvider', () => {
  it('HarnessSyncProvider still hardcodes syncType="SSE" with no runtime branch', () => {
    const provider = readRepoFile(__dirname, PROVIDER_REL);

    expect(
      provider,
      `${PROVIDER_REL} no longer passes a literal syncType="SSE". If the operator's ` +
        'transport genuinely changed, update root CLAUDE.md (the sync + deployment-model ' +
        'sections), /internal/docs/system/repo-conventions § deployment model, and this test.',
    ).toContain('syncType="SSE"');

    expect(
      provider,
      `${PROVIDER_REL} now selects WEBSOCKETS. The docs describe WS as retired — update them.`,
    ).not.toContain('syncType="WEBSOCKETS"');
  });

  it('every WS mention in CLAUDE.md is a retirement claim, never a live-transport claim', () => {
    const claudeMd = readRepoFile(__dirname, CLAUDE_MD_REL);

    // Paragraph granularity (blank-line separated): a claim and its retirement
    // marker routinely land on different lines after prose reflow, so a
    // line-by-line scan produces false positives on correct text.
    const offenders = claudeMd
      .split(/\n\s*\n/)
      .map((para, index) => ({ para, index }))
      .filter(({ para }) => WS_MENTION.test(para) && !RETIREMENT_MARKER.test(para))
      .map(({ para }) => para.replace(/\s+/g, ' ').slice(0, 200));

    expect(
      offenders,
      'CLAUDE.md presents WebSocket as a live/selected/fallback sync transport. It is not: ' +
        'HarnessSyncProvider passes a literal syncType="SSE" for every runtime (no ' +
        'desktop-vs-browser branch), the Zero-WS branch was retired in the 2026-05-07 ' +
        'cutover, and POLLING — not WS — is the degraded fallback. Offending paragraph(s): ' +
        `${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
