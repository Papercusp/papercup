import { describe, expect, it } from 'vitest';
import { readRepoFile } from '@papercusp/test-config';

/**
 * Guard: root CLAUDE.md must not present WebSocket as a LIVE sync transport
 * while `HarnessSyncProvider` hardcodes SSE.
 *
 * WI-12 (2026-08-03). CLAUDE.md claimed "SSE-primary on desktop, WS in browser,
 * REST fallback" and "browser WS is a dev fallback — a feature that only works
 * under WS is incomplete" for ~3 months after the 2026-05-07 SSE cutover
 * retired the Zero-WebSocket branch. Both claims contradicted the very file
 * CLAUDE.md names as its source of truth — `apps/operator/providers/
 * HarnessSyncProvider.tsx` passes a literal `syncType="SSE"` with NO runtime
 * branch — and the canonical doc (`/internal/docs/system/repo-conventions`
 * § deployment model), whose own "stale docs to mistrust" list already flagged
 * this exact wording class.
 *
 * Why it earns a guard and not just a fix: CLAUDE.md is spliced into every
 * agent prompt in this repo, so the drift was re-delivered on every turn, and
 * it told agents a desktop-vs-browser transport difference exists when it does
 * not. The real degraded path is POLLING, which is catastrophic here (~40
 * registered queries re-fetched per tick against a 6-connection-per-host cap).
 *
 * Two-sided by design: it fails if the provider stops hardcoding SSE (the docs,
 * and this test's premise, would then need updating) AND if CLAUDE.md ever
 * describes WS as in-use again.
 */

const PROVIDER_REL = 'apps/operator/providers/HarnessSyncProvider.tsx';
const CLAUDE_MD_REL = 'CLAUDE.md';

/** Any mention of the WebSocket transport, however spelled. */
const WS_MENTION = /\bWS\b|WebSockets?|WEBSOCKETS/i;

/**
 * A WS mention is acceptable only when the SAME sentence says WS is out of
 * play. Deliberately narrow: an earlier paragraph-scoped version of this guard
 * was VACUOUS — a bare `retired` (about Zero) and a bare `stale` (about the
 * stale-docs list) elsewhere in the paragraph rescued both offending sentences,
 * so the guard passed on the exact text it was written to catch. A bare
 * `never` is excluded for the same reason: "**Never** hand-roll `fetch +
 * setInterval`" sits in the same sentence as the first bad claim.
 */
const RETIREMENT_MARKER =
  /retired|no longer|nothing selects|never (selects|passes|chooses)|not selected|removed|unreachable/i;

/**
 * Sentence granularity (split on `.`/`;` + whitespace) rather than paragraph:
 * a claim and a nearby unrelated retirement word routinely share a paragraph.
 */
function wsClaimOffenders(markdown: string): string[] {
  return markdown
    .split(/(?<=[.;])\s+/)
    .filter((sentence) => WS_MENTION.test(sentence) && !RETIREMENT_MARKER.test(sentence))
    .map((sentence) => sentence.replace(/\s+/g, ' ').slice(0, 200));
}

/**
 * The two claims this guard exists to catch, verbatim from CLAUDE.md@HEAD~5
 * (pre-fix, 2026-08-03). Pinned here so the guard can never rot into a check
 * that passes on everything — the failure mode its first draft actually had.
 */
const HISTORICAL_BAD_CLAIMS = [
  '**Never** hand-roll `fetch + setInterval`, SWR, React-Query, or a raw `EventSource` for query data — the library is the one audited path (SSE-primary on desktop, WS in browser, REST fallback).',
  'Shipping target = the Tauri desktop app; **desktop SSE is the sync path that matters** (browser WS is a dev fallback — a feature that only works under WS is incomplete).',
];

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

  it('flags the historical CLAUDE.md claims (guard is falsifiable, not vacuous)', () => {
    for (const claim of HISTORICAL_BAD_CLAIMS) {
      expect(
        wsClaimOffenders(claim),
        `this guard no longer flags a known-bad claim, so it proves nothing: ${claim}`,
      ).toHaveLength(1);
    }

    // ...and it clears the corrected wording that replaced them.
    expect(
      wsClaimOffenders(
        'The Zero WebSocket branch was retired in the 2026-05-07 cutover and nothing selects WS now. ' +
          'WS is **retired** (nothing selects it); POLLING is the degraded fallback.',
      ),
    ).toEqual([]);
  });

  it('every WS mention in CLAUDE.md is a retirement claim, never a live-transport claim', () => {
    const offenders = wsClaimOffenders(readRepoFile(__dirname, CLAUDE_MD_REL));

    expect(
      offenders,
      'CLAUDE.md presents WebSocket as a live/selected/fallback sync transport. It is not: ' +
        'HarnessSyncProvider passes a literal syncType="SSE" for every runtime (no ' +
        'desktop-vs-browser branch), the Zero-WS branch was retired in the 2026-05-07 ' +
        'cutover, and POLLING — not WS — is the degraded fallback. Offending sentence(s): ' +
        `${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
