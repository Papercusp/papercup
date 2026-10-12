/**
 * psu --resume onto a different backend — the tree half of acceptance bar R-10
 * (plan consult-backed-parking-2026-10-12, P-010 / P-011, D-009).
 *
 * R-10 is proven LIVE (the P-013 staging matrix cites a delivered session_ports
 * row and the target CLI's native transcript per pair). This file pins the
 * launcher decisions that come before any port is prepared: which backends the
 * interactive picker offers, and that every ordered cross-backend pair resolves
 * to a session port rather than a refusal.
 *
 * Root cause pinned here: chooseResumeTarget built its picker with
 * `session.agent === "claude" ? AGENTS : [session.agent]`, so a Codex or OMP
 * session was never offered another backend even though the session-port
 * service prepares claude, codex and omp sources alike.
 */
import { describe, expect, it } from "vitest";
import {
  AGENTS,
  resolveResumeTarget,
  resumePickerBackendsFor,
} from "../scripts/psu-launcher.mjs";

const BACKENDS = ["claude", "codex", "omp"] as const;
type Backend = (typeof BACKENDS)[number];

function trackedSession(agent: Backend | undefined) {
  return {
    id: 42,
    sessionId: "bb06937a-2054-4f27-945b-225b84dc3ccb",
    agent,
    role: null,
    workspaceId: "papercusp-workspace",
    coordOwnerId: "su-source-owner",
    cwd: "/repo",
    planSlug: "the-plan",
  };
}

const CROSS_PAIRS: Array<[Backend, Backend]> = BACKENDS.flatMap((source) =>
  BACKENDS.filter((target) => target !== source).map(
    (target) => [source, target] as [Backend, Backend],
  ),
);

describe("psu --resume cross-backend target resolution (R-10)", () => {
  it("covers exactly the six ordered pairs among the launcher's backends", () => {
    expect([...AGENTS].sort()).toEqual([...BACKENDS].sort());
    expect(CROSS_PAIRS).toHaveLength(6);
  });

  it.each(BACKENDS)(
    "the interactive picker offers EVERY backend to a %s source, its own first",
    (agent) => {
      const backends = resumePickerBackendsFor(trackedSession(agent));
      expect(backends[0]).toBe(agent);
      expect([...backends].sort()).toEqual([...BACKENDS].sort());
    },
  );

  it.each(CROSS_PAIRS)(
    "a %s source picked onto %s resolves to a session port, never a refusal",
    (sourceAgent, targetAgent) => {
      expect(
        resolveResumeTarget(
          trackedSession(sourceAgent),
          {},
          { targetAgent, modelSpec: null },
        ),
      ).toMatchObject({ operation: "port", sourceAgent, targetAgent });
    },
  );

  it.each(CROSS_PAIRS)(
    "a scripted %s resume with --agent=%s also resolves to a session port",
    (sourceAgent, targetAgent) => {
      // Unattended Codex launches must name their model (CodexModelPolicyError
      // otherwise — see the control below), so the scripted Codex leg passes one.
      const model = targetAgent === "codex" ? "sol:high" : undefined;
      expect(
        resolveResumeTarget(trackedSession(sourceAgent), {
          agent: targetAgent,
          picker: false,
          ...(model ? { model } : {}),
        }),
      ).toMatchObject({ operation: "port", sourceAgent, targetAgent });
    },
  );

  it.each(["claude", "omp"] as const)(
    "CONTROL: a scripted %s→codex resume with no model is refused with its cause before any port is prepared",
    (sourceAgent) => {
      expect(() =>
        resolveResumeTarget(trackedSession(sourceAgent), {
          agent: "codex",
          picker: false,
        }),
      ).toThrow(/Codex model is required/);
    },
  );

  it.each(BACKENDS)(
    "CONTROL: a %s source kept on its own backend stays a native resume",
    (agent) => {
      expect(
        resolveResumeTarget(
          trackedSession(agent),
          {},
          { targetAgent: agent, modelSpec: null },
        ),
      ).toMatchObject({ operation: "native", sourceAgent: agent, targetAgent: agent });
    },
  );

  it("CONTROL: an unknown source backend still gets the full list, never an empty menu", () => {
    expect([...resumePickerBackendsFor(trackedSession(undefined))].sort()).toEqual(
      [...BACKENDS].sort(),
    );
  });
});
