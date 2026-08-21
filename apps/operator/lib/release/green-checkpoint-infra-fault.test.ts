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
  classifyDiskInfraFault,
  classifyInfraFault,
  DISK_ENOSPC_MIN_OCCURRENCES,
  INFRA_FAULT_MIN_OCCURRENCES,
} from "./green-checkpoint";

/** The human `Error: ENOENT: …, open '<path>'` form, verbatim from the incident log
 *  (line 16897), ANSI colour codes included. */
const humanForm = (root: string, dir: "ssr" | "client", hash: string) =>
  `\x1b[31m\x1b[1mError\x1b[22m: ENOENT: no such file or directory, open '${root}/${dir}/${hash}'\x1b[39m`;

/** Vitest's own `Serialized Error: { … path: '<path>' }` form (incident log line 18357). */
const serializedForm = (root: string, hash: string) =>
  `\x1b[31m\x1b[1mSerialized Error:\x1b[22m\x1b[39m \x1b[90m{ errno: -2, code: 'ENOENT', syscall: 'open', path: '${root}/ssr/${hash}' }\x1b[39m`;

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

const DISK_POLICY = {
  freePctMin: 0.1,
  freeBytesMin: 5 * 1024 ** 3,
  freeInodesPctMin: 0.05,
};

const diskSnapshot = (
  path: string,
  freeBytes: number,
  freePct: number,
  freeInodesPct = 0.5,
) => ({
  path,
  totalBytes: 7.3 * 1024 ** 4,
  freeBytes,
  freePct,
  totalInodes: 1_000_000,
  freeInodes: freeInodesPct * 1_000_000,
  freeInodesPct,
});

describe("classifyDiskInfraFault — post-suite ENOSPC attribution", () => {
  it("classifies repeated ENOSPC while a persistent low-space filesystem remains below the floor", () => {
    const output = Array.from(
      { length: DISK_ENOSPC_MIN_OCCURRENCES },
      () => "Error: ENOSPC: no space left on device, write '/tmp/pcv/result.json'",
    ).join("\n");
    const fault = classifyDiskInfraFault(output, {
      before: [diskSnapshot("/tmp", 346 * 1024 ** 3, 0.0464)],
      after: [diskSnapshot("/tmp", 0, 0)],
      policy: DISK_POLICY,
    });

    expect(fault).toMatchObject({
      kind: "disk-space-exhausted",
      occurrences: DISK_ENOSPC_MIN_OCCURRENCES,
      paths: ["/tmp"],
      crossedLowSpaceFloor: false,
    });
    expect(fault?.note).toMatch(/must NOT be triaged/);
  });

  it("classifies a measured crossing of the low-space floor even without an ENOSPC line", () => {
    const fault = classifyInfraFault(
      "Test Files 2242 failed | 313 passed\nAssertionError: expected 1 to be 2",
      {
        before: [diskSnapshot("/tmp", 1_000 * 1024 ** 3, 0.2)],
        after: [diskSnapshot("/tmp", 4 * 1024 ** 3, 0.08)],
        policy: DISK_POLICY,
      },
    );

    expect(fault).toMatchObject({
      kind: "disk-space-exhausted",
      occurrences: 0,
      crossedLowSpaceFloor: true,
    });
  });

  it("does not withdraw a normal code red merely because the host was already low on space", () => {
    const fault = classifyDiskInfraFault(
      " FAIL lib/example.test.ts > ordinary assertion failure",
      {
        before: [diskSnapshot("/tmp", 346 * 1024 ** 3, 0.0464)],
        after: [diskSnapshot("/tmp", 340 * 1024 ** 3, 0.0456)],
        policy: DISK_POLICY,
      },
    );

    expect(fault).toBeNull();
  });

  it("does not count passing ENOSPC selftest narration as a write failure below the floor", () => {
    const output = Array.from(
      { length: DISK_ENOSPC_MIN_OCCURRENCES },
      () =>
        "  ✓ require_free_gb refuses an impossible requirement with exit 28 (ENOSPC)",
    ).join("\n");
    const fault = classifyDiskInfraFault(output, {
      before: [diskSnapshot("/tmp", 158.8 * 1024 ** 3, 0.0213, 0.98)],
      after: [diskSnapshot("/tmp", 148.2 * 1024 ** 3, 0.0199, 0.9786)],
      policy: DISK_POLICY,
    });

    expect(fault).toBeNull();
  });

  it("does not treat an isolated ENOSPC mention as infrastructure without low-space evidence", () => {
    const output = Array.from(
      { length: DISK_ENOSPC_MIN_OCCURRENCES },
      () => "FAIL test title mentions ENOSPC but the assertion is ordinary",
    ).join("\n");
    const fault = classifyDiskInfraFault(output, {
      before: [diskSnapshot("/tmp", 1_000 * 1024 ** 3, 0.2)],
      after: [diskSnapshot("/tmp", 900 * 1024 ** 3, 0.18)],
      policy: DISK_POLICY,
    });

    expect(fault).toBeNull();
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

describe("control: the negative cases above are falsifying, not decorative", () => {
  /**
   * The obvious wrong implementation — count the word, ignore the path — kept here
   * PERMANENTLY rather than mutating the shared tree to prove falsifiability (the repo's
   * "a MODULE you import" tier). If a future edit relaxes the path anchor back toward this,
   * the assertions below stop distinguishing the two and this control fails.
   */
  const naiveSubstringClassifier = (output: string) =>
    (output.match(/ENOENT/g)?.length ?? 0) >= INFRA_FAULT_MIN_OCCURRENCES
      ? { kind: "vite-node-cache-vanished" as const }
      : null;

  const testTitleOutput = Array.from(
    { length: 40 },
    (_, i) =>
      ` FAIL  lib/release/green-checkpoint-real-deps.test.ts > ENOENT retry budget still surfaces a real error (${i})`,
  ).join("\n");

  it("the naive substring classifier WOULD withdraw the verdict on ENOENT-named test titles", () => {
    // Calibration: the fixture really does carry enough ENOENTs to trip a substring rule, so
    // the real classifier's `null` above comes from the path anchor and not from a thin fixture.
    expect(naiveSubstringClassifier(testTitleOutput)).not.toBeNull();
    expect(classifyInfraFault(testTitleOutput)).toBeNull();
  });

  it("…and both agree on the genuine incident signature (the anchor costs no true positives)", () => {
    const real = Array.from({ length: INFRA_FAULT_MIN_OCCURRENCES }, (_, i) =>
      humanForm(ROOT_1, "ssr", `${"0".repeat(39)}${i}`),
    ).join("\n");

    expect(naiveSubstringClassifier(real)).not.toBeNull();
    expect(classifyInfraFault(real)).not.toBeNull();
  });
});
