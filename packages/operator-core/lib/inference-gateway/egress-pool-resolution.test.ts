/**
 * egress-pool-resolution.test.ts — ONE rule, guarded at the source level because it has now been
 * broken independently THREE times (EI-18664933641195210).
 *
 * An account carries its egress in `egressPool` (an ordered rotation list) OR in the legacy singular
 * `egress`. Every consumer must resolve through `egressEntries` / `resolveAccountEgress` /
 * `effectiveEgressEntries`. Reading `<account>.egress?.proxyUrl` DIRECTLY silently skips the pool:
 * for a pool-configured account it evaluates to `undefined`, and — this is why it keeps escaping
 * review — that reads as a perfectly ordinary "this account has no proxy", so the code takes its
 * no-egress branch and returns a confident, wrong answer instead of failing.
 *
 * The three sites it broke, all against the SAME live pool config:
 *   - egress-probe.ts     → `accounts:test-egress` reported hasEgress:false for all 4 proxy-configured
 *                           accounts and probed the box IP direct, producing a bogus "every account
 *                           collides on one exit IP" reading that four agents investigated as real.
 *   - egress-probe.ts     → the `egress` echoed on the probe result named the wrong config.
 *   - gateway.ts (~2012)  → the proactive egress prober early-returned for every pool-configured
 *                           account, so the DEAD-PROXY watchdog it feeds went silent from 2026-06-30
 *                           through a 16-day three-proxy outage.
 *
 * A behavioural test cannot cover the third site deterministically (it is timer-driven inside the
 * gateway closure), which is exactly why the rule is pinned here as a source invariant.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAccountEgress } from './egress-dispatcher';
import { egressEntries, type ClaudeAccount } from '../deployment/account-pool';

const DIR = __dirname;

/**
 * `<identifier>.egress?.proxyUrl` / `.localAddress` — reading a ROUTING field off an ACCOUNT-shaped
 * object. A bare `egress.proxyUrl` (an already-RESOLVED AccountEgress local) is correct and must NOT
 * match, so the leading identifier is required and `egress` itself is excluded.
 */
const ACCOUNT_EGRESS_FIELD_READ = /\b(?!egress\b)[A-Za-z_$][\w$]*\.egress\??\.(?:proxyUrl|localAddress)/g;

/** Strip line + block comments so the prose in THIS rule's own comments never trips it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function sourceFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .sort();
}

describe('egress pool resolution — the rule that broke three times', () => {
  it('no inference-gateway source reads a routing field off <account>.egress directly', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = stripComments(readFileSync(join(DIR, file), 'utf8'));
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(ACCOUNT_EGRESS_FIELD_READ)) {
          offenders.push(`${file}:${i + 1}  ${m[0]}   — resolve via egressEntries/resolveAccountEgress`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the regex actually catches the three historical shapes (calibration — a guard that cannot fail is not a guard)', () => {
    const bad = [
      'if (!account.egress?.proxyUrl || proxyEgressDisabled) return;', // gateway.ts:2012, as it read
      'const hasEgress = !!(account.egress && account.egress.proxyUrl);', // egress-probe.ts:164, as it read
      'const x = active.egress?.localAddress;',
    ];
    for (const line of bad) {
      expect(line.match(ACCOUNT_EGRESS_FIELD_READ), line).not.toBeNull();
    }
  });

  it('does NOT flag a resolved AccountEgress local (the correct shape)', () => {
    const good = [
      'const httpProxy = egressIsHttpProxy(egress.proxyUrl) ? egress.proxyUrl : undefined;',
      'if (!egress || (!egress.proxyUrl && !egress.localAddress)) return {};',
      'const proxy = egressIsSupportedProxy(egress?.proxyUrl) ? egress!.proxyUrl : undefined;',
      'const usedEg = curEgressEntry ?? active.egress;', // taking the object is fine — only field reads skip the pool
    ];
    for (const line of good) {
      expect(line.match(ACCOUNT_EGRESS_FIELD_READ), line).toBeNull();
    }
  });
});

describe('resolveAccountEgress — one implementation, not a fourth copy', () => {
  const acct = (o: Partial<ClaudeAccount>): ClaudeAccount => ({ id: 'a', ...o } as ClaudeAccount);

  it('agrees with egressEntries[0] across every shape (it delegates, so it cannot drift)', () => {
    const shapes: Partial<ClaudeAccount>[] = [
      { egressPool: [{ proxyUrl: 'http://p1:3128' }, {}] } as Partial<ClaudeAccount>,
      { egressPool: [{}, { proxyUrl: 'http://p2:3128' }] } as Partial<ClaudeAccount>,
      { egress: { proxyUrl: 'http://legacy:3128' } } as Partial<ClaudeAccount>,
      { egress: { localAddress: '10.0.0.7' } } as Partial<ClaudeAccount>,
      { egressPool: [], egress: { proxyUrl: 'http://legacy:3128' } } as Partial<ClaudeAccount>,
      {},
    ];
    for (const s of shapes) {
      const a = acct(s);
      expect(resolveAccountEgress(a)).toEqual(egressEntries(a)[0]);
    }
  });

  it('prefers the pool head over the legacy singular egress', () => {
    const a = acct({
      egressPool: [{ proxyUrl: 'http://pool-head:3128' }, {}],
      egress: { proxyUrl: 'http://legacy:3128' },
    } as Partial<ClaudeAccount>);
    expect(resolveAccountEgress(a)).toEqual({ proxyUrl: 'http://pool-head:3128' });
  });
});
