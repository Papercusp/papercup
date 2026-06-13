/**
 * testing-domains-registry.ts — the operator's /admin/testing registry barrel.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24 (P-002); split in Phase B
 * (P-010/P-011) of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * The portable `routes` domain — the one that applies to any project —
 * lives in `@papercusp/testing-shell` as `universalDomains` (pure data);
 * this file resolves its `endpoints` role against the operator's own repo
 * (OPERATOR_ROLE_GLOBS) and registers it. The Papercusp-runtime-bound
 * test-runs / live / chaos / ai moved here from the lib (they can't run
 * against a non-Papercusp project as-is — D-002 option b), alongside the 16
 * other Papercusp-only domains — 20 in all (testing-shell-cross-project D-007).
 *
 * Importing this module side-effect-registers all 21 domains. The four
 * /admin/testing endpoint routes (P-003) side-effect-import it to populate
 * getTestDomain / listTestDomains; the SPA's left-rail tab list is
 * hardcoded in operator-vite's TestingClient (P-006a) and does not read
 * this file.
 *
 * Globs are repo-relative POSIX. Glob walk happens server-side at request
 * time (P-003) — no checked-in catalog to drift.
 *
 * Tier groupings (the 16 here): `quick` (memory, packaged), `domain`
 * (per-domain surfaces + llm), `surface` (transport, docs). The
 * generalized 5 carry tier `generalized`.
 */

import { defineTestDomain, getTestDomain, universalDomains, applyRoleGlobs, type TestDomain } from './testing-domains';

// The operator's role→globs map for the lib's universal domains: it supplies
// the concrete endpoint-test paths the lib leaves as the 'endpoints' role
// (testing-shell-cross-project D-007). applyRoleGlobs fills routes' globs so
// /admin/testing (and the registered Map) resolve against the operator repo.
const OPERATOR_ROLE_GLOBS: Record<string, string[]> = {
  endpoints: ['packages/operator-core/lib/endpoint-route/__tests__/**/*.test.ts'],
};

/** The lib's universal domains, resolved against the operator's own repo. */
const operatorUniversal: TestDomain[] = applyRoleGlobs(universalDomains, OPERATOR_ROLE_GLOBS);

// Register the universal domains (role-resolved) into the shared Map so
// /admin/testing's getTestDomain / listTestDomains see them.
for (const d of operatorUniversal) defineTestDomain(d);

/* ---------------------------------------------------------------- *
 * Papercusp-only domains (20). The portable `routes` domain lives in the lib
 * (@papercusp/testing-shell, universalDomains). The Papercusp-runtime-bound
 * test-runs/live/chaos/ai used to live there too but moved here — they can't
 * run against a non-Papercusp project as-is (D-002 option b; generalizing
 * them to drive each project's base URL is a deferred follow-up).
 * ---------------------------------------------------------------- */

// — Moved from the lib (formerly the generalized tier; now Papercusp 'quick') —
defineTestDomain({
  id: 'test-runs',
  label: 'Test Runs',
  description: 'Suite orchestrator: start / poll / cancel named suites.',
  tier: 'quick',
  sections: [
    {
      id: 'all',
      label: 'Suites',
      description: 'All admin-test-suite runs.',
      runners: [{ kind: 'admin-suite', suiteId: 'desktop-health' }],
    },
  ],
});

// Operator desktop vitals (LiveMetricsTab). Renamed `live` → `vitals` so the
// universal in-page observer (live-web, from buildUniversalTesting) owns the
// generic "Live" slot — universal-testing-domains-generic Phase 6.
defineTestDomain({
  id: 'vitals',
  label: 'Live metrics',
  description: 'Operator desktop vitals: interactions, console, layout, unhandled errors.',
  tier: 'quick',
  sections: [
    { id: 'all', label: 'Observers', globs: ['apps/operator/app/admin/testing/_lib/vitals-*.test.ts'] },
  ],
});

// The interactive Chaos panel is now the universal chaos-desktop (lib
// ChaosDesktopPanel via buildUniversalTesting); this domain keeps the recorder
// test-glob attached to the matching `chaos-desktop` id so the contract/harness
// view stay consistent.
defineTestDomain({
  id: 'chaos-desktop',
  label: 'Chaos (desktop)',
  description: 'In-app perf-recorder clicker that drives the Tauri shell looking for crashes.',
  tier: 'quick',
  sections: [
    { id: 'host', label: 'Recorder host', globs: ['apps/operator/app/admin/testing/_lib/chaos-*.test.ts'] },
  ],
});

// The interactive AI Explore panel is now the universal ai-explore (lib
// AiExplorePanel via buildUniversalTesting); this domain keeps the prompts suite
// attached to the matching `ai-explore` id.
defineTestDomain({
  id: 'ai-explore',
  label: 'AI Explore',
  description: 'Stagehand LLM walk over admin routes.',
  tier: 'quick',
  sections: [
    {
      id: 'prompts',
      label: 'Prompts',
      runners: [{ kind: 'admin-suite', suiteId: 'ai-explore-prompts' }],
    },
  ],
});

defineTestDomain({
  id: 'memory',
  label: 'Memory',
  description: 'mem0 pgvector round-trip + memory-core suite + CRUD probe.',
  tier: 'quick',
  sections: [
    { id: 'core', label: 'Health', globs: ['packages/operator-core/lib/memory/**/*.test.ts'] },
    {
      id: 'live',
      label: 'Live',
      description:
        'Live session-extraction round-trip on the anthropic-direct transport (mem0-extraction-via-claude-session P-007): ' +
        'remember → Haiku-extracted facts → paraphrase-searchable, in an isolated PG schema. ' +
        'Needs a Claude session + PG + embedder key; exits 2 (skip) without a usable session.',
      runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/memory/session-extraction-live.ts'],
          label: 'session-extraction round-trip (live Claude session)',
        },
      ],
    },
  ],
});

// learning-packs-2026-06-11: the Learning Packs feature end-to-end — pack
// format/seeding/management, the hive memory scope + budgeted injection, the
// Learnings-view reader, the creation/Comb UI, and the worker's
// pre-publication review pipeline. (hive-scope/injection also surface under
// the Memory domain's core glob — the overlap is deliberate: this row is the
// per-feature view.)
defineTestDomain({
  id: 'learnings',
  label: 'Learnings',
  description: 'Learning packs: format/seed/manage, hive memory scope, Learnings UI, Comb review pipeline.',
  tier: 'domain',
  sections: [
    {
      id: 'packs',
      label: 'Packs core',
      description: 'Pack format + loader, default-pack content pin, seeding, install/uninstall/upgrade/sweep + conflict review.',
      globs: ['packages/operator-core/lib/learning-packs/**/*.test.ts'],
    },
    {
      id: 'hive-memory',
      label: 'Hive memory',
      description: 'hive:<slug> scope resolution + budgeted pre-turn injection (pack-muting-aware).',
      globs: [
        'packages/operator-core/lib/memory/hive-scope.test.ts',
        'packages/operator-core/lib/memory/injection.test.ts',
      ],
    },
    {
      id: 'reader',
      label: 'Learnings view reader',
      globs: ['packages/operator-core/lib/sync-resolver/learning-hive-read.test.ts'],
    },
    {
      id: 'ui',
      label: 'UI',
      description: 'Creation pack picker + seeded summary, Learning tab, Comb storefront/detail.',
      globs: [
        'apps/operator/app/harness/__tests__/EntryGithubUrlForm.test.tsx',
        'apps/operator/app/harness/__tests__/CreateHarnessPicker.test.tsx',
        'apps/operator/app/cupboard/__tests__/*.test.tsx',
        'apps/operator-vite/src/components/adv/LearningTab.test.tsx',
      ],
    },
    {
      id: 'comb-review',
      label: 'Comb review',
      description: 'Cupboard worker: listing kinds + the pending→approve/reject pre-publication pipeline (D-007).',
      globs: [
        'apps/operator-public/src/__tests__/review.test.ts',
        'apps/operator-public/src/__tests__/listings.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'packaged',
  label: 'Packaged build',
  description: 'wdio + tauri-driver against the packaged binary.',
  tier: 'quick',
  sections: [
    {
      id: 'wdio',
      label: 'WebdriverIO',
      runners: [{ kind: 'admin-suite', suiteId: 'packaged-readiness' }],
    },
  ],
});

defineTestDomain({
  id: 'llm',
  label: 'LLM',
  description: 'Scenario-driven LLM evaluations (Runs / Scenarios / Targets / Findings).',
  tier: 'domain',
  sections: [
    { id: 'core', label: 'Core', globs: ['packages/operator-core/lib/llm-testing/__tests__/**/*.test.ts'] },
  ],
});

/* ---------------------------------------------------------------- *
 * Tier 2 — domains (12 new tabs)
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'harness',
  label: 'Harness',
  description: 'Harness UI: dock, layouts, fs-watcher, status sweep, branch actions.',
  tier: 'domain',
  sections: [
    { id: 'dock', label: 'Dock', globs: ['apps/operator/app/harness/dock/**/*.test.*'] },
    { id: 'layout', label: 'Layout', globs: [
        'packages/operator-core/lib/dock-layouts.test.ts',
        'packages/operator-core/lib/dock-layout-migrators.test.ts',
      ] },
    { id: 'fs-watcher', label: 'FS watcher', globs: ['packages/operator-core/lib/harness-fs-watcher.test.ts'] },
    { id: 'status-sweep', label: 'Status sweep', globs: ['packages/operator-core/lib/harness-status-sweep.test.ts'] },
    // Catch-the-rest for the harness lib surface (federation/dogfood-specific
    // harness/__tests__ files also appear under the Dogfood domain — overlap
    // is intentional).
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/harness-*.test.ts',
        'packages/operator-core/lib/harness/**/*.test.ts',
        'packages/operator-core/lib/harness-insights/**/*.test.ts',
        'packages/operator-core/lib/harness-state/**/*.test.ts',
      ] },
    { id: 'app', label: 'App UI', globs: ['apps/operator/app/harness/**/*.test.*'] },
    { id: 'e2e', label: 'E2E', globs: [
        'apps/operator/e2e/harness-*.spec.ts',
        'apps/operator/e2e/dock.spec.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'voice',
  label: 'Voice',
  description: 'Voice stack: runtime/capture, cards, engines, persona, spend.',
  tier: 'domain',
  sections: [
    { id: 'runtime', label: 'Runtime', globs: ['apps/operator/app/_components/voice/**/*.test.*'] },
    { id: 'cards', label: 'Cards', globs: ['packages/operator-core/lib/voice-cards/**/*.test.ts'] },
    { id: 'engines', label: 'Engines', globs: [
        'packages/operator-core/lib/voice-engines/**/*.test.ts',
        'packages/operator-core/lib/voice-engines.test.ts',
        'packages/operator-core/lib/voice-engine-health.test.ts',
      ] },
    { id: 'persona', label: 'Persona', globs: [
        'packages/operator-core/lib/op-backstory*.test.ts',
        'packages/operator-core/lib/op-narration-policy.test.ts',
        'packages/operator-core/lib/operator-persona.test.ts',
        'packages/operator-core/lib/classify-utterance-mode.test.ts',
      ] },
    { id: 'spend', label: 'Spend', globs: [
        'packages/operator-core/lib/stt-spend.test.ts',
        'packages/operator-core/lib/tts-spend.test.ts',
        'packages/operator-core/lib/elevenlabs-webhook-auth.test.ts',
      ] },
    // Catch-the-rest for the voice-* lib surface so new voice tests appear
    // without a per-file registry edit.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/voice-*.test.ts',
        'packages/operator-core/lib/voice/**/*.test.ts',
      ] },
    { id: 'smoke', label: 'Smoke', runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-suite-test.mjs'], label: 'el-suite' },
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/voice-stack-check.mjs'], label: 'voice-stack-check' },
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-connect-test.mjs'], label: 'el-connect (live EL creds)' },
        // Static drift check (no live deps): el-agent-sync TOOLS list vs the
        // operator command registry — catches the "client tool not defined" crash class.
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-tools-check.mjs'], label: 'el-tools-check (registry↔TOOLS drift)' },
        // pui/tui real-audio loopback through a PipeWire null-sink (synthetic audio,
        // never touches the box's real defaults). See isolated-audio-e2e-null-sink.
        { kind: 'shell', cmd: 'bash', args: ['apps/tui/scripts/audio-loopback-smoke.sh'], label: 'pui audio loopback (null-sink)' },
      ] },
  ],
});

defineTestDomain({
  id: 'papercusp-su',
  label: 'Papercusp-SU',
  description: 'Superuser surface: coordination, file locking, identity, tools.',
  tier: 'domain',
  sections: [
    {
      id: 'coordination',
      label: 'Coordination',
      description:
        'Messages, plan-events, watermarks, subscriptions, escalations, handoffs, promote — plus the coordination ENGINE underneath: the inbox bus + producer, the coord wire schema, lifecycle rules/rendering/desugaring, and the typed coord-ops programs (ops, triggers, program runner, blueprints e2e).',
      globs: [
        'packages/operator-core/lib/agent-tools/coordination/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agent_chats/**/*.test.ts',
        'packages/operator-core/lib/coord-inbox-bus*.test.ts',
        'packages/operator-core/lib/coord-schema*.test.ts',
        'packages/operator-core/lib/coord-lifecycle/**/*.test.ts',
        'packages/operator-core/lib/coord-ops/**/*.test.ts',
      ],
    },
    {
      id: 'file-locking',
      label: 'File Locking',
      description: 'locks:* tools, file-lock-queue, su-locks integration.',
      globs: [
        'packages/operator-core/lib/agent-tools/locks/**/*.test.ts',
        'packages/operator-core/lib/endpoint-route/__tests__/su-locks*.test.ts',
        // P-030 migrated the legacy su-locks-e2e.sh into:
        'apps/operator/scripts/hooks/omp/__tests__/su-locks-omp.integration.test.ts',
      ],
    },
    {
      id: 'identity',
      label: 'Identity',
      description: 'Auth principals, device JWT, OAuth, audit, rate-limit, power-user.',
      globs: [
        'packages/operator-core/lib/agent-tools/coordination/identity*.test.ts',
        'packages/operator-core/lib/agent-tools/locks/identity*.test.ts',
        'packages/operator-core/lib/auth.test.ts',
        'packages/operator-core/lib/auth-*.test.ts',
        'packages/operator-core/lib/device-jwt*.test.ts',
        'packages/operator-core/lib/power-user-token*.test.ts',
        'packages/operator-core/lib/oauth/**/*.test.ts',
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      description: 'agent-tools surface + agent-mcp dispatch/projection/define-tool. coordination/locks live in their own sections above.',
      globs: [
        'packages/operator-core/lib/agent-tools/__tests__/**/*.test.ts',
        // Explicit positive list — my dependency-free matcher doesn't
        // support extglob negation (!(coordination|locks)).
        'packages/operator-core/lib/agent-tools/agent_chats/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agents/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agent_tools/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/architect/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/autoloop/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/backup/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/chat/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/cross_harness/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/delegates/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/dev/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/docs/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/flags/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/harness/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/hooks/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/memory/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/messages/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/omp/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/operator/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/oracle/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/plugins/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/processes/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/projects/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/roles/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/search/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/instance/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/tasks/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/ui/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/wiki/**/*.test.ts',
        'packages/agent-mcp/**/*.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'backup',
  label: 'Backup',
  description: 'Kopia backup integration: settings, policy, snapshot, self-exclusion.',
  tier: 'domain',
  sections: [
    { id: 'core', label: 'Core', globs: ['packages/operator-core/lib/backup/**/*.test.ts'] },
    { id: 'e2e', label: 'E2E', globs: ['apps/operator/e2e/backups.spec.ts'] },
  ],
});

defineTestDomain({
  id: 'plans',
  label: 'Plans',
  description: 'Plan-tracking surface: authoring, runs, revisions, concurrency, UI.',
  tier: 'domain',
  sections: [
    {
      id: 'authoring',
      label: 'Authoring',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/add-*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/set-*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/new.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/lint.test.ts',
      ],
    },
    {
      id: 'runs',
      label: 'Runs',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/runs.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/launch*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/resume*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/context-bundle.test.ts',
      ],
    },
    {
      id: 'revisions',
      label: 'Revisions',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/revision-*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/diff.test.ts',
      ],
    },
    {
      id: 'concurrency',
      label: 'Concurrency',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/concurrency*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/e2e.test.ts',
      ],
    },
    // Catch-the-rest for the plans tool __tests__ dir + the plans admin UI.
    { id: 'tools', label: 'Tools', globs: ['packages/operator-core/lib/agent-tools/plans/__tests__/**/*.test.ts'] },
    { id: 'app', label: 'App UI', globs: ['apps/operator/app/admin/plans/**/*.test.*'] },
    {
      id: 'ui',
      label: 'UI',
      globs: [
        'apps/operator/app/admin/plans/**/*.test.*',
        'packages/operator-core/lib/__tests__/client-navigation.test.ts',
        'packages/operator-core/lib/__tests__/desktop-static-host.test.ts',
        'packages/operator-core/lib/__tests__/desktop-ui-intents.test.ts',
        'packages/operator-core/lib/__tests__/operator-vite-dev-mode.test.ts',
        'packages/operator-core/lib/__tests__/lazy-with-retry.test.ts',
        'packages/operator-core/lib/__tests__/navigation-progress-helpers.test.ts',
        'apps/operator/app/admin/testing/_lib/recorder-start-params.test.ts',
        'apps/operator/app/_components/__tests__/SupportChatButton.test.tsx',
        'apps/operator/app/_components/__tests__/ChatwootWidget.test.tsx',
        'apps/operator/app/_components/__tests__/UiPresenceProvider.test.tsx',
        'apps/operator/app/_components/__tests__/OperatorChatSidebar.test.ts',
        'apps/operator/app/_components/__tests__/UserPicker.test.tsx',
        'packages/operator-core/lib/__tests__/PluginIframe.test.tsx',
        'packages/operator-core/lib/__tests__/notify.test.ts',
        'packages/operator-core/lib/__tests__/workspaces-tauri.test.ts',
        'apps/operator/app/_components/__tests__/routePending.test.ts',
        'apps/operator/app/_components/__tests__/RouteLink.test.ts',
        'apps/operator/app/_components/__tests__/RouteProgressProvider.test.ts',
        'apps/operator/app/_components/__tests__/ChromeShellNav.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'operator',
  label: 'Operator',
  description: 'Operator brain: converse, scan, suggestions, audit, persona, state.',
  tier: 'domain',
  sections: [
    { id: 'brain', label: 'Brain', globs: ['packages/operator-core/lib/operator-converse*.test.ts'] },
    { id: 'cards', label: 'Cards', globs: ['packages/operator-core/lib/operator-card*.test.ts'] },
    { id: 'suggestions', label: 'Suggestions', globs: ['packages/operator-core/lib/operator-suggest*.test.ts', 'packages/operator-core/lib/operator-scan*.test.ts'] },
    { id: 'audit', label: 'Audit', globs: ['packages/operator-core/lib/operator-audit*.test.ts'] },
    { id: 'persona', label: 'Persona', globs: ['packages/operator-core/lib/operator-persona*.test.ts', 'packages/operator-core/lib/operator-prompt*.test.ts'] },
    { id: 'state', label: 'State', globs: ['packages/operator-core/lib/operator-state*.test.ts', 'packages/operator-core/lib/operator-trigger*.test.ts'] },
    // Catch-the-rest: every operator-*.test.ts at lib root (converse/scan/etc.
    // are already sectioned above; this surfaces the long tail too).
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/operator-*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'design',
  label: 'Design',
  description: 'Design phase: IR, adapters, spec, tokens, phase flow.',
  tier: 'domain',
  sections: [
    { id: 'ir', label: 'IR', globs: ['packages/operator-core/lib/design-ir*.test.ts'] },
    { id: 'adapters', label: 'Adapters', globs: ['packages/operator-core/lib/design-adapter*.test.ts'] },
    { id: 'spec', label: 'Spec', globs: ['packages/operator-core/lib/design-spec/**/*.test.ts'] },
    { id: 'phase-flow', label: 'Phase flow', globs: ['packages/operator-core/lib/design-phase*.test.ts'] },
    // Catch-the-rest for the design-* lib surface + design-tokens outputs.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/design-*.test.ts',
        'packages/operator-core/lib/design/**/*.test.ts',
        'design-tokens/**/*.test.ts',
      ] },
    // Live E2E smoke (needs a running operator) — surfaced as a runner.
    { id: 'smoke', label: 'Smoke', runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/design-loop-smoke.mjs'], label: 'design-loop (live operator)' },
      ] },
  ],
});

defineTestDomain({
  id: 'plugins',
  label: 'Plugins',
  description: 'Plugin runtime: loader, SDK, WIT, grants, lifecycle, host-shim.',
  tier: 'domain',
  sections: [
    { id: 'loader', label: 'Loader', globs: ['packages/plugin-loader/**/*.test.ts'] },
    { id: 'sdk', label: 'SDK', globs: ['packages/plugin-sdk/**/*.test.ts'] },
    { id: 'wit', label: 'WIT', globs: ['packages/plugin-wit/**/*.test.ts'] },
    { id: 'grants', label: 'Grants', globs: ['packages/operator-core/lib/plugin-grants*.test.ts'] },
    { id: 'lifecycle', label: 'Lifecycle', globs: ['packages/operator-core/lib/plugin-*.test.ts'] },
    // Built-in plugin smokes (libs/papercusp/plugins/**). In-process — the
    // cloudflare-pages smoke runs the full Direct-Upload flow against a mock
    // of api.cloudflare.com (no real CF account/token). Surfaced as a runner
    // because the plugins/ dir is not part of an operator Vitest project.
    { id: 'builtin-smoke', label: 'Built-in plugin smokes', runners: [
        { kind: 'node', cmd: 'npx', args: ['tsx', 'libs/papercusp/plugins/cloudflare-pages/index.smoke.ts'], label: 'cloudflare-pages publish (mock CF)' },
      ] },
  ],
});

defineTestDomain({
  id: 'transport',
  label: 'Transport',
  description: 'SSE / IPC / adapters / sync-resolver.',
  tier: 'surface',
  sections: [
    { id: 'sse', label: 'SSE', globs: ['libs/generic/sse/**/*.test.ts'] },
    { id: 'ipc', label: 'IPC', globs: [
        'packages/operator-core/lib/endpoint-ipc/**/*.test.ts',
        'libs/generic/ipc-endpoint-server/**/*.test.ts',
        'libs/generic/ipc-framing/**/*.test.ts',
      ] },
    { id: 'adapters', label: 'Adapters', globs: [
        'libs/generic/desktop-ipc/src/**/*.test.ts',
        'packages/operator-core/lib/transport-adapters/**/*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'instance-spec',
  label: 'Instance spec',
  description: 'The reproducible InstanceSpec: genome surface, capture/boot/vary, eval-battery subject.',
  tier: 'domain',
  sections: [
    { id: 'genome', label: 'Genome', globs: ['packages/operator-core/lib/instance-spec/genome*.test.ts'] },
    { id: 'vary', label: 'Vary', globs: ['packages/operator-core/lib/instance-spec/vary.test.ts'] },
    { id: 'capture', label: 'Capture', globs: ['packages/operator-core/lib/instance-spec/capture.test.ts'] },
    { id: 'subject', label: 'Subject', globs: ['packages/operator-core/lib/instance-spec/instance-subject.test.ts'] },
    { id: 'roundtrip', label: 'Round-trip', globs: ['packages/operator-core/lib/instance-spec/roundtrip.test.ts'] },
  ],
});

defineTestDomain({
  id: 'mobile',
  label: 'Mobile',
  description: 'Paired-device flow: pair, JWT, feeds, actions, voice init.',
  tier: 'domain',
  sections: [
    { id: 'pair', label: 'Pair', globs: ['packages/operator-core/lib/device-pair*.test.ts'] },
    { id: 'jwt', label: 'JWT', globs: ['packages/operator-core/lib/device-jwt*.test.ts'] },
    { id: 'feeds', label: 'Feeds', globs: ['packages/operator-core/lib/device-feed*.test.ts'] },
    // Catch-the-rest for the device-*/mobile-* lib surface.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/device-*.test.ts',
        'packages/operator-core/lib/mobile-*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'provisioning',
  label: 'Provisioning',
  description: 'Workspace provisioning: runner, sandbox, trust-store, templates, network.',
  tier: 'domain',
  sections: [
    { id: 'runner', label: 'Runner', globs: ['packages/operator-core/lib/provision/runner*.test.ts'] },
    { id: 'sandbox', label: 'Sandbox', globs: ['packages/operator-core/lib/provision/sandbox*.test.ts'] },
    { id: 'trust-store', label: 'Trust store', globs: ['packages/operator-core/lib/provision/trust*.test.ts'] },
    { id: 'network', label: 'Network', globs: ['packages/operator-core/lib/provision/network*.test.ts'] },
    // Catch-the-rest for everything under the provision/ dir.
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/provision/**/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'docs',
  label: 'Docs',
  description: 'Docs engine: outline, search, adapters.',
  tier: 'surface',
  sections: [
    { id: 'engine', label: 'Engine', globs: ['packages/docs-engine/**/*.test.ts'] },
    { id: 'outline', label: 'Outline', globs: ['packages/operator-core/lib/agent-tools/docs/**/*.test.ts'] },
    { id: 'search', label: 'Search', globs: [
        'packages/operator-core/lib/search/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/search/**/*.test.ts',
      ] },
    { id: 'adapters', label: 'Adapters', globs: ['packages/operator-core/lib/agent-tools/cross_harness/docs*.test.ts'] },
  ],
});

/* ---------------------------------------------------------------- *
 * Dogfood — the shared-harness collaborative substrate (plan
 * dogfood-test-suite-2026-06-01). One sectioned domain covering the
 * Model-B sync layer, identity/binding, federation, orchestrator
 * claim, PR lifecycle, reactivity, revocation, the Cupboard public
 * API, the collaboration UI, and the endpoint routes — surfaces the
 * ~80 existing substrate/identity/orchestrator/pr-host tests (which
 * no prior domain globbed) plus the new coverage this plan adds.
 * Cross-section overlap (e.g. revocation ⊂ substrate) is intentional:
 * the matcher doesn't negate, and a sub-view is worth its own glob.
 * ---------------------------------------------------------------- */
defineTestDomain({
  id: 'dogfood',
  label: 'Dogfood',
  description: 'Shared-harness collaborative substrate: Model-B sync, identity/binding, federation, claims, PR lifecycle, Cupboard.',
  tier: 'domain',
  sections: [
    {
      id: 'substrate',
      label: 'Substrate',
      description: 'Model-B per-peer signed logs + LWW read-merge + projections + boot/swarm.',
      globs: ['packages/operator-core/lib/sync/hyperbee/**/*.test.ts'],
    },
    {
      id: 'identity-binding',
      label: 'Identity & binding',
      description: 'Device keychain, Ed25519 signing, two-channel binding, attestation.',
      globs: ['packages/operator-core/lib/identity/**/*.test.ts'],
    },
    {
      id: 'federation',
      label: 'Federation',
      description: 'Join/share, user-branch, binding publish, tree classifier, clone, register.',
      globs: [
        'packages/operator-core/lib/harness/__tests__/**/*.test.ts',
        'packages/operator-core/lib/harness/classify-tree.test.ts',
        'packages/operator-core/lib/harness/clone-github.test.ts',
        'packages/operator-core/lib/harness/register-papercup.test.ts',
        'packages/operator-core/lib/harness/papercusp-workspace.test.ts',
        'packages/operator-core/lib/harness/contributor-row-types.test.ts',
        'packages/operator-core/lib/harness/contributor-usage-event-types.test.ts',
        'packages/operator-core/lib/harness/feature-queue-row-types.test.ts',
      ],
    },
    {
      id: 'claim',
      label: 'Claim',
      description: 'Orchestrator distributed/advisory feature claim + audit + multi-harness spawning smoke.',
      globs: ['packages/operator-core/lib/orchestrator/**/*.test.ts'],
      // Live multi-harness-spawning E2E (drives a running operator) — runner.
      runners: [
        { kind: 'shell', cmd: 'bash', args: ['bin/smoke-multi-harness-spawning.sh'], label: 'multi-harness spawning (live)' },
      ],
    },
    {
      id: 'pr-lifecycle',
      label: 'PR lifecycle',
      description: 'PrHost, poll daemon + retry, auto-approve/merge, reviewer settings.',
      globs: ['packages/operator-core/lib/pr-host/**/*.test.ts'],
    },
    {
      id: 'completion-ref',
      label: 'Completion ref',
      description: 'completion_ref writer + background ls-remote verifier.',
      globs: ['packages/operator-core/lib/harness/completion-ref-*.test.ts'],
    },
    {
      id: 'reactivity',
      label: 'Reactivity',
      description: 'sync-resolver query registry + sync-sse bridge + emit-change-notify trigger sentinel.',
      globs: [
        'packages/operator-core/lib/sync-resolver/**/*.test.ts',
        'packages/operator-core/lib/sync-sse.test.ts',
      ],
      // Live-PG regression sentinel (brings its own embedded PG) — see
      // agent-insights/live-pg-regression-sentinel.
      runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/verify-trigger-consolidation.mjs'], label: 'emit-change-notify sentinel' },
        // Full reactivity round-trip e2e: PG trigger → pg_notify → sync-sse LISTEN
        // → SSE endpoint → EventSource consumer. Drives the live operator.
        { kind: 'node', cmd: 'npx', args: ['tsx', 'apps/operator/scripts/verify-reactivity-e2e.ts'], label: 'reactivity round-trip e2e (live operator)' },
      ],
    },
    {
      id: 'revocation',
      label: 'Revocation',
      description: 'Self-device + contributor revocation, enforcement, re-verify, MCP tools.',
      globs: [
        'packages/operator-core/lib/sync/hyperbee/__tests__/revoke-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/revocation-enforcement.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/reverify-admitted.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/boot-revoke-production-path.test.ts',
        'packages/operator-core/lib/agent-tools/substrate/**/*.test.ts',
      ],
    },
    {
      id: 'cupboard',
      label: 'Cupboard',
      description: 'Public harness-discovery API (operator-public).',
      globs: ['apps/operator-public/src/**/*.test.ts'],
    },
    {
      id: 'ui',
      label: 'UI',
      description: 'Create/Share/Join, PRs, Insights cards, claim/contributor/binding badges.',
      globs: [
        'apps/operator/app/harness/__tests__/**/*.test.tsx',
        'apps/operator/app/harness/insights/__tests__/**/*.test.tsx',
        'apps/operator/app/harness/PrsTab.component.test.tsx',
        'apps/operator/app/_components/__tests__/ContributorBadge.test.tsx',
        'apps/operator/app/_components/__tests__/ClaimStatusBadge.test.tsx',
        'apps/operator/app/_components/__tests__/HarnessClaimHeader.test.tsx',
        'apps/operator/app/_components/__tests__/BindingStatusBadge.test.tsx',
        'apps/operator/app/users/github/[id]/__tests__/**/*.test.tsx',
      ],
    },
    {
      id: 'routes',
      label: 'Routes',
      description: 'Substrate revoke, join/share/feature-queue/discord, user-profile endpoints.',
      globs: [
        'packages/operator-core/lib/endpoint-route/routes/admin/__tests__/substrate-*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/admin/__tests__/dogfood-substrate-*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/__tests__/**/*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/users/__tests__/**/*.test.ts',
      ],
    },
    {
      id: 'e2e',
      label: 'E2E',
      description: 'Browser collaboration flows (Playwright).',
      globs: ['apps/operator/e2e/collab-*.spec.ts'],
    },
  ],
});

// p2p-performance-suite-2026-06-07 (D-002): the hyperbee substrate's
// three-tier performance suite. The vitest files under perf/ ALSO match the
// dogfood substrate glob — intentional overlap (they are substrate tests);
// this domain is where the bench RUNNERS live. Artifacts + per-run report
// land under test-results/p2p-perf/<runId>/; committed baselines next to the
// suite in perf/baselines/ (advisory comparator — D-005).
defineTestDomain({
  id: 'p2p-perf',
  label: 'P2P Perf',
  description:
    'Hyperbee-substrate performance suite: merge/decode benches, multi-process replication + churn, netem WAN sim, real-frame tier.',
  tier: 'domain',
  sections: [
    {
      id: 'infra',
      label: 'Suite infra',
      description:
        'Corpus determinism, comparator math, meter envelope, and the CI-locked EI-79 idle-tick invariant (merge-scaling.test.ts).',
      globs: ['packages/operator-core/lib/sync/hyperbee/perf/**/*.test.ts'],
    },
    {
      id: 'tier1',
      label: 'Tier 1 (local)',
      description:
        'Loopback benches: merge cost / decode throughput / replication latency+ceiling / churn. Every scenario asserts the loop-lag SLO (p95 < 100ms).',
      runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier1', '--profile', 'smoke'],
          label: 'tier1 smoke (~3 min)',
        },
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier1', '--profile', 'ci'],
          label: 'tier1 ci profile (~15 min)',
        },
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier1', '--profile', 'full'],
          label: 'tier1 full sweep (long)',
        },
      ],
    },
    {
      id: 'tier2',
      label: 'Tier 2 (netem WAN)',
      description:
        'Simulated WAN: unprivileged userns + veth + tc netem (RTT/jitter/loss matrix + the UDX loss curve). Skips on hosts without userns.',
      runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier2', '--profile', 'smoke'],
          label: 'tier2 netem smoke',
        },
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts', '--tier2', '--profile', 'full'],
          label: 'tier2 netem full matrix',
        },
      ],
    },
    {
      id: 'tier3',
      label: 'Tier 3 (real frames)',
      description:
        'Latitude/Hetzner real-machine measurements (NAT/holepunch, real-WAN DHT, cross-region replication). Cred-gated: $0 and skipped without LATITUDE_API_KEY.',
      globs: [
        'packages/operator-core/lib/deployment/**/p2p-perf*.test.ts',
        'packages/operator-core/lib/deployment/p2p-perf-tier3/**/*.test.ts',
      ],
    },
  ],
});

/* ---------------------------------------------------------------- *
 * Newer subsystems that grew their own test trees after the original 20
 * domains were hand-curated, plus catch-all domains so NO canonical test
 * is ever invisible in the tab. Globs are directory/prefix-level so new
 * tests in an existing area appear with no registry edit; a genuinely new
 * subsystem (a new top-level dir) trips the coverage guard
 * (scripts/lint-tests.ts) which forces a one-line glob add here.
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'gym',
  label: 'Gym',
  description: 'Agent gym / eval harness.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/gym/**/*.test.ts',
        'packages/operator-core/lib/gym/**/*.test.tsx',
        'packages/operator-core/lib/gym-*.test.ts',
      ] },
    // Self-contained boot E2Es (testcontainer PG + a dedicated headless
    // gym-operator; no live operator needed) — surfaced as runners.
    { id: 'e2e', label: 'Boot E2E', runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/gym/wake-mode-run.ts'],
          label: 'wake-mode autonomous chain links 1→4 (fake, zero-LLM — hive-loop-e2e P-006)',
        },
      ] },
  ],
});

defineTestDomain({
  id: 'dbos',
  label: 'DBOS',
  description: 'Durable workflow engine: steps, crash-replay, sweep glue.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/dbos/**/*.test.ts',
        'packages/operator-core/lib/dbos-*.test.ts',
      ] },
    { id: 'integration', label: 'Integration', globs: ['apps/operator/test/dbos-*.integration.test.ts'] },
  ],
});

defineTestDomain({
  id: 'workspace',
  label: 'Workspace',
  description: 'Workspace registry, multi-workspace context, per-window scoping.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/workspace-*.test.ts',
        'packages/operator-core/lib/workspaces-*.test.ts',
        'packages/operator-core/lib/workspace/**/*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'adv',
  label: 'ADV Shell',
  description: 'The /adv operator shell: dock panels, sessions, contributors, Vite SPA.',
  tier: 'domain',
  sections: [
    { id: 'panels', label: 'Panels', globs: [
        'apps/operator/app/adv/**/*.test.ts',
        'apps/operator/app/adv/**/*.test.tsx',
        'packages/operator-core/lib/adv-*.test.ts',
      ] },
    { id: 'vite', label: 'Vite SPA', globs: [
        'apps/operator-vite/src/**/*.test.ts',
        'apps/operator-vite/src/**/*.test.tsx',
        // Root-level operator-vite tests (e.g. dev-dist-prune.test.ts — the
        // dev-watch build-churn tooling lives at the package root, not src/).
        'apps/operator-vite/*.test.ts',
        'apps/operator-vite/*.test.tsx',
      ] },
  ],
});

defineTestDomain({
  id: 'operator-core',
  label: 'Operator (core & misc)',
  description: 'Flat catch-all for the operator app: every lib/app/bin/script/integration test, so nothing is invisible. Files here may also appear under a more specific domain — overlap is intentional.',
  tier: 'domain',
  sections: [
    { id: 'lib-root', label: 'lib (root)', globs: [
        'packages/operator-core/lib/*.test.ts',
        'packages/operator-core/lib/*.test.tsx',
      ] },
    { id: 'lib-subdirs', label: 'lib (subdirs)', globs: [
        'packages/operator-core/lib/*/*.test.ts',
        'packages/operator-core/lib/*/*.test.tsx',
        'packages/operator-core/lib/*/__tests__/**/*.test.ts',
        'packages/operator-core/lib/*/__tests__/**/*.test.tsx',
        'packages/operator-core/lib/endpoint-route/routes/**/*.test.ts',
      ] },
    { id: 'lib-tests', label: 'lib/__tests__', globs: [
        'packages/operator-core/lib/__tests__/**/*.test.ts',
        'packages/operator-core/lib/__tests__/**/*.test.tsx',
      ] },
    { id: 'app', label: 'app', globs: [
        'apps/operator/app/**/*.test.ts',
        'apps/operator/app/**/*.test.tsx',
      ] },
    { id: 'bin-scripts', label: 'bin / scripts', globs: [
        'apps/operator/bin/**/*.test.ts',
        'apps/operator/scripts/**/*.test.ts',
        'apps/operator/scripts/**/*.test.mjs',
      ] },
    { id: 'integration', label: 'Integration (test/)', globs: [
        'apps/operator/test/**/*.test.ts',
        'apps/operator/__tests__/**/*.test.ts',
      ] },
    { id: 'e2e', label: 'E2E (all specs)', globs: ['apps/operator/e2e/*.spec.ts'] },
  ],
});

defineTestDomain({
  id: 'libraries',
  label: 'Libraries',
  description: 'Shared libs + packages the operator depends on (libs/*, packages/*, tools/*).',
  tier: 'surface',
  sections: [
    { id: 'generic', label: 'libs/generic', globs: [
        'libs/generic/**/*.test.ts',
        'libs/generic/**/*.test.tsx',
        // papergrid + search-core use `.spec.ts` for Vitest (Restart-style).
        'libs/generic/**/*.spec.ts',
      ] },
    { id: 'papercusp', label: 'libs/papercusp', globs: [
        'libs/papercusp/packages/**/*.test.ts',
        'libs/papercusp/packages/**/*.test.tsx',
        'libs/papercusp/packages/**/*.spec.ts',
        'libs/papercusp/libs/**/*.test.ts',
      ] },
    { id: 'operator-libs', label: 'operator libs', globs: [
        'libs/papercup-shared/src/**/*.test.ts',
        'libs/papercup-shared/src/**/*.test.tsx',
        'libs/papercusp-export-state/src/**/*.test.ts',
        'libs/papercusp-publish-auth/src/**/*.test.ts',
        'libs/host-platform/src/**/*.test.ts',
        'libs/flags/src/**/*.test.ts',
        'libs/test-config/src/**/*.test.ts',
        'libs/testing-shell/src/**/*.test.ts',
        'libs/testing-shell/src/**/*.test.tsx',
        // The standalone publish worker (Cloudflare).
        'apps/papercusp-publish/src/**/*.test.ts',
      ],
      // Live end-to-end smoke against `wrangler dev --local` (register → build
      // manifest → mint JWT → publish/start → upload → finalize).
      runners: [
        { kind: 'node', cmd: 'node', args: ['apps/papercusp-publish/scripts/smoke-test.mjs'], label: 'papercusp-publish e2e (wrangler dev --local)' },
      ] },
    { id: 'ui-libs', label: 'UI libs', globs: [
        'libs/marketplace-public-ui/src/**/*.test.ts',
        'libs/marketplace-public-ui/src/**/*.test.tsx',
        'libs/agent-chat/src/**/*.test.ts',
        'libs/agent-chat/src/**/*.test.tsx',
      ] },
    { id: 'packages', label: 'packages', globs: [
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
        'packages/**/*.spec.ts',
      ] },
    { id: 'tools', label: 'tools', globs: [
        'tools/**/*.test.ts',
        'tools/**/*.test.mjs',
        'tools/**/*.spec.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'harness-framework',
  label: 'Harness Framework',
  description: 'libs/papercusp framework end-to-end smokes (bash). Live — drive real services; surfaced as shell runners, not Vitest.',
  tier: 'surface',
  sections: [
    {
      id: 'smokes',
      label: 'Smokes',
      description: 'Full-stack, planner, and service-gate smokes for the Papercusp harness framework.',
      runners: [
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/bin/papercusp-smoketest.sh'], label: 'framework full-stack' },
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/packages/harness/bin/smoke-test.sh'], label: 'planner smoke' },
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/packages/harness/bin/service-smoke-test.sh'], label: 'service gate (run.sh DONE)' },
      ],
    },
  ],
});

/* ---------------------------------------------------------------- *
 * Composed views (P-011). `papercuspRegistry` = the 20 declared above
 * (read back from the Map by id); `adminRegistry` = universal + papercusp
 * = the full /admin/testing set. The SPA nav order is TestingClient's own
 * TABS, not these arrays.
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'hive',
  label: 'Hive (Queen/bee loop)',
  description:
    'The local-hive orchestration loop: tracked Queen launch, bee placement + nursery, the deliver-and-wake / parent-wake liveness chain, spawn reclaim, host self-recycle, and the Apiary IQ battery. Many files also appear under operator-core (overlap intentional); this is the cohesive subsystem view.',
  tier: 'domain',
  sections: [
    {
      id: 'wake-loop',
      label: 'Wake loop',
      description: 'Deliver-and-wake: parent-wake on bee terminal, the wake executor (resume command + MCP remount), inbox-wake fan, await engine/store, and the end-to-end reclaim→parent-wake liveness contract.',
      globs: [
        'packages/operator-core/lib/fleet/parent-wake.integration.test.ts',
        'packages/operator-core/lib/fleet/hive-wake-loop.integration.test.ts',
        'packages/operator-core/lib/events/await/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/coordination/tools/deliver-and-wake.test.ts',
        'packages/operator-core/lib/agent-tools/coordination/tools/await-inbox*.test.ts',
      ],
    },
    {
      id: 'placement',
      label: 'Placement & nursery',
      description: 'fleet:spawn chokepoint, the fleet_assignment (Brood Box) projection, graceful drain, selected-bee, spawn budget/governor, and the concurrency-primitive suite.',
      globs: [
        'packages/operator-core/lib/fleet/operator-spawn.test.ts',
        'packages/operator-core/lib/fleet/assignments*.test.ts',
        'packages/operator-core/lib/fleet/nursery.integration.test.ts',
        'packages/operator-core/lib/fleet/selected-bee.test.ts',
        'packages/operator-core/lib/fleet/spawn-budget.integration.test.ts',
        'packages/operator-core/lib/fleet/governor.integration.test.ts',
        'packages/operator-core/lib/fleet/supervision.integration.test.ts',
        'packages/operator-core/lib/fleet/saga.integration.test.ts',
        'packages/operator-core/lib/fleet/lock-release.integration.test.ts',
        'packages/operator-core/lib/fleet/classic-*.test.ts',
        'packages/operator-core/lib/agent-tools/fleet/**/*.test.ts',
      ],
    },
    {
      id: 'reclaim',
      label: 'Reclaim',
      description: 'P-011 heartbeat-stale reclaim of orphaned spawns (frees the concurrency ceiling; fires parent-wake).',
      globs: ['packages/operator-core/lib/fleet/spawn-reclaim.integration.test.ts'],
    },
    {
      id: 'hive-wake',
      label: 'Pot wake',
      description: 'The Queen wake routine — hive:wake / declare-wake / urgent-wake scheduling and the hive-wake PG path.',
      globs: ['packages/operator-core/lib/hive/**/*.test.ts'],
    },
    {
      id: 'host-health',
      label: 'Host health',
      description: 'Operator self-protection: the memory watchdog (bounded-RSS self-recycle) and the event-loop-lag gauge.',
      globs: [
        'packages/operator-core/lib/memory-watchdog.test.ts',
        'packages/operator-core/lib/event-loop-lag-monitor.test.ts',
      ],
    },
    {
      id: 'apiary',
      label: 'Apiary IQ battery',
      description: 'The Apiary instance-gym: corpus seeder, the seven metric collectors, and the Beekeeper runner.',
      globs: ['packages/operator-core/lib/iq-battery/**/*.test.ts'],
    },
    {
      id: 'run-eval',
      label: 'Hive run evaluation',
      description:
        'The Hive-run-evaluation battery (sibling of the apiary): seeded scenarios with an objective optimum (parallelism math + validation), the throwaway-hive run harness, and the determinism + repeat-distribution controls.',
      globs: ['packages/operator-core/lib/hive-eval/**/*.test.ts'],
    },
  ],
});

// The SHARED-HIVE federation: sharing one Hive's work across SOVEREIGN peer Hives
// (shared-hive-federation-2026-06-08 / cross-hive-boundary-2026-06-08). Distinct from the
// `hive` domain (the LOCAL Queen/bee loop): this is the cross-Hive substrate — the mediated
// boundary (owner-set capability grants → admit → translate into B's own conversation/work_item),
// the signed wire + store-and-forward outbox, the Hyperswarm transport, the P2P hive directory,
// per-Hive identity/membership/settings + contributor revocation, and the Hive-scoped work-item
// claim authority. Files also appear under operator-core (overlap intentional, like `hive`);
// this is the cohesive subsystem view a reviewer of "Shared Hive" wants in one place.
defineTestDomain({
  id: 'shared-hive',
  label: 'Shared Hive (federation)',
  description:
    'Cross-Hive peer-to-peer federation: the mediated Hive→Hive boundary (capability-grant admission + translation), signed wire + store-and-forward outbox, Hyperswarm transport, the P2P hive directory, per-Hive identity/membership/settings + contributor revocation, and Hive-scoped work-item claim authority.',
  tier: 'domain',
  sections: [
    {
      id: 'boundary',
      label: 'Boundary (admit + signed wire)',
      description:
        'The sovereignty boundary: capability-grant allow-list admission (default-deny, per-peer, per-kind), translation into B\'s ordinary conversation/work_item surfaces, the Ed25519-signed wire envelope + verify (incl. malformed-input robustness + correlationId canonicalization), the durable store-and-forward outbox (partial-failure recovery + id-keyed dedup), and the persisted grant store.',
      globs: [
        'packages/operator-core/lib/cross-hive-boundary*.test.ts',
        'packages/operator-core/lib/cross-hive-transport*.test.ts',
        'packages/operator-core/lib/cross-hive-grants.integration.test.ts',
        'packages/operator-core/lib/cross-hive-outbox-pg.integration.test.ts',
      ],
    },
    {
      id: 'transport-swarm',
      label: 'Hyperswarm transport + live wire',
      description:
        'The Hive-pubkey-topic Hyperswarm transport (dial-by-pubkey, subscribe, close) and the live two-Hive wire E2E over a real Hyperswarm testnet (bidirectional ask→answer). NOTE: the two-hive testnet wire test is timing-flaky on the DHT and is actively being stabilized.',
      globs: [
        'packages/operator-core/lib/cross-hive-swarm-transport.test.ts',
        'packages/operator-core/lib/cross-hive-e2e.test.ts',
        'packages/operator-core/lib/cross-hive-two-hive.test.ts',
      ],
    },
    {
      id: 'directory',
      label: 'Hive directory + publish',
      description:
        'The P2P hive-discovery directory (verified-only ingest, LWW dedup, mute, visibility-routed announce, TTL GC, boot wiring) plus announce-on-publish and the harness→Hive swarm-binding re-key.',
      globs: [
        'packages/operator-core/lib/hive-directory*.test.ts',
        'packages/operator-core/lib/hive-publish.test.ts',
        'packages/operator-core/lib/hive-federation.test.ts',
      ],
    },
    {
      id: 'identity',
      label: 'Identity & store',
      description: 'Per-Hive Ed25519 identity get-or-mint + pubkey resolution, and the hive entity PG store (pubkey/keychain CRUD, workspace scoping).',
      globs: [
        'packages/operator-core/lib/hive-identity*.test.ts',
        'packages/operator-core/lib/hive-store.integration.test.ts',
      ],
    },
    {
      id: 'membership',
      label: 'Membership, settings & revocation',
      description:
        'Per-Hive contributor admission (device pubkeys, the revoked-pubkey union), federated per-Hive settings, and owner revocation of a Hive contributor (blocklist into the owner row).',
      globs: [
        'packages/operator-core/lib/hive-membership-store.integration.test.ts',
        'packages/operator-core/lib/hive-settings-store.integration.test.ts',
        'packages/operator-core/lib/hive-revoke-contributor.test.ts',
      ],
    },
    {
      id: 'claim-authority',
      label: 'Work-item claim + replica authority',
      description:
        'The Hive-scoped work-item arbitration seams (single-peer local authority + the Track-B swap-in registry) and their stores: (1) the CLAIM lease — acquire/heartbeat/release op routing, lease lifecycle, concurrency races, two-instance split; and (2) the BOINC REDUNDANCY replica store (EI-266) — the per-Hive replica-authority seam + the claim-slot/heartbeat/release/record-result/list/judge op routing that homes the N replicas of a high-stakes item in ONE store so cross-swarm replicas meet, plus the replica lease/steal/record/judge store behavior.',
      globs: [
        'packages/operator-core/lib/work-item-claim-authority*.test.ts',
        'packages/operator-core/lib/work-item-claims*.test.ts',
        'packages/operator-core/lib/work-item-replica-authority*.test.ts',
        'packages/operator-core/lib/work-item-redundancy*.test.ts',
      ],
    },
    {
      id: 'authority',
      label: 'Lock authority (election, failover, fencing, RPC, caller-auth)',
      description:
        'The D-005 deterministic lock/claim authority layer: argmin election + staleness failover over presence (harness + Hive scope), hardened epoch fencing + anti-flap, the authority-op registry, the HTTP peer-RPC transport + boot wiring + address resolution, file-lock authority ops + Hive-aware routing, the two-instance authority rigs, cross-machine lock failover mid-hold (P-007), the failover flood (P-003), the lock-set reconstructor handover, the remote-peers fast-path cache, and the EI-322 authenticated peer-RPC envelope (Ed25519 sign/verify, freshness, holderPubkey identity binding + revocation in the receiving caller-verifier, end-to-end signed/forged/tampered loopback).',
      globs: ['packages/operator-core/lib/authority/__tests__/**/*.test.ts'],
    },
    {
      id: 'wire-federation',
      label: 'Federation wire (peers, presence, partition, coord rails)',
      description:
        'The Hive-relevant slice of the hyperbee substrate over the REAL wire (the full substrate suite lives at dogfood/substrate — overlap by design): two-peer + bidi swarms, three-peer partition/rejoin convergence, presence announce + hive_slug projection, the federated coord rails (messages/threads/conversations incl. the deliver-and-wake intent), the federation triggers (hive members, plan-item assignment, engineer issues, feature content, substrate outbox), the adversarial two-peer battery, swarm join/guard/chaos, topic derivation + default binding, and the live two-peer hive directory.',
      globs: [
        'packages/operator-core/lib/sync/hyperbee/__tests__/hive-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/two-peer*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/three-peer-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/presence-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/wire-presence.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/federation-adversarial.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/coord-*-federation.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/*federation-trigger.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/feature-content-federation.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/cross-plan-federation-seam.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/plan-item-assignment-two-peer-federation.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/substrate-outbox-trigger.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/swarm*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/convergence.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/derive-swarm-topic.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/default-swarm-binding-p007.test.ts',
      ],
    },
    {
      id: 'coordination',
      label: 'Cross-peer coordination (presence→authority→claim→failover/partition)',
      description:
        'Coordination across the shared Hive end-to-end: two REAL peers federate presence over the wire → the federated roster drives a CONSISTENT (no-split-brain) Hive authority election → both Swarms contend for one work-item and the federated-presence-elected authority grants EXACTLY ONE (cross-peer exactly-once). Plus the topology-change legs over the same real federated roster: the authority Swarm DEPARTS → staleness deposes it and the survivor elects itself (D-005 failover by definition) with claims continuing locally; a PARTITION (authority fresh in roster, RPC severed) → the non-authority fails open LOUDLY into its own store (D-004, the documented optimistic split-brain window), then routes remote-authority again on heal; THREE-peer failover consistency (both survivors independently elect the SAME successor; contended claim grants exactly one) + departed-Swarm REJOIN reconverging all three on the original argmin; the full claim LEASE LIFECYCLE across peers (acquire remote → contention refused → release remote → re-acquire); FILE-LOCK routing (the production routeFileLockOp cutover seam) resolving its Hive scope off the federated roster and crossing the wire (grant / busy-with-holder / release); DELIVER-AND-WAKE over the real wire (a body.wake coord-message federates A→B; B fires the fan EXACTLY once; the EI-117 echo breaker keeps A at one origin=local copy); and SCALE (the -scale sibling file — own vitest worker, see _cross-peer-rig.ts): a FIVE-Swarm cascade where every authority departure is followed by UNANIMOUS re-election among all survivors and claims serialize at every epoch, 5→1. Closes the gap the injected-roster authority/claim suites leave open.',
      globs: ['packages/operator-core/lib/sync/hyperbee/__tests__/cross-peer-coordination*.integration.test.ts'],
    },
    {
      id: 'loop-composition',
      label: 'Multi-swarm loop composition (hermetic 2-swarm rig)',
      description:
        'The shared-hive autonomous LOOP as a system (shared-hive-loop-e2e-testing-2026-06-10): the hermetic 2-swarm composition rig — scripted Queen steering → concurrent cross-swarm claim_next + authority lease → fake pipelines → real CDC convergence — plus the chaos scenarios (partition fail-open + reconcile, kill-authority re-election, lease-steal D-007 adoption, split-brain Queen D-008 gate/detector, outbox write-storm, two-identity redundancy) and the Phase-3 fleet monitors (double-completion scanner, orphaned-taken_by sweep, outbox health, presence ghosts, convergence-lag probe). Brief 12\'s coord verb-lifecycle two-cell suite rides the same rig.',
      globs: ['packages/operator-core/lib/shared-hive-loop/**/*.test.ts'],
    },
    {
      id: 'tools',
      label: 'Hive agent tools',
      description: 'The agent-facing hive lifecycle tools: hive:create / hive:add-member, discovery:hives, and harness create→hive-membership wiring.',
      globs: [
        'packages/operator-core/lib/agent-tools/hive/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/discovery/hives.test.ts',
        'packages/operator-core/lib/agent-tools/harness/__tests__/create-hive-membership.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'operator-ui-lib',
  label: 'Operator UI lib',
  description: 'UI-tier lib kept in apps/operator after the operator-core carve (router-compat, flag-hooks, plugin UI, forms, chat-cards, theme/notify/visual-effects hooks + the operator-vite/script/bin-composition tests).',
  tier: 'quick',
  sections: [
    { id: 'all', label: 'UI lib', globs: ['apps/operator/lib/**/*.test.ts', 'apps/operator/lib/**/*.test.tsx'] },
  ],
});

// The adversarial coordination test suite (coordination-test-suite-2026-06-08) as a
// cohesive cross-subsystem VIEW, grouped by the test CLASSES that were missing when
// EI-152/EI-153 shipped. Files also appear under their home domains (hive/wake-loop,
// papercusp-su, operator-core) — overlap is intentional, exactly like the `hive`
// domain. The companion coverage matrix is /internal/docs/testing/coordination-coverage-matrix.
defineTestDomain({
  id: 'coordination-suite',
  label: 'Coordination suite (adversarial)',
  description:
    'The adversarial, multi-session, real-seam coordination suite that closes the EI-152/EI-153 escape classes: cross-agent isolation, real-seam integration, multi-session concurrency, and the liveness matrix. Cross-subsystem view; files overlap their home domains by design.',
  tier: 'domain',
  sections: [
    {
      id: 'wake-liveness',
      label: 'C4 liveness matrix + EI-152',
      description: 'The wake-executor liveness×handle/socket matrix over the REAL socket seam; EI-152 (no-handle + live socket → socket-inject, not park) verified red-on-pre-fix.',
      globs: ['packages/operator-core/lib/events/await/wake-executor-matrix.test.ts'],
    },
    {
      id: 'wake-identity',
      label: 'C5 identity + EI-153',
      description: 'Cross-agent wake isolation + identity across resume (per-owner CLAUDE_CONFIG_DIR / CODEX_HOME, exact-session resume never --continue) + the launch-side per-spawn config isolation (headless bees) AND the interactive psu/SU + role claude config-dir materializer (EI-155 — a symlink mirror of ~/.claude with an isolated transcript store).',
      globs: [
        'packages/operator-core/lib/events/await/wake-resume-isolation.test.ts',
        'libs/papercusp/packages/orchestrator/src/spawn-config-isolation.test.ts',
        'packages/operator-core/lib/interactive-claude-config.test.ts',
      ],
    },
    {
      id: 'resume-live',
      label: 'C5 real resume spawn (live)',
      description: 'LIVE-SMOKE (needs claude/codex creds → not CI): a REAL claude/codex resume — built by the SAME wake-executor resumeCommandFor, run in the EI-155 isolated CLAUDE_CONFIG_DIR/CODEX_HOME — continues the EXACT session (transcript/rollout GROWS). Complements the injected-spawnDetached CI rung in wake-resume-isolation.test.',
      runners: [
        { kind: 'node', cmd: 'npx', args: ['tsx', 'apps/operator/scripts/resume-spawn-live.ts'], label: 'real claude/codex resume (live · needs creds)' },
      ],
    },
    {
      id: 'wake-realseam',
      label: 'C2/C6 real-seam pump + host',
      description: 'The real psu-pty-host idle-gate + mode:turn CR-submit + discovery handshake; the real emit→pump path with armInboxWake idempotency and cross-agent isolation.',
      globs: [
        'apps/operator/lib/psu-pty-host-turn.integration.test.ts',
        'packages/operator-core/lib/events/await/wake-pump-isolation.integration.test.ts',
      ],
    },
    {
      id: 'channel-isolation',
      label: 'C1 channel isolation (coord/locks)',
      description: 'Cross-agent isolation for coord:send/inbox/presence (real PgCoordLog) and file/resource locks (A can\'t release/heartbeat B\'s; block-on-held; authority election) + the file-lock PreToolUse hook decision rendering (block-on-held deny / fail-open).',
      globs: [
        'packages/operator-core/lib/agent-tools/coordination/__tests__/cross-agent-isolation.integration.test.ts',
        'packages/operator-core/lib/agent-tools/locks/__tests__/cross-agent-isolation.integration.test.ts',
        'apps/operator/scripts/hooks/cc/__tests__/pretooluse-locks-decision.test.ts',
      ],
    },
    {
      id: 'concurrency-federation',
      label: 'C3 concurrency + federation',
      description: 'N-session claim concurrency (no double-claim), federation data-plane (peer-log→projection→PG, admission/revocation, no-loss/no-dup), and the full multi-session concurrency capstone (wakes+sends+claims+locks → zero loss/dup/misroute).',
      globs: [
        'packages/operator-core/lib/work-item-claims-concurrency.integration.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/federation-adversarial.integration.test.ts',
        'packages/operator-core/lib/multi-session-concurrency.integration.test.ts',
      ],
    },
  ],
});

const PAPERCUSP_IDS = [
  'test-runs', 'vitals', 'chaos-desktop', 'ai-explore',
  'memory', 'packaged', 'llm', 'harness', 'voice', 'papercusp-su', 'backup',
  'plans', 'operator', 'design', 'plugins', 'transport', 'instance-spec', 'mobile',
  'provisioning', 'docs', 'dogfood',
  // Subsystems + catch-alls added by the test-framework coverage audit.
  'gym', 'dbos', 'workspace', 'adv', 'operator-core', 'operator-ui-lib', 'libraries', 'harness-framework',
  // The local-hive orchestration loop (Queen/bee) as a cohesive subsystem view.
  'hive',
  // The cross-Hive (shared-hive) federation substrate as a cohesive subsystem view.
  'shared-hive',
  // The hyperbee-substrate performance suite (bench runners; files overlap dogfood by design).
  'p2p-perf',
  // The adversarial coordination test suite as a cohesive cross-subsystem view.
  'coordination-suite',
] as const;

export const papercuspRegistry: TestDomain[] = PAPERCUSP_IDS.map((id) => {
  const d = getTestDomain(id);
  if (!d) throw new Error(`testing-domains-registry: papercusp domain '${id}' not registered`);
  return d;
});

export const adminRegistry: TestDomain[] = [...operatorUniversal, ...papercuspRegistry];
