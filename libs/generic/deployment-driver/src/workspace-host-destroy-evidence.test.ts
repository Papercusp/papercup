import { describe, expect, it } from "vitest";
import type { WorkspaceHostInitializationCanaryEvidence } from "./workspace-host-initialization";
import {
  WorkspaceHostDestroyEvidenceError,
  adaptWorkspaceHostDestroyCanaryEvidence,
  type AdaptWorkspaceHostDestroyEvidenceInput,
} from "./workspace-host-destroy-evidence";

const channels = {
  cloud: {
    bound: true,
    rotated: true,
    previousBindingRevoked: true,
    reconnected: true,
  },
  git: {
    bound: true,
    rotated: true,
    previousBindingRevoked: true,
    reconnected: true,
  },
  agent: {
    bound: true,
    rotated: true,
    previousBindingRevoked: true,
    reconnected: true,
  },
} as const;

function initialization(): WorkspaceHostInitializationCanaryEvidence {
  return {
    contractVersion: "papercusp-workspace-host-initialization-v1",
    kind: "live",
    runId: "run-1",
    workspaceId: "workspace-1",
    hostId: "host-1",
    observedAt: "2026-08-26T20:00:00.000Z",
    repository: { visibility: "private", cloned: true },
    channels,
    agents: {
      // WI-10002402: the kind each agent's probe table can actually emit.
      claude: { ready: true, verificationKind: "live-inference" },
      codex: { ready: true, verificationKind: "live-inference" },
      omp: { ready: true, verificationKind: "local-inference" },
    },
    backupRestore: {
      authorizationMaterial: "excluded",
      credentialReferences: "excluded",
      reboundChannels: ["cloud", "git", "agent"],
    },
  };
}

function validInput(): AdaptWorkspaceHostDestroyEvidenceInput {
  return {
    expected: {
      runId: "run-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      operationId: "destroy-1",
    },
    initialization: initialization(),
    credentialTeardown: ["cloud", "git", "agent"].map((channel) => ({
      channel: channel as "cloud" | "git" | "agent",
      previousBindingRevoked: true,
      credentialReferenceExcluded: true,
    })),
    teardown: {
      operationId: "destroy-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      startedAt: "2026-08-26T21:00:00.000Z",
      observedAt: "2026-08-26T21:05:00.000Z",
      confirmations: [
        {
          hostId: "host-1",
          providerResourceId: "vm-1",
          confirmedAbsentAt: "2026-08-26T21:04:00.000Z",
          source: "provider-read",
        },
      ],
      orphanCensus: {
        clean: true,
        observedTagged: [],
        untracked: [],
        stillLive: [],
        missingWithoutReceipt: [],
      },
    },
    destroyEvidence: {
      runId: "run-1",
      workspaceId: "workspace-1",
      contractApproval: {
        status: "approved",
        suiteVersion: "workspace-host-provider-contract-v1",
        reportRef: "report-1",
        approvedBy: "reviewer-1",
        approvedAt: "2026-08-26T19:00:00.000Z",
      },
      teardownDeadlineAt: "2026-08-26T22:00:00.000Z",
      budgetEvidenceRef: "budget-1",
      preRunZeroBaseline: {
        cents: 0,
        observedAt: "2026-08-26T19:00:00.000Z",
        providerEvidenceRef: "billing-0",
      },
      costEvidence: [],
    },
  };
}

function problems(
  mutator: (input: AdaptWorkspaceHostDestroyEvidenceInput) => void,
): readonly string[] {
  const input = validInput();
  mutator(input);
  try {
    adaptWorkspaceHostDestroyCanaryEvidence(input);
    throw new Error("expected adapter to reject evidence");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceHostDestroyEvidenceError);
    return (error as WorkspaceHostDestroyEvidenceError).problems;
  }
}

describe("adaptWorkspaceHostDestroyCanaryEvidence", () => {
  it("projects validated caller-supplied destroy evidence without manufacturing observations", () => {
    const input = validInput();
    expect(adaptWorkspaceHostDestroyCanaryEvidence(input)).toEqual(
      input.destroyEvidence,
    );
  });

  it("fails closed on the wrong host identity", () => {
    expect(
      problems((input) => {
        input.teardown.hostId = "host-2";
      }),
    ).toContain("teardown hostId does not match expected host");
  });

  it("fails closed on stale operation identity", () => {
    const result = problems((input) => {
      input.teardown.operationId = "destroy-old";
      input.teardown.confirmations = [
        {
          ...input.teardown.confirmations[0]!,
          confirmedAbsentAt: "2026-08-26T20:00:00.000Z",
        },
      ];
    });
    expect(result).toContain(
      "teardown operationId does not match expected operation",
    );
    expect(
      result.some((problem) => problem.includes("predates the operation")),
    ).toBe(true);
  });

  it("fails closed on incomplete credential teardown", () => {
    expect(
      problems((input) => {
        input.credentialTeardown[1]!.previousBindingRevoked = false;
      }),
    ).toContain("git credential teardown is incomplete");
  });

  it("fails closed when provider absence evidence is missing or the census is non-clean", () => {
    const missing = problems((input) => {
      input.teardown.confirmations = [];
    });
    expect(missing).toContain("provider absence confirmations are missing");

    const nonClean = problems((input) => {
      input.teardown.orphanCensus = {
        ...input.teardown.orphanCensus,
        clean: false,
        observedTagged: [
          {
            resource: { target: "gcp", kind: "vm", providerId: "vm-orphan" },
            tags: {},
          },
        ],
      };
    });
    expect(nonClean).toContain("provider teardown orphan census is not clean");
  });
});
