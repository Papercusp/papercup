/**
 * P-009 — resume chunking.
 *
 * The bug this guards: `resume` posts one id per element, so resuming a run
 * stopped early over a whole workspace was ONE request that exceeded the
 * route's body limit. The owner's only affordance for unassessed work failed
 * with a transport error.
 */
import { describe, expect, it } from "vitest";
import {
  RESUME_CHUNK_SIZE,
  chunkFindingIds,
} from "./run-resume-chunks";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `f-${i}`);

describe("chunkFindingIds", () => {
  it("returns no chunks for an empty list — not one empty chunk", () => {
    // A single empty chunk would post a resume with zero ids, which the route
    // treats as "resume everything".
    expect(chunkFindingIds([])).toEqual([]);
  });

  it("keeps a list at or under the size in one chunk", () => {
    expect(chunkFindingIds(ids(1), 500)).toHaveLength(1);
    expect(chunkFindingIds(ids(500), 500)).toHaveLength(1);
  });

  it("splits at the boundary, not one element late", () => {
    const chunks = chunkFindingIds(ids(501), 500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toEqual(["f-500"]);
  });

  it("preserves order and loses nothing across many chunks", () => {
    const input = ids(2050);
    const chunks = chunkFindingIds(input, 500);
    expect(chunks).toHaveLength(5);
    expect(chunks.flat()).toEqual(input);
    expect(new Set(chunks.flat()).size).toBe(input.length);
  });

  it("copies rather than aliasing the caller's array", () => {
    const input = ids(3);
    const chunks = chunkFindingIds(input, 500);
    chunks[0]!.push("mutated");
    expect(input).toHaveLength(3);
  });

  it("refuses a size that would loop forever or silently do nothing", () => {
    // `for (i += size)` with size <= 0 never advances. Failing loudly beats
    // hanging the report on a bad constant.
    expect(() => chunkFindingIds(ids(3), 0)).toThrow(/positive integer/);
    expect(() => chunkFindingIds(ids(3), -1)).toThrow(/positive integer/);
    expect(() => chunkFindingIds(ids(3), 1.5)).toThrow(/positive integer/);
  });

  it("defaults to the shared chunk size", () => {
    expect(RESUME_CHUNK_SIZE).toBe(500);
    expect(chunkFindingIds(ids(RESUME_CHUNK_SIZE + 1))).toHaveLength(2);
  });
});
