import { describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Historical migrations and fixtures may name the retired schema. Operational
// scripts must address the canonical tables after the compatibility views retire.
function referencesRetiredSchema(source: string, fileName = 'script.mjs'): boolean {
  return /\bpapercup_shared\s*\./.test(stripCommentsOnly(source, fileName));
}

describe('local physical rename contract', () => {
  it('keeps the canonical monorepo identity in both npm manifests', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    expect(pkg.name).toBe('@papercupai/papercusp-monorepo');
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[''].name).toBe(pkg.name);
  });

  it('detects retired SQL references while allowing canonical SQL and history comments', () => {
    expect(referencesRetiredSchema('await sql`SELECT * FROM papercup_shared.briefings`')).toBe(true);
    expect(referencesRetiredSchema('await sql`SELECT * FROM papercusp_shared.briefings`')).toBe(false);
    expect(referencesRetiredSchema('// formerly papercup_shared.briefings\nawait sql`SELECT 1`')).toBe(false);
  });

  it('keeps operational scripts off the retired shared schema', () => {
    const files = globSync('scripts/**/*.{mjs,mts,ts}', {
      cwd: ROOT,
      exclude: ['scripts/**/node_modules/**', 'scripts/**/.*'],
    });
    expect(files).toContain('scripts/backfill-briefings.mjs');
    const offenders = files.filter((file) =>
      referencesRetiredSchema(readFileSync(join(ROOT, file), 'utf8'), file),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps current local runtime defaults and recovery guidance off retired operator unit names', () => {
    // Compatibility-input maps, historical benchmarks and systemd template path
    // identities are outside this check; those can intentionally retain aliases.
    const files = globSync([
      'apps/operator/scripts/psu-launcher.mjs',
      'apps/operator/scripts/hooks/cc/posttooluse-ts-parse-nudge.mjs',
      'packages/operator-core/lib/agent-tools/plans/rubric-template.ts',
      'packages/operator-core/lib/release-checkpoint-launch.ts',
      'packages/operator-core/lib/admin-commands.ts',
      'packages/operator-core/lib/console-spawn.ts',
      'packages/operator-core/lib/memory/embed-sidecar-spawn.ts',
      'packages/operator-core/lib/scout/generation-watermark.ts',
      'packages/operator-core/lib/system-health/service-restart-rate-watchdog.ts',
      'packages/operator-core/lib/search/embed-coverage.ts',
      'packages/operator-core/lib/search/session-ingest-lag-watchdog.ts',
      'packages/operator-core/lib/harness/routines/seed-*routine.ts',
    ], { cwd: ROOT });
    expect(files).toContain('packages/operator-core/lib/scout/generation-watermark.ts');
    const offenders = files.filter((file) =>
      /\bpapercup-(?:dev-api|staging-api|bg-host)\b/.test(
        stripCommentsOnly(readFileSync(join(ROOT, file), 'utf8'), file),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
