/**
 * plans:new — unrecognized top-level keys must fail loudly (EI-8285).
 *
 * Before this fix, argsSchema was a plain z.object() (no .strict()), so an
 * unknown key like `content` (a natural-but-wrong name — plans:set-content's
 * field is literally `content`) was SILENTLY STRIPPED by zod's default
 * "strip unknown keys" behavior. The call still returned `ok:true` and
 * created a plan, but with the EMPTY starter template — the caller's actual
 * body was dropped without any error, discoverable only on a later
 * plans:get. `.strict()` turns that into a loud `invalid_args`-class zod
 * validation failure instead, at the exact point of the typo.
 *
 * (whole-app-test-coverage-breadth — pure schema test, no PG / lock fixture.)
 */
import { describe, expect, it } from 'vitest';
import { argsSchema } from '../new';

const base = { slug: 'demo-plan', title: 'Demo plan' };

describe('plans:new unknown-key rejection (EI-8285)', () => {
  it('rejects the exact regression case: `content` instead of `body`', () => {
    expect(() =>
      argsSchema.parse({ ...base, content: '# Demo\n\n## Now\n\nReady.\n' }),
    ).toThrow();
  });

  it('rejects any other unrecognized top-level key', () => {
    expect(() => argsSchema.parse({ ...base, bogus: true })).toThrow();
  });

  it('still accepts every documented key, including body', () => {
    expect(() =>
      argsSchema.parse({ ...base, body: '## Now\n\nReady.\n', rationale: 'why', owner: 'a@b.com', force: true, status: 'active', harness: 'papercusp' }),
    ).not.toThrow();
  });
});
