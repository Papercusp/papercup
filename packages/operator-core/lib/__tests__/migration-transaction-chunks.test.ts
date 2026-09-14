import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrationTransactionChunks } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const modulePath = fileURLToPath(new URL(
  '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
  import.meta.url,
));

describe('migration transaction chunk filtering', () => {
  it('preserves ordinary migrations and SQL while dropping empty/comment-only breakpoint chunks', () => {
    expect(migrationTransactionChunks('-- ordinary migration\nSELECT 1;'))
      .toEqual(['-- ordinary migration\nSELECT 1;']);
    expect(migrationTransactionChunks(
      '-- comment only\n  -- second\n--> statement-breakpoint\n'
      + 'SELECT 1;\n--> statement-breakpoint\n \n'
      + '-- trailing comment\n--> statement-breakpoint\n'
      + "-- retained SQL comment\nSELECT '-- string, not a comment';",
    )).toEqual(['SELECT 1;', "-- retained SQL comment\nSELECT '-- string, not a comment';"]);
    expect(migrationTransactionChunks('-- only\r\n \r\n  -- comments\r\n--> statement-breakpoint'))
      .toEqual([]);
  });

  it('finishes adversarial comment prefixes; the previous matcher fails the same bounded probe', () => {
    // Both algorithms run out of process: reintroducing the bug must fail
    // this test, not wedge Vitest's own event loop and defeat its timeout.
    const input = '-- repeated '.repeat(4_000) + '\nSELECT 1;';
    const run = (code: string) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      input,
      encoding: 'utf8',
      timeout: 3_000,
      killSignal: 'SIGKILL',
    });
    const prelude = "import {readFileSync} from 'node:fs';const input=readFileSync(0,'utf8');console.log('entered');";
    const fixed = run(prelude
      + `const {migrationTransactionChunks}=await import(${JSON.stringify(modulePath)});`
      + "const out=migrationTransactionChunks(input+'\\n--> statement-breakpoint');"
      + "console.log(JSON.stringify({count:out.length,exact:out[0]===input}));");
    expect(fixed.error, fixed.stderr).toBeUndefined();
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(fixed.stdout).toContain('{"count":1,"exact":true}');

    // Faithful previous predicate, used only as an isolated negative control.
    const previous = run(prelude + String.raw`console.log(/^(\s*--[^\n]*\n?)+$/.test(input));`);
    expect(previous.stdout).toBe('entered\n');
    expect(previous.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(previous.signal).toBe('SIGKILL');
  }, 15_000);
});
