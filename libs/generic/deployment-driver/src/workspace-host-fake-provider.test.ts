import { describe, expect, it } from "vitest";

import {
  fakeWorkspaceHostCapabilities,
  makeFakeWorkspaceHostProvider,
} from "./workspace-host-test-harness";
import type {
  WorkspaceHostProvider,
  WorkspaceHostProviderCapabilities,
} from "./workspace-host-types";

/**
 * The real guarantee of this fix is COMPILE-TIME, and no runtime assertion below can fail if
 * someone makes a capability field optional again. These `@ts-expect-error` lines are the
 * falsifiability control for that: each one is an error only while the shape is genuinely
 * rejected, and tsc reports an UNUSED `@ts-expect-error` as its own error. So if
 * `WorkspaceHostProviderCapabilities` ever again accepts the shapes that caused WI-2144032,
 * this file stops compiling and says so.
 */
// @ts-expect-error - `{}` must never satisfy the capabilities contract: that is the exact
// shape the five fixtures declared, and the cast that hid it is what cost two days of red.
const _rejectsEmptyCapabilities: WorkspaceHostProviderCapabilities = {};
// @ts-expect-error - declaring only `lifecycle` must not be enough either; `discovery` and
// `transportKinds` are required too, and the inline repair to provisioning-runner.test.ts
// omitted both while looking like a fix.
const _rejectsLifecycleOnlyCapabilities: WorkspaceHostProviderCapabilities = {
  lifecycle: {
    start: false,
    stop: false,
    restart: false,
    snapshot: false,
    restore: false,
    upgrade: false,
    repair: false,
    confirmedDestroy: false,
    hostBootstrap: false,
  },
};
void _rejectsEmptyCapabilities;
void _rejectsLifecycleOnlyCapabilities;

/**
 * WI-2144032: `provisioning-runner.integration.test.ts` sat red for two days because its fake
 * providers declared `capabilities: {}` behind `as unknown as WorkspaceHostProvider`. When
 * `lifecycle.hostBootstrap` became load-bearing, the cast erased the compile error that would
 * have named the missing field, and the fixture failed instead as a bare
 * `TypeError: Cannot read properties of undefined (reading 'hostBootstrap')` inside the runner.
 *
 * The real fix is type-level and belongs to tsc: `fakeWorkspaceHostCapabilities` is annotated
 * `WorkspaceHostProviderCapabilities` with no cast, so a newly-required field fails to compile
 * in one place. These tests pin the runtime half — that the builder actually produces the
 * fields the runner reads, and that a fake is never silently missing a method.
 */
describe("fakeWorkspaceHostCapabilities", () => {
  it("declares the lifecycle field whose absence broke the integration fixture", () => {
    const capabilities = fakeWorkspaceHostCapabilities();

    // The exact read at provisioning-runner.ts:773 that threw.
    expect(capabilities.lifecycle.hostBootstrap).toBe(false);
  });

  it("CONTROL: the `capabilities: {}` shape the fixtures used has no such field", () => {
    // Calibration for the assertion above. Without this, a test that merely reads
    // `.lifecycle.hostBootstrap` would also pass against a builder that returned a
    // permissive `any`, so the positive case alone would prove nothing.
    const brokenShape = {} as unknown as ReturnType<
      typeof fakeWorkspaceHostCapabilities
    >;

    expect(() => brokenShape.lifecycle.hostBootstrap).toThrow(TypeError);
  });

  it("populates every capability group, not just the one that broke", () => {
    const capabilities = fakeWorkspaceHostCapabilities();

    // `discovery` and `transportKinds` are required too. The inline repair applied to
    // provisioning-runner.test.ts declared only `lifecycle`, which the cast again hid.
    expect(capabilities.discovery).toEqual({
      scopes: false,
      regions: false,
      sizes: false,
      images: false,
      priceEstimates: false,
    });
    expect(capabilities.transportKinds).toEqual([]);
    expect(Object.values(capabilities.lifecycle).every((v) => v === false)).toBe(
      true,
    );
  });

  it("applies overrides without dropping the sibling defaults", () => {
    const capabilities = fakeWorkspaceHostCapabilities({
      lifecycle: { hostBootstrap: true },
      transportKinds: ["iap"],
    });

    expect(capabilities.lifecycle.hostBootstrap).toBe(true);
    expect(capabilities.lifecycle.confirmedDestroy).toBe(false);
    expect(capabilities.transportKinds).toEqual(["iap"]);
  });

  it("omits `constraints` entirely when not asked for, rather than setting undefined", () => {
    expect("constraints" in fakeWorkspaceHostCapabilities()).toBe(false);
    expect(
      fakeWorkspaceHostCapabilities({ constraints: ["no-gpu"] }).constraints,
    ).toEqual(["no-gpu"]);
  });
});

describe("makeFakeWorkspaceHostProvider", () => {
  it("returns a provider with every interface member present", () => {
    const provider = makeFakeWorkspaceHostProvider({});

    const members: readonly (keyof WorkspaceHostProvider)[] = [
      "validateConnection",
      "listScopes",
      "listRegions",
      "listSizes",
      "listImages",
      "estimatePrice",
      "plan",
      "apply",
      "observe",
      "reconcile",
      "getTransportProfile",
      "attestHealth",
    ];
    for (const member of members) {
      expect(typeof provider[member]).toBe("function");
    }
    expect(provider.target).toBe("gcp");
    expect(provider.capabilities.lifecycle.hostBootstrap).toBe(false);
  });

  it("throws naming the member when a test calls one it did not stub", () => {
    const provider = makeFakeWorkspaceHostProvider({});

    // The point of the throw: an unstubbed method must not answer `undefined` and resurface
    // as an unrelated TypeError deep inside the runner — which is exactly how WI-2144032
    // presented.
    expect(() => provider.attestHealth({} as never, {} as never)).toThrow(
      /'attestHealth' was called but this test did not stub it/,
    );
  });

  it("uses a supplied member instead of the throwing default", async () => {
    const provider = makeFakeWorkspaceHostProvider({
      target: "aws",
      capabilities: fakeWorkspaceHostCapabilities({
        lifecycle: { hostBootstrap: true },
      }),
      observe: async () => "observed" as never,
    });

    expect(provider.target).toBe("aws");
    expect(provider.capabilities.lifecycle.hostBootstrap).toBe(true);
    await expect(
      provider.observe({} as never, {} as never),
    ).resolves.toBe("observed");
  });

  it("carries a non-interface member through to the returned type", () => {
    const provider = makeFakeWorkspaceHostProvider({
      inventoryManagedResources: async () => ({ complete: true as const }),
    });

    // `inventoryManagedResources` is not on WorkspaceHostProvider; the runner probes for it
    // with `'inventoryManagedResources' in provider`. Carrying it through is what lets the
    // destroy fixture drop its cast too.
    expect("inventoryManagedResources" in provider).toBe(true);
    expect(typeof provider.inventoryManagedResources).toBe("function");
  });
});
