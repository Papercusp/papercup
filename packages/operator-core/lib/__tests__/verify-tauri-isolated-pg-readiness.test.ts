import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(resolve(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
// Execute the maintained parent loop itself; replace only the clock/process
// fixtures so a 600-second bound is exercised without sleeping or booting PG.
const start = source.indexOf('  ISOLATED_PG_ELAPSED=0\n');
const end = source.indexOf('  ISOLATED_PG_READY_LINE=', start);
if (start < 0 || end < 0) throw new Error('Isolated PG readiness loop was not found');
const loop = source.slice(start, end);

function run(mode: string, window = 2) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tauri-pg-readiness-'));
  try {
    return execFileSync('bash', ['-c', `
set -euo pipefail
ISOLATED_PG_LOG="$FIXTURE_DIR/pg.log"
ISOLATED_PG_PID=$$
ISOLATED_PG_TIMEOUT="$FIXTURE_WINDOW"
: > "$ISOLATED_PG_LOG"
ticks=0
isolated_pg_elapsed() { printf '%s\\n' "$ticks"; }
log() { echo "$*"; }
kill() { return 0; }
sleep() {
  ticks=$((ticks + 1))
  case "$FIXTURE_MODE" in
    advancing-ready)
      echo "PG_PROGRESS migration=$ticks.sql" >> "$ISOLATED_PG_LOG"
      if [ "$ticks" -eq 5 ]; then echo 'PG_READY port=1234' >> "$ISOLATED_PG_LOG"; fi
      ;;
    stalled) if [ "$ticks" -eq 1 ]; then echo 'PG_PROGRESS migration=first.sql' >> "$ISOLATED_PG_LOG"; fi ;;
    notices) echo 'NOTICE index renamed' >> "$ISOLATED_PG_LOG" ;;
    endless) echo "PG_PROGRESS migration=$ticks.sql" >> "$ISOLATED_PG_LOG" ;;
  esac
}
${loop}
echo 'READY_VERIFIED'
`], { env: { ...process.env, REPO_DIR: repo, FIXTURE_DIR: dir, FIXTURE_MODE: mode,
      FIXTURE_WINDOW: String(window) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { status: failure.status, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? '') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('native isolated PG readiness parent', () => {
  it('keeps an advancing migration boot alive past the initial deadline, then accepts ready', () => {
    const result = run('advancing-ready');
    expect(result).toEqual(expect.stringContaining('READY_VERIFIED'));
    expect(result).toEqual(expect.stringContaining('PG_BOOT_PROGRESS elapsed=2s'));
  });

  it('rejects a migration boot that stopped advancing', () => {
    expect(run('stalled')).toMatchObject({ status: 1, stderr: expect.stringContaining('progress-stalled after 4s') });
  });

  it('does not interpret harmless notices as forward progress', () => {
    expect(run('notices')).toMatchObject({ status: 1, stderr: expect.stringContaining('progress-unknown after 2s') });
  });

  it('enforces the absolute ceiling even while progress keeps arriving', () => {
    expect(run('endless', 300)).toMatchObject({ status: 1, stderr: expect.stringContaining('absolute-ceiling after 600s') });
  });
});
