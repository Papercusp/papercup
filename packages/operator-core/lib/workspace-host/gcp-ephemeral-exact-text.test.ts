import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- side-effect-free .mjs sibling of the CLI binaries; no type declarations.
import { requireExactText, requireText } from '../../bin/gcp-ephemeral.mjs';

/**
 * Regression guard: a content-addressed payload must not be trimmed by its own validator.
 *
 * Both clean-room binaries (papercusp-gcp-bootstrap-acceptance, papercusp-gcp-clean-room)
 * validate `fixture.bootstrapScript`, then hash it and compare against the fixture's advertised
 * `bootstrapScriptSha256`. They used `requireText`, which returns `value.trim()`. Every fixture
 * produced by `buildWorkspaceHostCleanRoomInstallFixture` ends in a newline, so the binaries
 * hashed a 1-byte-shorter string than the one the digest was computed over and rejected every
 * genuine fixture with "does not match fixture.bootstrapScriptSha256".
 *
 * Two properties made this expensive to find and cheap to miss:
 *  - The digest comparison is CONDITIONAL on bootstrapScriptSha256 being present, so hand-made
 *    test inputs that omit it skipped the check entirely. The defect was latent exactly on the
 *    production path, where a real fixture always carries its digest.
 *  - The failure names the digest, which reads as a corrupt or mismatched payload rather than
 *    as a validator mutating the bytes it was handed.
 *
 * Had the digest check not existed, the guest would have EXECUTED a script whose bytes differ
 * from the attested digest — silently breaking the exact-bootstrap-attestation property the
 * release gate exists to verify. So this is an integrity guard, not a formatting nit.
 */
describe('gcp-ephemeral text validators', () => {
  const script = '#!/bin/sh\necho "papercusp bootstrap complete"\n';

  it('requireText trims — which is why it must not be used on content-addressed payloads', () => {
    expect(requireText(script, 'script')).toBe(script.trim());
    expect(requireText('  padded  ', 'x')).toBe('padded');
  });

  it('requireExactText preserves the exact bytes, including a trailing newline', () => {
    expect(requireExactText(script, 'script')).toBe(script);
    expect(requireExactText(script, 'script').endsWith('\n')).toBe(true);
  });

  it('a digest over requireExactText matches the payload digest; over requireText it does not', () => {
    const advertised = createHash('sha256').update(script, 'utf8').digest('hex');

    const viaExact = createHash('sha256')
      .update(requireExactText(script, 'script') as string, 'utf8')
      .digest('hex');
    expect(viaExact).toBe(advertised);

    // The exact shape of the original bug: the trimmed value hashes differently, so the
    // binary's own integrity check rejects a payload that was never corrupt.
    const viaTrimmed = createHash('sha256')
      .update(requireText(script, 'script') as string, 'utf8')
      .digest('hex');
    expect(viaTrimmed).not.toBe(advertised);
  });

  it('requireExactText still rejects non-strings and blank strings', () => {
    for (const bad of [undefined, null, 42, {}, '', '   ', '\n\t ']) {
      expect(() => requireExactText(bad, 'field')).toThrow(/field must be a non-empty string/);
    }
  });
});
