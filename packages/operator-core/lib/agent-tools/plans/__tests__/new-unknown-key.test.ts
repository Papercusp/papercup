/**
 * plans:new — unrecognized top-level keys must fail loudly (EI-8285).
 *
 * Before this fix, argsSchema was a plain z.object() (no .strict()), so an
 * an unknown key was SILENTLY STRIPPED by zod's default
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
  it('accepts the canonical `content` field shared with plans:set-content', () => {
    expect(() => argsSchema.parse({ ...base, content: '# Demo\n\n## Now\n\nReady.\n' })).not.toThrow();
  });

  it('rejects any other unrecognized top-level key', () => {
    expect(() => argsSchema.parse({ ...base, bogus: true })).toThrow();
  });

  it('accepts every documented canonical key', () => {
    expect(() =>
      argsSchema.parse({ ...base, content: '## Now\n\nReady.\n', rationale: 'why', ownerEmail: 'a@b.com', force: true, status: 'active', harness: 'papercusp' }),
    ).not.toThrow();
  });

  it.each(['body', 'description', 'owner'])('rejects deprecated alpha-stage key `%s`', (key) => {
    expect(() => argsSchema.parse({ ...base, [key]: key === 'owner' ? 'a@b.com' : '## Now\n' })).toThrow();
  });
});
