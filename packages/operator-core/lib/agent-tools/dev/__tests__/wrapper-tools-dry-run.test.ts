/**
 * Unit: the dev:restart / db:migrate dry-run paths (P-027).
 *
 * Dry run (no `confirm`) must be ctx-free and side-effect-free: it takes no
 * lock, drains nobody, and runs no command — it only reports what it would
 * do. Pure handler test, no DB / no ctx.
 */

import { describe, it, expect } from 'vitest';
import devRestart from '../restart';
import dbMigrate from '../../db/migrate';

function textOf(res: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(res.content[0].text);
}

describe('wrapper-tool dry runs', () => {
  it('dev:restart without confirm is a dry run that takes no lock', async () => {
    const res = await devRestart.handler({}, {} as never);
    const out = textOf(res as never);
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.would_run).toContain('systemctl');
  });

  it('db:migrate without confirm is a dry run that takes no lock', async () => {
    const res = await dbMigrate.handler({ file: '/tmp/x.sql' }, {} as never);
    const out = textOf(res as never);
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.would_run).toContain('/tmp/x.sql');
  });
});
