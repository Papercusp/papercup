/**
 * topics-subscribe-retired.test.ts — the retirement of `topics:subscribe` stays
 * retired (coordination-spec-adoption-2026-08-03, D-102).
 *
 * WHY THIS GUARD EXISTS, and it is not hypothetical. While performing this very
 * retirement on 2026-08-09 the deleted source file was **silently re-created
 * twice**, ~30 minutes after each deletion, and git-sync committed the re-add
 * each time:
 *
 *   51709bff41 01:19  D  …/tools/topics-subscribe.ts     (the deletion)
 *   40eb34c3d2 01:31  A  …/tools/topics-subscribe.ts     (back, byte-identical)
 *   2ee1fdce9f 01:55  D  …/tools/topics-subscribe.ts     (deleted again)
 *   f140b48983 02:20  A  …/tools/topics-subscribe.ts     (back again)
 *
 * `index.ts` never regained the import in ANY of those commits, so whatever does
 * this restores FILES, not edits — which is the dangerous shape: on a swept tree
 * `git status` reads clean either way, so a resurrected orphan is invisible, and
 * the next agent to run the retirement scan finds a live-looking tool file and
 * reasonably concludes the retirement was never finished. Filed separately; this
 * guard is the containment.
 *
 * The two assertions are deliberately different questions:
 *   1. is the DOOR closed  — nothing imports/registers the tool (what matters)
 *   2. is the ORPHAN gone  — no stray source at the live path (hygiene, and the
 *      thing that actually flapped)
 *
 * ⚠ Restoring `topics:subscribe` on purpose (see
 * `_retired/topics-subscribe/RESTORE.md`) means deleting THIS file too — it is
 * step 6 of that runbook. A red here is not a licence to weaken the assertion.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const LIVE_TOOL_PATH = abs('./tools/topics-subscribe.ts');
const LIVE_TEST_PATH = abs('./tools/topics-subscribe.test.ts');
const REGISTRY = abs('../index.ts');
const RETIRED_COPY = abs('../../../../../_retired/topics-subscribe/topics-subscribe.ts');

describe('topics:subscribe stays retired (D-102)', () => {
  it('is not registered — no import in the agent-tools registry', () => {
    // The load-bearing assertion. A defineTool only registers when its module is
    // imported, so this is what actually keeps the verb off every tool surface —
    // and it held across all four flap commits above.
    const registry = readFileSync(REGISTRY, 'utf8');
    expect(registry).not.toMatch(/import\s+['"]\.\/coordination\/tools\/topics-subscribe['"]/);
  });

  it('the base primitive that replaced it is still registered', () => {
    // Control: assertion 1 must fail for the RIGHT reason. If someone deleted the
    // whole topics/events block, assertion 1 would pass while the capability was
    // gone — the retirement claim is "no capability lost", so pin the replacement.
    const registry = readFileSync(REGISTRY, 'utf8');
    expect(registry).toMatch(/import\s+['"]\.\/events\/watch['"]/);
  });

  it('the retired source is preserved under _retired/ (the restore point is real)', () => {
    expect(existsSync(RETIRED_COPY)).toBe(true);
    expect(readFileSync(RETIRED_COPY, 'utf8')).toMatch(/name: 'topics:subscribe'/);
  });

  it('no orphan source has re-materialised at the live path', () => {
    // This is the one that caught the resurrection. If it reds, the file came
    // back AGAIN — delete it (the door is still shut, so nothing is broken) and
    // add the evidence to the resurrection work-item rather than re-doing the
    // retirement, which is already complete everywhere else.
    expect(
      existsSync(LIVE_TOOL_PATH),
      'topics-subscribe.ts re-appeared at the live tool path — see this file\'s header: it has done so twice already, and git-sync commits the re-add',
    ).toBe(false);
    expect(existsSync(LIVE_TEST_PATH)).toBe(false);
  });
});
