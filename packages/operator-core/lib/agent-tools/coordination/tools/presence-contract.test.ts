/**
 * coord:presence argument discoverability contract (EI-20231966513487176).
 *
 * `plan` and `include_stale` were removed intentionally; `ownerId` remains as a
 * compatibility alias for the canonical singular `owner` selector. Plan-scoped
 * reads belong to the claims lens, and the full stale-roster dump was a payload
 * and liveness footgun. The live tool must say that plainly and point callers at
 * the bounded replacement lenses, otherwise callers reconstruct the removed shape
 * and spend a failed round-trip learning the replacement.
 *
 * `ownerIds` MOVED from removed to alias (2026-08-30, presence.ts +28/-4): it is
 * now the documented compatibility alias for the bounded `owners` selector, the
 * exact parallel of `ownerId` -> `owner`, with mutual-exclusion validation and
 * normalization to the canonical selector before lookup. This file pinned the
 * older removal decision and was not updated with that change, so the two halves
 * disagreed: the schema assertion below failed while the guidance assertion above
 * PASSED FOR THE WRONG REASON — it only requires the description to mention the
 * key, which a sentence introducing it as a valid alias satisfies just as well as
 * one naming it removed. Both are re-pinned to the alias contract here, so the
 * guard cannot be satisfied by a bare mention again.
 */
import { describe, expect, it } from 'vitest';
import tool from './presence';

describe('coord:presence argument discoverability (EI-20231966513487176)', () => {
  it('documents the singular owner lookup and the bounded multi-owner lens', () => {
    const guidance = `${tool.description}\n${JSON.stringify(tool.guidance ?? {})}`;

    expect(guidance).toMatch(/`owner` is singular/i);
    expect(guidance).toMatch(/coord:roster \{ view:'live', project:'ids' \}/i);
    expect(guidance).toMatch(/plan-scoped.*coord:roster \{ view:'claims', plan \}.*fleet:assignments \{ plan \}/i);
    expect(guidance).toMatch(/scope\/pot/i);
    expect(guidance).toMatch(/(?:explicit scope|widen)/i);
    expect(guidance).toMatch(/legacy/i);
    expect(guidance).toMatch(/ownerId.*compatibility alias/i);
    // ownerIds is an alias now, so a bare mention proves nothing — require the
    // guidance to actually introduce it as the alias of the bounded selector.
    expect(guidance, 'guidance must document ownerIds as the alias for owners').toMatch(
      /ownerIds is its compatibility alias/i,
    );
    for (const removed of ['harness', 'plan', 'includeStale', 'include_stale']) {
      expect(guidance, `guidance must name removed ${removed}`).toContain(removed);
    }
    expect(guidance).toMatch(/(?:do not pass|invalid)/i);
  });

  it('keeps removed legacy filters out of the declared schema', () => {
    const keys = Object.keys((tool as { args: { shape: Record<string, unknown> } }).args.shape);

    expect(keys).toContain('owner');
    expect(keys).toContain('ownerId');
    // The canonical bounded selector and its compatibility alias must BOTH be
    // declared — pinning the alias so it cannot be dropped silently either.
    expect(keys).toContain('owners');
    expect(keys).toContain('ownerIds');
    for (const removed of ['harness', 'plan', 'includeStale', 'include_stale']) {
      expect(keys, `${removed} must remain removed`).not.toContain(removed);
    }
  });

  it('discloses the hive-scoped workspace clamp and targeted-owner alternative', () => {
    const guidance = `${tool.description}\n${JSON.stringify(tool.guidance ?? {})}`;

    expect(guidance).toContain("scope:'workspace'");
    expect(guidance).toMatch(/hive-scoped SU session.*hive_forbidden/i);
    expect(guidance).toMatch(/targeted.*owner.*workspace peer/i);
    expect(guidance).toMatch(/unscoped\/admin session.*workspace-wide/i);
  });
});
