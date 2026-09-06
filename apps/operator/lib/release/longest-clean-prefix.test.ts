/**
 * `longestCleanPrefix` — the bisecting locate behind the green-checkpoint's partial-green
 * prefix salvage. Two properties are load-bearing: it must answer EXACTLY what the linear
 * scan it replaced answered on a monotone walk (so the salvage's verdict is unchanged),
 * and it must do so in O(log n) probes (so an 11.5k-commit frozen lineage no longer holds
 * the gate's run-lock for an hour after the verdict is known).
 */
import { describe, it, expect } from "vitest";
import { longestCleanPrefix } from "./longest-clean-prefix";

type Stop = false | null;

/** The linear scan this helper replaced, kept as the reference oracle. */
function linearReference<T>(
  walk: readonly T[],
  verdictAt: (index: number) => boolean | null,
): { prefixTip: T | null; stopped: boolean } {
  let prefixTip: T | null = null;
  let stopped = false;
  for (let i = 0; i < walk.length; i += 1) {
    if (verdictAt(i) !== true) {
      stopped = true;
      break;
    }
    prefixTip = walk[i];
  }
  return { prefixTip, stopped };
}

/** A monotone walk of `n` items whose first stop sits at `firstStop` (n ⇒ never stops). */
function monotone(n: number, firstStop: number, stop: Stop) {
  const walk = Array.from({ length: n }, (_, i) => `c${i}`);
  const verdictAt = (i: number): boolean | null => (i < firstStop ? true : stop);
  return { walk, verdictAt };
}

describe("longestCleanPrefix", () => {
  it("answers exactly what the linear scan answered, for every boundary of every walk up to 24 items", async () => {
    for (let n = 0; n <= 24; n += 1) {
      for (let firstStop = 0; firstStop <= n; firstStop += 1) {
        for (const stop of [false, null] as Stop[]) {
          const { walk, verdictAt } = monotone(n, firstStop, stop);
          const expected = linearReference(walk, verdictAt);
          const actual = await longestCleanPrefix(walk, async (_item, i) =>
            verdictAt(i),
          );
          expect(
            { prefixTip: actual.prefixTip, stopped: actual.stopped },
            `n=${n} firstStop=${firstStop} stop=${String(stop)}`,
          ).toEqual(expected);
        }
      }
    }
  });

  it("probes at most ⌈log2(n+1)⌉ times — the measured 11,543-commit walk costs 14 probes, not 10,490", async () => {
    // The 2026-09-06 run 3ce52b07 shape: 11,544 commits in range, the red tip excluded
    // from the walk, the first implicating commit at position 10,490 (0-based 10,489).
    const { walk, verdictAt } = monotone(11_543, 10_489, false);
    const r = await longestCleanPrefix(walk, async (_item, i) => verdictAt(i));
    expect(r.prefixTip).toBe("c10488");
    expect(r.stopped).toBe(true);
    expect(r.probes).toBeLessThanOrEqual(Math.ceil(Math.log2(11_543 + 1)));
    expect(r.probes).toBe(14);

    for (const n of [1, 2, 3, 7, 8, 9, 100, 1_000, 4_097]) {
      for (const firstStop of [0, 1, Math.floor(n / 2), n - 1, n]) {
        const m = monotone(n, firstStop, false);
        const res = await longestCleanPrefix(m.walk, async (_item, i) =>
          m.verdictAt(i),
        );
        expect(res.probes, `n=${n} firstStop=${firstStop}`).toBeLessThanOrEqual(
          Math.ceil(Math.log2(n + 1)),
        );
      }
    }
  });

  it("passes the item AND its index to the predicate, and never probes outside the walk", async () => {
    const walk = ["a", "b", "c", "d", "e"];
    const seen: Array<[string, number]> = [];
    await longestCleanPrefix(walk, async (item, i) => {
      seen.push([item, i]);
      return i < 3;
    });
    for (const [item, i] of seen) {
      expect(walk[i]).toBe(item);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(walk.length);
    }
  });

  it("an empty walk is the empty prefix: no probes, no tip, not stopped", async () => {
    let probes = 0;
    const r = await longestCleanPrefix([], async () => {
      probes += 1;
      return true;
    });
    expect(r).toEqual({ prefixTip: null, stopped: false, probes: 0 });
    expect(probes).toBe(0);
  });

  it("a walk that never stops reports the MAXIMAL prefix with stopped:false — the caller's vacuous-prefix guard depends on that flag", async () => {
    const { walk, verdictAt } = monotone(9, 9, false);
    const r = await longestCleanPrefix(walk, async (_item, i) => verdictAt(i));
    expect(r.prefixTip).toBe("c8");
    expect(r.stopped).toBe(false);
  });

  it("`null` (could not compute) is stop evidence exactly like `false` — never read as clean", async () => {
    const r = await longestCleanPrefix(["a", "b", "c"], async (_item, i) =>
      i === 0 ? true : null,
    );
    expect(r.prefixTip).toBe("a");
    expect(r.stopped).toBe(true);
  });

  it("CONTROL: the reference oracle itself distinguishes a stop at index 0 from a never-stopping walk", () => {
    const { walk, verdictAt } = monotone(3, 0, false);
    expect(linearReference(walk, verdictAt)).toEqual({ prefixTip: null, stopped: true });
    const never = monotone(3, 3, false);
    expect(linearReference(never.walk, never.verdictAt)).toEqual({
      prefixTip: "c2",
      stopped: false,
    });
  });
});
