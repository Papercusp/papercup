/**
 * Recurrence guard for EI-21749232930340104.
 *
 * A clean-room VM created without a NETWORK TAG is covered by no firewall rule, so IAP's
 * tcp:22 probe is dropped by the implied-deny. The instance still reaches RUNNING — only the
 * SSH path is dead — so the symptom is a full 12-minute `awaitOsLogin` timeout whose message
 * names OS Login and points the reader at IAM instead of the firewall. That cost a real
 * billable boot on the P-046 r8 acceptance run.
 *
 * These tests pin BOTH halves of the fix, because either alone still fails late: the instance
 * must carry the tag, and a rule admitting that tag must be verified BEFORE the boot.
 */
import { describe, expect, it } from "vitest";

import {
  CLEAN_ROOM_NETWORK_TAG,
  IAP_TCP_FORWARDING_SOURCE_RANGE,
  assertIapSshReachable,
  buildCleanRoomInstanceCreateArgs,
  iapSshRuleAdmits,
  // @ts-expect-error -- side-effect-free .mjs argv builder, deliberately untyped
} from "../../bin/gcp-clean-room-args.mjs";

const BASE = {
  instanceName: "pc-bootstrap-acc-test",
  projectId: "active-alcove-504205-q3",
  zone: "us-central1-a",
  imageName: "ubuntu-2404-lts-amd64-v20260101",
  imageProject: "ubuntu-os-cloud",
  subnetwork: "pc-test-subnet",
  fixtureId: "fixture-1",
};

/** A rule that DOES admit the clean room; each negative case perturbs exactly one field. */
const ADMITTING_RULE = Object.freeze({
  direction: "INGRESS",
  disabled: false,
  sourceRanges: [IAP_TCP_FORWARDING_SOURCE_RANGE],
  allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
  targetTags: [CLEAN_ROOM_NETWORK_TAG],
});

describe("clean-room instance argv carries a network tag", () => {
  it("passes --tags with the clean-room tag", () => {
    const argv = buildCleanRoomInstanceCreateArgs(BASE) as string[];
    expect(argv).toContain(`--tags=${CLEAN_ROOM_NETWORK_TAG}`);
  });

  it("does not rely on --labels to select the instance for firewall rules", () => {
    // Labels are inert metadata. This asserts the tag is a SEPARATE flag, which is the
    // whole defect: the argv used to carry labels naming the role and no tags at all.
    const argv = buildCleanRoomInstanceCreateArgs(BASE) as string[];
    const labels = argv.find((a) => a.startsWith("--labels="));
    expect(labels).toBeDefined();
    expect(argv.some((a) => a.startsWith("--tags="))).toBe(true);
  });
});

describe("iapSshRuleAdmits", () => {
  it("accepts a rule targeting the clean-room tag from the IAP range on tcp:22", () => {
    expect(iapSshRuleAdmits(ADMITTING_RULE)).toBe(true);
  });

  it("accepts an untargeted rule, which applies to every instance in the network", () => {
    expect(iapSshRuleAdmits({ ...ADMITTING_RULE, targetTags: [] })).toBe(true);
  });

  it("accepts a port RANGE that contains 22", () => {
    const rule = { ...ADMITTING_RULE, allowed: [{ IPProtocol: "tcp", ports: ["20-25"] }] };
    expect(iapSshRuleAdmits(rule)).toBe(true);
  });

  it("REJECTS a rule scoped to a different tag — the exact production misconfiguration", () => {
    // pc-p046-canary-02-…-iap targeted the CANARY's tag, so it never covered the clean room.
    const rule = { ...ADMITTING_RULE, targetTags: ["pc-host-p046-canary-02-a810e759"] };
    expect(iapSshRuleAdmits(rule)).toBe(false);
  });

  it("REJECTS a rule whose source range is not the IAP range", () => {
    const rule = { ...ADMITTING_RULE, sourceRanges: ["10.0.0.0/8"] };
    expect(iapSshRuleAdmits(rule)).toBe(false);
  });

  it("REJECTS a rule that does not allow tcp:22", () => {
    const rule = { ...ADMITTING_RULE, allowed: [{ IPProtocol: "tcp", ports: ["443"] }] };
    expect(iapSshRuleAdmits(rule)).toBe(false);
  });

  it("REJECTS a disabled rule", () => {
    expect(iapSshRuleAdmits({ ...ADMITTING_RULE, disabled: true })).toBe(false);
  });

  it("REJECTS an EGRESS rule", () => {
    expect(iapSshRuleAdmits({ ...ADMITTING_RULE, direction: "EGRESS" })).toBe(false);
  });

  it("REJECTS a service-account-scoped rule, which cannot match a --no-service-account VM", () => {
    const rule = { ...ADMITTING_RULE, targetTags: [], targetServiceAccounts: ["x@y.iam.gserviceaccount.com"] };
    expect(iapSshRuleAdmits(rule)).toBe(false);
  });
});

describe("assertIapSshReachable", () => {
  it("returns silently when some rule admits the clean room", () => {
    expect(() => assertIapSshReachable([{ direction: "EGRESS" }, ADMITTING_RULE], {})).not.toThrow();
  });

  it("throws on an EMPTY rule set rather than letting the boot proceed", () => {
    expect(() => assertIapSshReachable([], { networkName: "n", projectId: "p" })).toThrow(/admits IAP SSH/);
  });

  it("names the exact repair command, so the refusal is actionable without a lookup", () => {
    let message = "";
    try {
      assertIapSshReachable([], { networkName: "my-net", projectId: "my-proj" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("gcloud compute firewall-rules create");
    expect(message).toContain("--network=my-net");
    expect(message).toContain("--project=my-proj");
    expect(message).toContain(`--source-ranges=${IAP_TCP_FORWARDING_SOURCE_RANGE}`);
    expect(message).toContain(`--target-tags=${CLEAN_ROOM_NETWORK_TAG}`);
  });

  it("throws for the real production rule set, reproducing the failed r8 acceptance run", () => {
    const productionRules = [
      {
        name: "pc-p046-canary-02-a810e759-iap",
        direction: "INGRESS",
        sourceRanges: ["35.235.240.0/20"],
        allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
        targetTags: ["pc-host-p046-canary-02-a810e759"],
      },
    ];
    expect(() =>
      assertIapSshReachable(productionRules, { networkName: "pc-p046-canary-02-a810e759-net" }),
    ).toThrow(/admits IAP SSH/);
  });
});
