/**
 * coord:presence argument discoverability contract (EI-20231966513487176).
 *
 * `ownerIds`/`ownerId`, `plan`, and `include_stale` were removed intentionally:
 * the targeted read is singular, plan-scoped reads belong to the claims lens,
 * and the full stale-roster dump was a payload and liveness footgun. The live
 * tool must say that plainly and point callers at the bounded replacement
 * lenses, otherwise callers reconstruct the removed shape and spend a failed
 * round-trip learning the replacement.
 */
import { describe, expect, it } from 'vitest';
import tool from './presence';

describe('coord:presence argument discoverability (EI-20231966513487176)', () => {
  it('documents the singular owner lookup and the bounded multi-owner lens', () => {
    const guidance = `${tool.description}\n${JSON.stringify(tool.guidance ?? {})}`;

    expect(guidance).toMatch(/`owner` is singular/i);
    expect(guidance).toMatch(/coord:roster \{ view:'live', project:'ids' \}/i);
    expect(guidance).toMatch(/plan-scoped.*coord:roster \{ view:'claims', plan \}.*fleet:assignments \{ plan \}/i);
    expect(guidance).toMatch(/scope\/pot.*explicit scope/i);
    expect(guidance).toMatch(/do not pass legacy harness, ownerId, ownerIds, plan, includeStale, or include_stale keys/i);
  });

  it('keeps removed legacy filters out of the declared schema', () => {
    const keys = Object.keys((tool as { args: { shape: Record<string, unknown> } }).args.shape);

    expect(keys).toContain('owner');
    for (const removed of ['harness', 'ownerId', 'ownerIds', 'plan', 'includeStale', 'include_stale']) {
      expect(keys, `${removed} must remain removed`).not.toContain(removed);
    }
  });
});
