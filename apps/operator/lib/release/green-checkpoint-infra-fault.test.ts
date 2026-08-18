/**
 * EI-20767792192323374 regression: `classifyInfraFault` decides whether a red suite is a
 * verdict about the CODE or an artifact of the gate's own vite-node module cache being
 * deleted underneath it mid-run.
 *
 * Why this classifier is safe enough to unit-test in isolation: a match renders the run
 * INCONCLUSIVE (`green: null`), which can never promote — so a false positive costs at most
 * a red the streak declines to count, and can never manufacture a false green. The tests
 * that matter are therefore the FALSE-POSITIVE ones, not the happy path.
 *
 * Fixtures are REAL lines lifted from the incident's own gate log
 * (~/.papercusp/checkpoint-logs/2026-08-18T05-10-29-164Z-base-4824a92bf8fc-cand-1c64cd9faefa.log),
 * ANSI escapes and all — the classifier reads raw suite stdout, so a sanitised fixture would
 * test a string this code never sees.
 */
import { describe, it, expect } from "vitest";

import {
  classifyInfraFault,
  INFRA_FAULT_MIN_OCCURRENCES,
} from "./green-checkpoint";

/** The human `Error: ENOENT: …, open '<path>'` form, verbatim from the incident log
 *  (line 16897), ANSI colour codes included. */
const humanForm = (root: string, dir: "ssr" | "client", hash: string) =>
  `[31m[1mError[22m: ENOENT: no such file or directory, open '${root}/${dir}/${hash}'[39m`;

/** Vitest's own `Serialized Error: { … path: '<path>' }` form (incident log line 18357). */
const serializedForm = (root: string, hash: string) =>
  `[31m[1mSerialized Error:[22m[39m [90m{ errno: -2, code: 'ENOENT', syscall: 'open', path: '${root}/ssr/${hash}' }[39m`;

const HASH_A = "a840d7df4b7ecb7bd8c054ce0820018df96d7351";
const HASH_B = "f73d01ba976bca57945adce2a3bda2be9886e775";
const HASH_C = "7f4fb0dc48b4cd47c56bb1c75658d01c2191bb50";

const ROOT_1 = "/tmp/3yzc1zkB3RsHItAlZxyZG";
const ROOT_2 = "/tmp/mHiyI31YP2gt3Bxy_zzOg";
const ROOT_3 = "/tmp/4Q_ODaD1DqhQDb1VcnCfr";

describe("classifyInfraFault — matches the real incident signature", () => {
  it("classifies the human `Error: ENOENT … open '<root>/ssr/<sha1>'` form", () => {
    const output = [
      humanForm(ROOT_1, "ssr", HASH_A),
      humanForm(ROOT_1, "client", HASH_A),
      humanForm(ROOT_1, "ssr", HASH_B),
      humanForm(ROOT_1, "ssr", "727185ca1531ec41d278c00b9b0f3fe3aa57d9c5"),
      humanForm(ROOT_1, "ssr", "1111111111111111111111111111111111111111"),
    ].join("\n");

    const fault = classifyInfraFault(output);
    expect(fault).not.toBeNull();
    expect(fault?.kind).toBe("vite-node-cache-vanished");
    expect(fault?.occurrences).toBe(5);
    // Both `ssr/` and `client/` collapse to the SAME cache root — one vitest instance, not two.
    expect(fault?.roots).toEqual([ROOT_1]);
  });

  it("classifies vitest's `Serialized Error: { … path: … }` form too", () => {
    const output = Array.from({ length: INFRA_FAULT_MIN_OCCURRENCES }, (_, i) =>
      serializedForm(ROOT_2, `${"0".repeat(39)}${i}`),
    ).join("\n");

    const fault = classifyInfraFault(output);
    expect(fault?.occurrences).toBe(INFRA_FAULT_MIN_OCCURRENCES);
    expect(fault?.roots).toEqual([ROOT_2]);
  });

  it("matches the `.tmp-<ms>-<id>` half-written-cache-entry form", () => {
    // Real shape from the incident log: '/tmp/4Q_…/ssr/.tmp-1787028605233-2pwzlhm4m7k'
    const output = Array.from(
      { length: INFRA_FAULT_MIN_OCCURRENCES },
      (_, i) => humanForm(ROOT_3, "ssr", `.tmp-178702860523${i}-2pwzlhm4m7k`),
    ).join("\n");

    expect(classifyInfraFault(output)?.roots).toEqual([ROOT_3]);
  });

  it("reports every distinct cache root, sorted, one per vitest instance", () => {
    const output = [
      humanForm(ROOT_1, "ssr", HASH_A),
      humanForm(ROOT_2, "ssr", HASH_B),
      serializedForm(ROOT_3, HASH_C),
      humanForm(ROOT_1, "client", HASH_B),
      serializedForm(ROOT_2, HASH_A),
    ].join("\n");

    const fault = classifyInfraFault(output);
    expect(fault?.occurrences).toBe(5);
    expect(fault?.roots).toEqual([ROOT_3, ROOT_1, ROOT_2].sort());
    // The note must tell the reader NOT to triage the files this run named — that instruction
    // is the whole operational point of the classification.
    expect(fault?.note).toMatch(/must NOT be triaged/);
  });
});

describe("classifyInfraFault — refuses to withdraw a verdict without the real signature", () => {
  it("returns null below the occurrence floor", () => {
    const output = Array.from(
      { length: INFRA_FAULT_MIN_OCCURRENCES - 1 },
      (_, i) => humanForm(ROOT_1, "ssr", `${"0".repeat(39)}${i}`),
    ).join("\n");

    expect(classifyInfraFault(output)).toBeNull();
  });

  it("does NOT match a test TITLE that merely contains the word ENOENT", () => {
    // This repo really has such titles; a substring match on 'ENOENT' would let a suite whose
    // ENOENT-named tests all FAILED withdraw its own red — the one way this classifier could
    // hide a genuine regression. Anchored on the quoted cache path precisely to stop that.
    const output = Array.from(
      { length: 40 },
      (_, i) =>
        ` FAIL  lib/release/green-checkpoint-real-deps.test.ts > ENOENT retry budget still surfaces a real error (${i})`,
    ).join("\n");

    expect(classifyInfraFault(output)).toBeNull();
  });

  it("does NOT match an ENOENT on a path that is not a vite-node cache entry", () => {
    const output = Array.from(
      { length: 40 },
      () =>
        `Error: ENOENT: no such file or directory, open '/home/agent/papercusp/apps/operator/missing-fixture.json'`,
    ).join("\n");

    expect(classifyInfraFault(output)).toBeNull();
  });

  it("does NOT match an ordinary assertion-failure red", () => {
    const output = [
      " FAIL  lib/release/delta-gate.test.ts > rejects a shrinking baseline",
      "AssertionError: expected 3 to be 4",
      "  ❯ lib/release/delta-gate.test.ts:41:22",
      " Test Files  1 failed | 812 passed",
    ].join("\n");

    expect(classifyInfraFault(output)).toBeNull();
  });

  it("is total on empty output", () => {
    expect(classifyInfraFault("")).toBeNull();
  });
});
