export type AdminTestSuiteId =
  | 'desktop-health'
  | 'admin-testing-core'
  | 'admin-testing-extended'
  | 'desktop-performance'
  | 'packaged-readiness'
  | 'memory-core'
  | 'shared-hive-core'
  | 'ai-explore-prompts';

export type AdminTestStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type AdminTestRunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface AdminTestSuiteSpec {
  id: AdminTestSuiteId;
  label: string;
  hint: string;
  description: string;
  runner: 'tauri' | 'host' | 'mixed';
  estimatedSeconds: number;
  safeDefault: boolean;
  tags: string[];
}

export interface AdminTestCheckResult {
  suiteId: AdminTestSuiteId;
  id: string;
  label: string;
  status: AdminTestStatus;
  expected: string;
  actual: string;
  durationMs: number;
  details?: string[];
}

export interface AdminTestSuiteProgress {
  suiteId: AdminTestSuiteId;
  checkId: string;
  label: string;
  index: number;
  total: number;
}

export interface AdminTestSuiteDone {
  suiteId: AdminTestSuiteId;
  label: string;
  status: AdminTestStatus;
  durationMs: number;
  counts: Record<AdminTestStatus, number>;
}

export interface AdminTestLogEntry {
  id: number;
  suiteId: AdminTestSuiteId | 'system';
  level: 'info' | 'warn' | 'error';
  line: string;
  ts: number;
}

export interface AdminTestRunSnapshot {
  runId: string;
  selection: AdminTestSuiteId | 'all-safe';
  status: AdminTestRunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  results: AdminTestCheckResult[];
  summaries: Record<string, AdminTestSuiteDone>;
  progressBySuite: Record<string, AdminTestSuiteProgress>;
  logs: AdminTestLogEntry[];
}

export const ADMIN_TEST_SUITES: AdminTestSuiteSpec[] = [
  {
    id: 'desktop-health',
    label: 'Desktop health',
    hint: 'bridge, console, assets',
    description: 'Checks that the Tauri bridge is healthy, the operator is really running inside Tauri, the console stays clean, and required voice-runtime assets resolve.',
    runner: 'tauri',
    estimatedSeconds: 8,
    safeDefault: true,
    tags: ['tauri', 'health', 'console', 'assets'],
  },
  {
    id: 'desktop-performance',
    label: 'Desktop performance snapshot',
    hint: 'routes, INP, RSS',
    description: 'Measures warm route-settle times, current slow-interaction budget, and total desktop memory usage from inside the Tauri desktop shell.',
    runner: 'mixed',
    estimatedSeconds: 18,
    safeDefault: false,
    tags: ['tauri', 'performance', 'memory'],
  },
  {
    id: 'admin-testing-core',
    label: 'Testing tab core smoke',
    hint: 'live, chaos, routes, packaged',
    description: 'Navigates the core Testing subtabs in the Tauri desktop shell and verifies each one renders its expected headline surface.',
    runner: 'tauri',
    estimatedSeconds: 12,
    safeDefault: true,
    tags: ['tauri', 'smoke', 'testing-tab'],
  },
  {
    id: 'admin-testing-extended',
    label: 'Testing tab extended smoke',
    hint: 'AI Explore + LLM',
    description: 'Exercises the heavyweight Testing subtabs that are most likely to regress or restart the shell under memory pressure.',
    runner: 'tauri',
    estimatedSeconds: 12,
    safeDefault: false,
    tags: ['tauri', 'smoke', 'testing-tab', 'heavy'],
  },
  {
    id: 'packaged-readiness',
    label: 'Packaged runner readiness',
    hint: 'tauri-driver + wdio prereqs',
    description: 'Verifies that the packaged-binary performance runner can execute: tauri-driver present, WebKit WebDriver present, wdio deps installed, packaged binary present, and smoke selector still valid.',
    runner: 'host',
    estimatedSeconds: 5,
    safeDefault: false,
    tags: ['packaged', 'wdio', 'tauri-driver'],
  },
  {
    id: 'memory-core',
    label: 'Memory system',
    hint: 'mem0 round-trip, tenancy, TTL',
    description: 'End-to-end check of the mem0 memory system: pgvector + client + embedder, per-user / workspace-shared scoping, CRUD round-trip, TTL cleanup, pre-turn injection, feedback signal, performance budgets. Requires an embedder (OpenAI key OR local transformers).',
    runner: 'host',
    estimatedSeconds: 30,
    safeDefault: false,
    tags: ['memory', 'mem0', 'pgvector'],
  },
  {
    id: 'shared-hive-core',
    label: 'Shared Hive federation',
    hint: 'topic, authority, locks, admission',
    description: 'End-to-end check of the Shared Hive federation core: the Hive-pubkey topic re-key, Ed25519 hive identity, the per-Hive lock-authority election + file-claim routing (P-009), the instant lock-handover event fold (P-015), the work-item claim/replica seams, and the real shared_presence election + per-Hive admission union (P-006) against Postgres. Composes the shipped federation modules — a regression turns a check red. Writes are confined to a synthetic, run-scoped workspace and swept after.',
    runner: 'host',
    estimatedSeconds: 10,
    safeDefault: false,
    tags: ['shared-hive', 'federation', 'authority', 'locks', 'admission'],
  },
  {
    id: 'ai-explore-prompts',
    label: 'AI Explore prompts',
    hint: 'preconfigured LLM workflows',
    description: 'Runs a small opt-in set of preconfigured prompts through the same AI Explore Stagehand backend used by the Testing tab, reporting steps, tokens, cost, and failures.',
    runner: 'mixed',
    estimatedSeconds: 90,
    safeDefault: false,
    tags: ['ai', 'llm', 'stagehand', 'prompts'],
  },
];

export const ADMIN_TEST_SUITE_IDS = ADMIN_TEST_SUITES.map((suite) => suite.id) as AdminTestSuiteId[];
