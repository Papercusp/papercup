/**
 * posttooluse-migration-forward-compat-nudge — the recurrence guard for the
 * "destructive migration DDL discovered only at the gate" CLASS
 * (EI-19462877357083817; incidents WI-6842, EI-19407054630567497, WI-9573/WI-9591).
 *
 * Mirrors posttooluse-migration-fixture-drift-nudge.test.ts's shape. The point is
 * not "the hook is well-formed" but that it fires against the REAL rule exported
 * from scripts/check-migration-forward-compat.mjs — the same `violationsFor` /
 * `ACK_MARKER` the green-checkpoint leg runs — rather than a stand-in. If the
 * hook ever re-implements the rule locally, the drift block below fails.
 *
 * ⚠ THIS FILE LIVES HERE ON PURPOSE. `test:affected` maps
 * apps/operator/scripts/** into @papercusp/web, NOT @papercusp/operator-core
 * (measured via `affected-tests.mjs --changed-paths <this hook>`), so a test for
 * this hook placed in operator-core would never be selected when the hook is
 * edited. The complementary rubber-stamp/next-migration cases live in
 * packages/operator-core/lib/migration-forward-compat-authoring.test.ts, which IS
 * selected when the lint itself changes.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-migration-forward-compat-nudge.mjs');
const HOOK_BASENAME = 'posttooluse-migration-forward-compat-nudge.mjs';

const DROP = 'DROP INDEX IF EXISTS harness_shared.memory_canonical_current;';
const REAL_ACK = '-- FORWARD-COMPAT: non-unique btree, cannot be an ON CONFLICT arbiter';

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
    isCandidateFile: (p: string) => boolean;
    effectiveMigrationName: (p: string) => string;
  };
}

/** The REAL rule module the green-checkpoint leg uses. */
async function realDetector() {
  return await import(`file://${resolve(ROOT, 'scripts/check-migration-forward-compat.mjs')}`);
}

async function deps(text: string) {
  const detector = await realDetector();
  return {
    exists: () => true,
    sizeOf: () => text.length,
    readFile: () => text,
    loadDetector: async () => detector,
  };
}

/** A migration number safely inside the enforced range. */
async function enforcedPath(suffix = '') {
  const { ENFORCE_FROM } = (await realDetector()) as { ENFORCE_FROM: number };
  return `/repo/libs/papercusp/libs/db/sql/${ENFORCE_FROM + 60}-drop-something.sql${suffix}`;
}

describe('fires against the real detector on the shape that actually reached the gate', () => {
  it('nudges on an unacknowledged DROP INDEX — the WI-9591 shape', async () => {
    const { nudgeFor } = await loadHook();
    const msg = await nudgeFor(await enforcedPath(), await deps(DROP));
    expect(msg).toBeTruthy();
    expect(msg).toContain('[drop-index]');
    // It must tell the author the exact remedy, not just that something is wrong.
    expect(msg).toContain('-- FORWARD-COMPAT:');
  });

  it('nudges on a partial UNIQUE INDEX — the original EI-18797473716313783 hazard', async () => {
    const { nudgeFor } = await loadHook();
    const sql = 'CREATE UNIQUE INDEX i ON harness_shared.agent_facts (a, b) WHERE superseded_at IS NULL;';
    const msg = await nudgeFor(await enforcedPath(), await deps(sql));
    expect(msg).toContain('[narrowing-unique-index]');
  });

  it('goes silent once a real acknowledgment is present', async () => {
    const { nudgeFor } = await loadHook();
    expect(await nudgeFor(await enforcedPath(), await deps(`${REAL_ACK}\n${DROP}`))).toBeNull();
  });

  it('stays silent on additive DDL', async () => {
    const { nudgeFor } = await loadHook();
    const sql = 'CREATE INDEX IF NOT EXISTS i ON harness_shared.x (id);';
    expect(await nudgeFor(await enforcedPath(), await deps(sql))).toBeNull();
  });

  it('is not fooled by DDL keywords appearing only in prose', async () => {
    const { nudgeFor } = await loadHook();
    const sql = '-- we used to DROP INDEX here and DROP COLUMN too\nSELECT 1;';
    expect(await nudgeFor(await enforcedPath(), await deps(sql))).toBeNull();
  });

  it('ignores historical migrations, which are immutable and cannot be fixed', async () => {
    const { nudgeFor } = await loadHook();
    const { ENFORCE_FROM } = (await realDetector()) as { ENFORCE_FROM: number };
    const old = `/repo/libs/papercusp/libs/db/sql/${ENFORCE_FROM - 1}-old.sql`;
    expect(await nudgeFor(old, await deps(DROP))).toBeNull();
  });

  it('fails OPEN when the detector cannot be resolved', async () => {
    const { nudgeFor } = await loadHook();
    const d = { ...(await deps(DROP)), loadDetector: async () => null };
    expect(await nudgeFor(await enforcedPath(), d)).toBeNull();
  });
});

describe('covers the DRAFT window — where migrations are actually authored', () => {
  it('fires on a .DRAFT file', async () => {
    const { nudgeFor } = await loadHook();
    const msg = await nudgeFor(await enforcedPath('.DRAFT'), await deps(DROP));
    expect(msg).toContain('[drop-index]');
  });

  it.each([['.DRAFT'], ['.PENDING-CODE-DEPLOY']])('treats %s as the migration it will become', async (suffix) => {
    const { isCandidateFile, effectiveMigrationName } = await loadHook();
    expect(isCandidateFile(`libs/papercusp/libs/db/sql/750-x.sql${suffix}`)).toBe(true);
    expect(effectiveMigrationName(`/a/b/750-x.sql${suffix}`)).toBe('750-x.sql');
  });

  it('ignores archived and non-migration paths', async () => {
    const { isCandidateFile } = await loadHook();
    expect(isCandidateFile('libs/papercusp/libs/db/sql/archive/001-x.sql')).toBe(false);
    expect(isCandidateFile('apps/operator/lib/foo.ts')).toBe(false);
  });
});

describe('the hook is WIRED, not merely present', () => {
  // A nudge file that exists but is registered nowhere is inert — it reads as done
  // and guards nothing. Both registration sites live in papercusp-files.ts: the
  // installed-files list, and the settings.json merge. Missing either one silently
  // disables the hook.
  const source = readFileSync(
    resolve(ROOT, 'packages/operator-core/lib/desktop-install/papercusp-files.ts'),
    'utf8',
  );

  it('is in the installed-files list', () => {
    expect(source).toContain(`'${HOOK_BASENAME}'`);
  });

  it('is merged into the PostToolUse hooks with an Edit|Write|MultiEdit matcher', () => {
    const escapedBasename = HOOK_BASENAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const registration = new RegExp(
      String.raw`replaceOurHookEntries\(\s*ev\('PostToolUse'\),\s*ours\('${escapedBasename}'\),\s*\{[\s\S]{0,400}?matcher:\s*'Edit\|Write\|MultiEdit'`,
    );
    expect(
      source.match(registration),
      'no PostToolUse merge entry for the forward-compat nudge with an Edit|Write|MultiEdit matcher',
    ).not.toBeNull();
  });
});

describe('embedded self-test', () => {
  it('passes, so the hook can be validated standalone on an installed box', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });
});
