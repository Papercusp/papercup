import { describe, expect, it } from "vitest";
import {
  PRODUCER_HEALTH_CERTIFICATE_VERSION,
  classifyVerifiedWaitTimeout,
  type ProducerHealthCertificate,
  type ProducerHealthObservation,
} from "./verified-wait";

const certificate = (overrides: Partial<ProducerHealthCertificate> = {}): ProducerHealthCertificate => ({
  version: PRODUCER_HEALTH_CERTIFICATE_VERSION,
  producer: { kind: "green-checkpoint", id: "run-42" },
  owner: { ownerId: "su-1", workItemId: "WI-42" },
  issuedAtMs: 1_000,
  lastProgressAtMs: 900,
  lastFireAtMs: null,
  expectedCadenceMs: 500,
  verificationDeadlineMs: 2_000,
  ...overrides,
});

const observation = (overrides: Partial<ProducerHealthObservation> = {}): ProducerHealthObservation => ({
  checkedAtMs: 2_000,
  producerPresent: true,
  lastProgressAtMs: 1_900,
  lastFireAtMs: null,
  completedAtMs: null,
  evidence: { phase: "suite" },
  ...overrides,
});

describe("classifyVerifiedWaitTimeout", () => {
  it("re-awaits a producer with progress newer than the certificate", () => {
    expect(classifyVerifiedWaitTimeout(certificate(), observation())).toMatchObject({
      classification: "progressing",
      nextAction: "re-await",
      producer: { kind: "green-checkpoint", id: "run-42" },
      owner: { ownerId: "su-1", workItemId: "WI-42" },
      evidence: { phase: "suite" },
    });
  });

  it("also treats a fresh authoritative heartbeat as progressing", () => {
    expect(
      classifyVerifiedWaitTimeout(
        certificate({ issuedAtMs: 1_500, lastProgressAtMs: 1_900 }),
        observation({ lastProgressAtMs: 1_900 }),
      ).classification,
    ).toBe("progressing");
  });

  it("re-awaits an intentionally idle producer instead of recommending takeover", () => {
    expect(
      classifyVerifiedWaitTimeout(
        certificate({ issuedAtMs: 1_000, lastProgressAtMs: 900 }),
        observation({ checkedAtMs: 2_000, lastProgressAtMs: 900, state: "idle" }),
      ),
    ).toMatchObject({ classification: "expected-idle", nextAction: "re-await" });
  });

  it("does not turn an unknown producer probe into a takeover", () => {
    expect(
      classifyVerifiedWaitTimeout(
        certificate({ issuedAtMs: 1_000, lastProgressAtMs: 900 }),
        observation({ checkedAtMs: 2_000, lastProgressAtMs: 900, state: "unknown" }),
      ),
    ).toMatchObject({ classification: "unknown", nextAction: "re-await" });
  });

  it("classifies a present producer with no fresh progress as stalled", () => {
    expect(
      classifyVerifiedWaitTimeout(
        certificate({ issuedAtMs: 1_000, lastProgressAtMs: 900 }),
        observation({ checkedAtMs: 2_000, lastProgressAtMs: 900 }),
      ),
    ).toMatchObject({ classification: "stalled", nextAction: "wake-owner-or-takeover" });
  });

  it("classifies a missing producer separately from a stalled producer", () => {
    expect(
      classifyVerifiedWaitTimeout(
        certificate(),
        observation({ producerPresent: false, lastProgressAtMs: null }),
      ),
    ).toMatchObject({ classification: "absent", nextAction: "wake-owner-or-takeover" });
  });

  it("lets authoritative completion win over producer absence", () => {
    expect(
      classifyVerifiedWaitTimeout(
        certificate(),
        observation({ producerPresent: false, completedAtMs: 1_950, lastProgressAtMs: null }),
      ),
    ).toMatchObject({ classification: "already-complete", nextAction: "resume" });
  });

  it("treats a recorded completion-event fire as already complete", () => {
    expect(
      classifyVerifiedWaitTimeout(certificate(), observation({ lastFireAtMs: 1_950 })),
    ).toMatchObject({ classification: "already-complete", nextAction: "resume" });
  });

  it("refuses to turn an early check into a timeout verdict", () => {
    expect(() =>
      classifyVerifiedWaitTimeout(certificate(), observation({ checkedAtMs: 1_999 })),
    ).toThrow(/before the verification deadline/);
  });

  it("rejects a certificate without a usable cadence", () => {
    expect(() =>
      classifyVerifiedWaitTimeout(certificate({ expectedCadenceMs: 0 }), observation()),
    ).toThrow(/finite positive/);
  });
});
