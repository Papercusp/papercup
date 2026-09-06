import { describe, expect, it } from "vitest";
import { WORKSPACE_HOST_LIFECYCLE_ACTIONS } from "./workspace-host-types";
import {
  WORKSPACE_HOST_INITIALIZATION_INVALIDATING_ACTIONS,
  workspaceHostActionInvalidatesInitialization,
} from "./workspace-host-initialization-validity";

/**
 * The expected classification of EVERY action in the canonical vocabulary.
 *
 * Written out in full on purpose. The point of this map is not to restate the predicate —
 * it is to fail when a NEW lifecycle action is added and nobody decides whether it invalidates
 * the host's initialized state. A test that only asserted the current `true` cases would
 * stay green while a new initialization-invalidating action silently defaulted to "still ready",
 * which is the exact bug this module exists to prevent, one action later.
 */
const EXPECTED: Record<string, boolean> = {
  provision: false, // creates the host; there is no prior initialization to invalidate
  start: false,
  stop: false,
  restart: false, // reboots the SAME boot disk — what was installed is still installed
  snapshot: false,
  repair: true, // refreshes startup metadata and resets the VM; the new bootstrap must finish
  restore: true, // builds a DISTINCT target host that has never been initialized
  upgrade: true, // deletes and recreates the instance from a new image; boot disk is gone
  destroy: false, // the host is going away; readiness is not a question that survives it
  initialize: false, // this IS initialization, so it establishes validity rather than voiding it
};

describe("workspaceHostActionInvalidatesInitialization", () => {
  it("classifies every action in the canonical lifecycle vocabulary", () => {
    // Guards the direction that actually bites: an action added to the vocabulary with no
    // decision recorded here. Compare whole maps so the failure names the missing action.
    const classified = Object.fromEntries(
      WORKSPACE_HOST_LIFECYCLE_ACTIONS.map((action) => [
        action,
        workspaceHostActionInvalidatesInitialization(action),
      ]),
    );
    expect(classified).toEqual(EXPECTED);
  });

  it("declares exactly the initialization-invalidating actions", () => {
    expect(
      [...WORKSPACE_HOST_INITIALIZATION_INVALIDATING_ACTIONS].sort(),
    ).toEqual(["repair", "restore", "upgrade"]);
  });

  it("only names actions that exist in the canonical vocabulary", () => {
    // A typo ('upgade') would otherwise sit here classifying nothing, and every host would
    // keep reporting ready after an invalidating lifecycle action with no test noticing.
    for (const action of WORKSPACE_HOST_INITIALIZATION_INVALIDATING_ACTIONS) {
      expect(WORKSPACE_HOST_LIFECYCLE_ACTIONS).toContain(action);
    }
  });

  it("does not treat an unknown action as invalidating", () => {
    expect(workspaceHostActionInvalidatesInitialization("upgade")).toBe(false);
    expect(workspaceHostActionInvalidatesInitialization("")).toBe(false);
  });
});
