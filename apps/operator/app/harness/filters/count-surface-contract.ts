import type { CountEvidence } from "./count-evidence";

/** The four audit dispositions from plan D-006. */
export type CountSurfaceClass =
  | "active-defect"
  | "latent-defect"
  | "window-disclosure"
  | "control";

export interface CountSurfaceBehaviorGuard {
  /** Plan item that armed the domain's large-corpus behavioral battery. */
  planItem: `P-${string}`;
  /** Test file that exercises the reusable seeded-corpus assertion. */
  testPath: string;
}

export interface CountSurfaceDeclaration {
  id: string;
  label: string;
  classification: CountSurfaceClass;
  /** Honest evidence currently rendered before/after migration. */
  evidence: CountEvidence["kind"];
  /** Primary implementation files from the audited surface matrix. */
  sourcePaths: readonly string[];
  /** Load-bearing cap for domains that owe the large-corpus battery. */
  pageCap?: number;
  /** Filled, and removed from the shrink-only baseline, when a domain migrates. */
  behaviorGuard?: CountSurfaceBehaviorGuard;
  /** Production useColumnFilters call counts owned by this surface, by file. */
  columnFilterCalls?: Readonly<Record<string, number>>;
}

/**
 * P-003's executable projection of the plan's audited surface matrix.
 *
 * This is a declaration registry, not a claim that every defect is already
 * migrated. Active/latent entries honestly remain `window` evidence and omit
 * `behaviorGuard` until their owning P-004..P-012 migration lands. The guard
 * test makes that omission a shrink-only baseline and rejects every new
 * useColumnFilters call that is absent here.
 */
export const COUNT_SURFACE_DECLARATIONS: readonly CountSurfaceDeclaration[] = [
  {
    id: "work-items",
    label: "Work Items list",
    classification: "active-defect",
    evidence: "corpus",
    pageCap: 500,
    sourcePaths: ["apps/operator/app/adv/harnesses/WorkItemsPanel.tsx"],
    behaviorGuard: {
      planItem: "P-004",
      testPath:
        "packages/operator-core/lib/sync-resolver/work-items-list-query.integration.test.ts",
    },
  },
  {
    id: "dependency-graph",
    label: "Dependency Graph",
    classification: "active-defect",
    evidence: "corpus",
    pageCap: 500,
    sourcePaths: ["apps/operator/app/adv/harnesses/DepGraphPanel.tsx"],
    behaviorGuard: {
      planItem: "P-004",
      testPath:
        "packages/operator-core/lib/sync-resolver/work-items-list-query.integration.test.ts",
    },
  },
  {
    id: "observations",
    label: "Observations",
    classification: "active-defect",
    evidence: "corpus",
    pageCap: 200,
    sourcePaths: ["apps/operator/app/adv/create/ObservationsPanel.tsx"],
    behaviorGuard: {
      planItem: "P-005",
      testPath:
        "packages/operator-core/lib/sync-resolver/learning-observations-query.integration.test.ts",
    },
  },
  {
    id: "learning-improve",
    label: "Learning Improve",
    classification: "active-defect",
    evidence: "window",
    pageCap: 500,
    sourcePaths: ["apps/operator-vite/src/components/adv/LearningTab.tsx"],
    columnFilterCalls: {
      "apps/operator-vite/src/components/adv/LearningTab.tsx": 1,
    },
  },
  {
    id: "learning-retain",
    label: "Learning Retain",
    classification: "active-defect",
    evidence: "window",
    pageCap: 100,
    sourcePaths: ["apps/operator-vite/src/components/adv/LearningTab.tsx"],
  },
  {
    id: "agent-runs",
    label: "Agent Runs history",
    classification: "active-defect",
    evidence: "window",
    pageCap: 2_000,
    sourcePaths: ["apps/operator/app/adv/harnesses/AdvAgentsPanel.tsx"],
  },
  {
    id: "rubric-history",
    label: "Rubric detail and scorecard history",
    classification: "active-defect",
    evidence: "corpus",
    pageCap: 500,
    sourcePaths: ["apps/operator/app/_components/RubricDetailPanel.tsx"],
    behaviorGuard: {
      planItem: "P-009",
      testPath: "packages/operator-core/lib/scorecards.integration.test.ts",
    },
  },
  {
    id: "sessions-history",
    label: "Sessions history",
    classification: "active-defect",
    evidence: "window",
    pageCap: 200,
    sourcePaths: ["apps/operator/app/adv/sessions/AdvSessionsClient.tsx"],
  },
  {
    id: "design-feature-queue",
    label: "Design feature queue",
    classification: "latent-defect",
    evidence: "window",
    pageCap: 500,
    sourcePaths: ["apps/operator/app/design/[slug]/DesignDashboard.tsx"],
  },
  {
    id: "cupboard",
    label: "Cupboard web and TUI",
    classification: "latent-defect",
    evidence: "window",
    pageCap: 100,
    sourcePaths: ["apps/operator/app/cupboard/CupboardClient.tsx"],
  },
  {
    id: "recent-logs",
    label: "Recent logs",
    classification: "window-disclosure",
    evidence: "window",
    sourcePaths: ["apps/operator/app/adv/harnesses/AdvLogsPanel.tsx"],
    columnFilterCalls: {
      "apps/operator/app/adv/harnesses/AdvLogsPanel.tsx": 1,
    },
  },
  {
    id: "git-history",
    label: "Git history",
    classification: "window-disclosure",
    evidence: "window",
    sourcePaths: ["apps/operator/app/adv/harnesses/AdvGitPanel.tsx"],
  },
  {
    id: "coordination-history",
    label: "Coordination and conversations history",
    classification: "window-disclosure",
    evidence: "window",
    sourcePaths: [
      "apps/operator-vite/src/components/adv/AdvConversationsTab.tsx",
    ],
    columnFilterCalls: {
      "apps/operator-vite/src/components/adv/AdvConversationsTab.tsx": 1,
    },
  },
  {
    id: "members-agents",
    label: "Members and agents working view",
    classification: "control",
    evidence: "corpus",
    sourcePaths: [
      "apps/operator/app/adv/harnesses/MemberWorkPanel.tsx",
      "apps/operator/app/adv/harnesses/AdvAgentsPanel.tsx",
    ],
    columnFilterCalls: {
      "apps/operator/app/adv/harnesses/MemberWorkPanel.tsx": 1,
      "apps/operator/app/adv/harnesses/AdvAgentsPanel.tsx": 1,
    },
  },
  {
    id: "plans-attention",
    label: "Plans and attention queue",
    classification: "control",
    evidence: "corpus",
    sourcePaths: ["apps/operator/app/admin/plans/PlansClient.tsx"],
  },
  {
    id: "rubrics-overview",
    label: "Rubrics overview",
    classification: "control",
    evidence: "corpus",
    sourcePaths: ["apps/operator/app/_components/RubricsPanel.tsx"],
  },
  {
    id: "user-memory",
    label: "User memory",
    classification: "control",
    evidence: "window",
    sourcePaths: ["apps/operator-vite/src/components/adv/MemoryHealthCard.tsx"],
  },
  {
    id: "coverage-hud-admin-dossier",
    label: "Coverage, HUD, table admin, and dossier capped sections",
    classification: "control",
    evidence: "corpus",
    sourcePaths: ["apps/operator/app/adv/harnesses/DetailPanel.tsx"],
  },
  {
    id: "pot-content-contributors-rosters",
    label: "Pot content, contributors, and live rosters",
    classification: "control",
    evidence: "corpus",
    sourcePaths: ["apps/operator/app/adv/harnesses/PotContentPanel.tsx"],
  },
];

/**
 * Known domain migrations that have not armed the behavioral battery yet.
 * REMOVE entries as P-004..P-012 land. Never add a new surface here: a new
 * bounded count surface must ship with its behavior guard already armed.
 */
export const UNARMED_COUNT_BEHAVIOR_BASELINE = [
  "agent-runs",
  "cupboard",
  "design-feature-queue",
  "learning-improve",
  "learning-retain",
  "sessions-history",
] as const;
