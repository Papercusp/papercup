/**
 * Provider-specific code census (plan cupboard-distributable-integrations-2026-10-10, P-015).
 *
 * Integrations ship as Cupboard provider packages (libs/papercusp/plugins/*). Any module in
 * app code that exists only to talk to one provider is a leftover from before that model.
 * This test lists every such module and is SHRINK-ONLY:
 *
 *  - a provider-named source file that is not in CENSUS fails the test (the list may not grow);
 *  - a CENSUS entry whose file is gone, or whose content no longer mentions its provider,
 *    fails the test until the entry is removed (the list must stay exact);
 *  - CENSUS_HIGH_WATERMARK must equal CENSUS.length, so every removal lowers the watermark
 *    and raising it is a visible, reviewable diff.
 *
 * Growing the census needs owner sign-off. The fix for a new provider module is a provider
 * package, not a new entry here.
 *
 * Detection is by path: every app-code source path is split into words (directory and file
 * names, kebab/snake/camelCase) and a word equal to a provider token marks it. Modules whose
 * path names no provider but whose body is provider-specific are listed in CENSUS with
 * `detectedBy: 'content'` and a marker the body must still match.
 *
 * Subject root: the repository root, overridable with PROVIDER_CENSUS_ROOT so a mutation
 * probe can point the census at a copy.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT =
  process.env.PROVIDER_CENSUS_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** App-code roots. Provider packages (libs/papercusp/plugins) are the destination, not app code. */
const APP_ROOTS = [
  'apps/operator',
  'packages/operator-core',
  'packages/agent-mcp',
  'papercusp-desktop/src',
  'orchestrator',
  'bin',
] as const;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  'coverage',
  '.vitest-tmp',
  'sidecar',
  'e2e',
  '__tests__',
  'prompts',
  'target',
]);

/** Provider names whose appearance as a path word marks a module provider-specific. */
export const PROVIDER_TOKENS = [
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'bluesky',
  'mastodon',
  'reddit',
  'facebook',
  'instagram',
  'threads',
  'tiktok',
  'youtube',
  'linkedin',
  'twitter',
  'social',
  'google',
  'gmail',
  'gcal',
  'asana',
  'linear',
  'jira',
  'notion',
] as const;

/**
 * Provider tokens deliberately NOT counted, each with its reason. `github` is excluded because
 * GitHub in app code is the platform's own source-hosting identity (repo import, user profile,
 * PAT), not an integration; GitHub as a ticket provider already ships as a package (P-010).
 */
const EXCLUDED_TOKENS: Record<string, string> = {
  github: 'platform source-hosting identity, not an integration provider',
};

type CensusGroup = 'slack' | 'social' | 'facebook-vault' | 'google-workspace' | 'discord';

/** Where each group's migration is owned. */
export const MIGRATION_OWNERS: Record<CensusGroup, string> = {
  slack: 'provider-adapters-to-packages-2026-10-11#P-008',
  social: 'provider-adapters-to-packages-2026-10-11',
  'facebook-vault': 'provider-adapters-to-packages-2026-10-11',
  'google-workspace': 'provider-adapters-to-packages-2026-10-11',
  discord: 'provider-adapters-to-packages-2026-10-11',
};

interface CensusEntry {
  path: string;
  group: CensusGroup;
  detectedBy: 'path' | 'content';
  /** content entries only: the body must still match this, or the entry is stale. */
  marker?: RegExp;
}

const p = (path: string, group: CensusGroup): CensusEntry => ({ path, group, detectedBy: 'path' });

export const CENSUS: readonly CensusEntry[] = [
  // Slack: cupboard-distributable-integrations-2026-10-10#P-008 deleted what the slack and
  // bug-triage packages replace (SlackSetupCard, the slack:* agent tools, slack-asana-filing,
  // slack-bug-classification; D-019). What remains carries the report-bug gesture system, the
  // in-app socket path (incl. the /admin/triggers/slack/{manifest,connect} routes this doc-claim
  // judges) and the Slack organization data source, all owned by the follow-up item (D-019 ruling 3).
  p('packages/operator-core/lib/data-sources/slack-org-connector.ts', 'slack'),
  p('packages/operator-core/lib/data-sources/slack-realtime-search.ts', 'slack'),
  p('packages/operator-core/lib/doc-claims/slack-external-trigger-setup.ts', 'slack'),
  p('packages/operator-core/lib/external-triggers/slack-credential-ref.ts', 'slack'),
  p('packages/operator-core/lib/external-triggers/slack-flagship.ts', 'slack'),
  p('packages/operator-core/lib/external-triggers/slack-report-bug.ts', 'slack'),
  p('packages/operator-core/lib/external-triggers/slack-socket-manager.ts', 'slack'),
  p('packages/operator-core/lib/external-triggers/slack.ts', 'slack'),
  p('packages/operator-core/lib/harness/routines/slack-org-sync-action.ts', 'slack'),

  // Social platforms: nine platform adapters plus the app-side verbs and tools over them.
  p('packages/operator-core/lib/agent-tools/social/delete.ts', 'social'),
  p('packages/operator-core/lib/agent-tools/social/post.ts', 'social'),
  p('packages/operator-core/lib/agent-tools/social/read.ts', 'social'),
  p('packages/operator-core/lib/agent-tools/social/reply.ts', 'social'),
  p('packages/operator-core/lib/agent-tools/social/search.ts', 'social'),
  p('packages/operator-core/lib/capability-verbs/social-delete.ts', 'social'),
  p('packages/operator-core/lib/capability-verbs/social-read.ts', 'social'),
  p('packages/operator-core/lib/capability-verbs/social.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/adapter-contract.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/bluesky-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/bluesky-write-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/conformance.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/cursor-freshness.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/facebook-comments-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/facebook-common.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/facebook-posts-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/facebook-write-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/instagram-comments-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/instagram-common.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/instagram-write-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/linkedin-common.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/linkedin-write-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/mastodon-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/mastodon-write-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/platform-registry.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/reddit-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/reddit-write-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/social-egress.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/social-watermark.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/storm-policy.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/threads-common.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/threads-conversation-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/threads-write-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/tiktok-common.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/tiktok-videos-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/youtube-activities-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/youtube-comments-adapter.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/youtube-common.ts', 'social'),
  p('packages/operator-core/lib/external-triggers/social/youtube-write-adapter.ts', 'social'),

  // Facebook personal vault.
  p('packages/operator-core/lib/external-triggers/facebook.ts', 'facebook-vault'),
  p('packages/operator-core/lib/harness/routines/facebook-personal-vault-poll-action.ts', 'facebook-vault'),
  {
    path: 'packages/operator-core/lib/integrations/builtin-connection-adapters.ts',
    group: 'facebook-vault',
    detectedBy: 'content',
    marker: /facebook/i,
  },

  // Google Workspace leftovers (Gmail and Calendar already ship as packages).
  p('packages/operator-core/lib/external-triggers/google-workspace.ts', 'google-workspace'),

  // Discord outbound notifications.
  p('apps/operator/app/_components/DiscordChannelLink.tsx', 'discord'),
  p('packages/operator-core/lib/endpoint-route/routes/harness/discord.ts', 'discord'),
  p('packages/operator-core/lib/integrations/discord-webhook-types.ts', 'discord'),
];

/** Lowered by every migration that removes an entry. Raising it needs owner sign-off. */
export const CENSUS_HIGH_WATERMARK = 55;

/**
 * Paths that contain a provider word but are not provider-specific, each with its reason.
 * Keep this short; a provider module does not belong here.
 */
const NOT_PROVIDER_SPECIFIC: Record<string, string> = {};

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec|integration\.test)\.(ts|tsx|mts|js|mjs)$|\.fixture\.ts$/;

/** Split a repo-relative path into lower-case words (dirs, kebab, snake, camelCase). */
export function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Provider tokens named by a path, excluding EXCLUDED_TOKENS. */
export function providerWordsIn(path: string): string[] {
  const tokens = new Set<string>(PROVIDER_TOKENS);
  return [...new Set(pathWords(path).filter((w) => tokens.has(w) && !(w in EXCLUDED_TOKENS)))];
}

function walk(absDir: string, out: string[], root: string): void {
  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const abs = join(absDir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(abs, out, root);
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(relative(root, abs).split(sep).join('/'));
  }
}

/** Every app-code source file under `root` whose path names a provider. */
export function detectProviderSpecificPaths(root = REPO_ROOT): string[] {
  const files: string[] = [];
  for (const r of APP_ROOTS) walk(join(root, r), files, root);
  return files.filter((f) => providerWordsIn(f).length > 0 && !(f in NOT_PROVIDER_SPECIFIC)).sort();
}

/** Provider-specific modules under `root` that the census does not list (growth). */
export function unlistedProviderModules(root: string, census: readonly CensusEntry[]): string[] {
  const listed = new Set(census.map((e) => e.path));
  return detectProviderSpecificPaths(root).filter((f) => !listed.has(f));
}

/** Census entries that no longer describe a provider module under `root` (must be removed). */
export function staleCensusEntries(root: string, census: readonly CensusEntry[]): string[] {
  const detected = new Set(detectProviderSpecificPaths(root));
  const stale: string[] = [];
  for (const e of census) {
    const abs = join(root, e.path);
    if (!existsSync(abs)) {
      stale.push(`${e.path}: file is gone`);
      continue;
    }
    if (e.detectedBy === 'path' && !detected.has(e.path)) stale.push(`${e.path}: path no longer names a provider`);
    if (e.detectedBy === 'content' && !(e.marker && e.marker.test(readFileSync(abs, 'utf8')))) {
      stale.push(`${e.path}: body no longer matches ${String(e.marker)}`);
    }
  }
  return stale;
}

/** Build a throwaway repo root holding `files` (repo-relative path -> body). */
function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-census-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

describe('provider-specific code census (shrink-only)', () => {
  it('detector recognises provider words in every path form it must handle', () => {
    expect(providerWordsIn('apps/operator/app/settings/integrations/SlackSetupCard.tsx')).toEqual(['slack']);
    expect(providerWordsIn('lib/external-triggers/social/bluesky-write-adapter.ts')).toEqual(['social', 'bluesky']);
    expect(providerWordsIn('lib/harness/routines/facebook_personal_vault.ts')).toEqual(['facebook']);
    expect(providerWordsIn('lib/integrations/provider-options.ts')).toEqual([]);
    expect(providerWordsIn('lib/endpoint-route/routes/desktop/github-user.ts')).toEqual([]);
  });

  it('the walk reaches app code (positive control: a non-provider file is seen)', () => {
    const files: string[] = [];
    walk(join(REPO_ROOT, 'packages/operator-core/lib/integrations'), files, REPO_ROOT);
    expect(files).toContain('packages/operator-core/lib/integrations/provider-options.ts');
    expect(files.some((f) => TEST_FILE.test(f))).toBe(false);
  });

  it('control: a new provider module outside the census is caught', () => {
    const root = fixtureRoot({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export {};\n',
      'packages/operator-core/lib/external-triggers/slack.ts': 'export {};\n',
      'apps/operator/app/settings/integrations/DiscordBridgeCard.tsx': 'export {};\n',
      'packages/operator-core/lib/external-triggers/slack.test.ts': 'export {};\n',
    });
    try {
      const census = [p('packages/operator-core/lib/external-triggers/slack.ts', 'slack')];
      expect(unlistedProviderModules(root, census)).toEqual([
        'apps/operator/app/settings/integrations/DiscordBridgeCard.tsx',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: a deleted, renamed or emptied census entry is reported stale', () => {
    const root = fixtureRoot({
      'packages/operator-core/lib/external-triggers/chat-bridge.ts': 'export {};\n',
      'packages/operator-core/lib/integrations/builtin-connection-adapters.ts': 'export const adapters = [];\n',
    });
    try {
      const census: CensusEntry[] = [
        p('packages/operator-core/lib/external-triggers/slack.ts', 'slack'),
        p('packages/operator-core/lib/external-triggers/chat-bridge.ts', 'slack'),
        {
          path: 'packages/operator-core/lib/integrations/builtin-connection-adapters.ts',
          group: 'facebook-vault',
          detectedBy: 'content',
          marker: /facebook/i,
        },
      ];
      expect(staleCensusEntries(root, census)).toEqual([
        'packages/operator-core/lib/external-triggers/slack.ts: file is gone',
        'packages/operator-core/lib/external-triggers/chat-bridge.ts: path no longer names a provider',
        'packages/operator-core/lib/integrations/builtin-connection-adapters.ts: body no longer matches /facebook/i',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no provider-specific module exists in app code outside the census', () => {
    expect(
      unlistedProviderModules(REPO_ROOT, CENSUS),
      `New provider-specific modules in app code. Ship the integration as a provider package in ` +
        `libs/papercusp/plugins instead (see /internal/docs/plugins). Growing the census needs owner sign-off.`,
    ).toEqual([]);
  });

  it('every census entry still exists and is still provider-specific (stale entries must be removed)', () => {
    expect(
      staleCensusEntries(REPO_ROOT, CENSUS),
      'Remove these entries from CENSUS and lower CENSUS_HIGH_WATERMARK.',
    ).toEqual([]);
  });

  it('the census is exact and its watermark only ratchets down', () => {
    expect(new Set(CENSUS.map((e) => e.path)).size).toBe(CENSUS.length);
    expect(CENSUS.length).toBe(CENSUS_HIGH_WATERMARK);
  });

  it('every census group has an owned migration', () => {
    for (const e of CENSUS) expect(MIGRATION_OWNERS[e.group], e.path).toMatch(/\S/);
  });
});
