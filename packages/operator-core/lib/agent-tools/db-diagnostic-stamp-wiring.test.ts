/**
 * EI-19484133375867605 — the seam in `@papercusp/db-org` is inert until a host
 * registers a resolver, so the failure this guards is not a wrong stamp but a MISSING
 * registration: drop the side-effect import from `agent-tools/index.ts` and every db
 * diagnostic silently reverts to the unstamped tag, with nothing failing and no
 * observable symptom until the next time someone re-files a fixed message.
 *
 * Same shape as server-vintage-wiring.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readBuildStamp, resetBuildStampResolver, stampedTag } from '@papercusp/db-org';
import { getBuildInfo } from '../build-info';
import './db-diagnostic-stamp-wiring';

afterEach(() => resetBuildStampResolver());

describe('db-diagnostic build-stamp Papercusp wiring', () => {
  it('registers a resolver at import, reporting this build via the ONE policy source', () => {
    // Reads back whatever /api/health would report, INCLUDING a legitimate null for a
    // bundled artifact with no baked sha — the honest "cannot prove my build" answer.
    expect(readBuildStamp()).toBe(getBuildInfo().sha);
  });

  it('is the registration — not a library default — that produces the stamp', () => {
    // Calibration for the assertion above: clearing the resolver must take the value
    // away. Without this, the first test would pass even if db-org shipped its own
    // default and the wiring import were deleted.
    const registered = readBuildStamp();
    resetBuildStampResolver();
    expect(readBuildStamp()).toBeNull();
    expect(stampedTag('connect-phase-deadline')).toBe('[connect-phase-deadline]');
    if (registered !== null) {
      expect(stampedTag('connect-phase-deadline')).not.toBe(
        `[connect-phase-deadline @ ${registered}]`,
      );
    }
  });
});
