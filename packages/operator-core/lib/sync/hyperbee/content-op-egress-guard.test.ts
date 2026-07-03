import { describe, expect, it } from 'vitest';
import {
  CONTENT_OP_REDACT_FIELD,
  REDACTED_CONTENT_LINE,
  redactContentOpValueForEgress,
  redactSecretBearingLines,
} from './content-op-egress-guard';
import { _testing as factTesting } from './projections/agent-facts';
import { _testing as eliteTesting } from './projections/gym-qd-elites';

// A well-formed AWS access-key id — matched by the secrets-guard 'aws-access-key-id' rule.
const SECRET = 'AKIA1234567890ABCDEF';

describe('redactSecretBearingLines', () => {
  it('redacts only the secret-bearing line, names the rule, keeps the rest', () => {
    const out = redactSecretBearingLines(
      ['keep me', `export AWS_KEY=${SECRET}`, 'and keep me too'].join('\n'),
      'agent-facts-by-key.body',
    );
    expect(out.redacted).toBe(true);
    expect(out.content).toContain('keep me');
    expect(out.content).toContain('and keep me too');
    expect(out.content).toContain(REDACTED_CONTENT_LINE);
    expect(out.content).toContain('aws-access-key-id');
    expect(out.content).not.toContain(SECRET);
  });

  it('is a no-op (original content, redacted:false) when there is no secret', () => {
    const clean = 'a perfectly ordinary rationale\nwith two lines';
    const out = redactSecretBearingLines(clean, 'x.y');
    expect(out.redacted).toBe(false);
    expect(out.content).toBe(clean);
  });
});

describe('redactContentOpValueForEgress', () => {
  it('redacts a shareable fact op body (agent-facts-by-key)', () => {
    const value = { harness_slug: 'h', scope: 'harness', scope_ref: 'h', key: 'k', body: `note ${SECRET}` };
    const out = redactContentOpValueForEgress('agent-facts-by-key', value);
    expect(out.redacted).toBe(true);
    expect((out.value as { body: string }).body).not.toContain(SECRET);
    expect((out.value as { body: string }).body).toContain(REDACTED_CONTENT_LINE);
    // other fields untouched + caller's object not mutated
    expect((out.value as { key: string }).key).toBe('k');
    expect(value.body).toBe(`note ${SECRET}`);
  });

  it('redacts a federatable elite op rationale (gym-qd-elites-by-niche), preserving other fields', () => {
    const value = { niche_key: 'v1:loop/guard/r1/s', rationale: `won because ${SECRET}`, fitness: 3 };
    const out = redactContentOpValueForEgress('gym-qd-elites-by-niche', value);
    expect(out.redacted).toBe(true);
    expect((out.value as { rationale: string }).rationale).not.toContain(SECRET);
    expect((out.value as { niche_key: string }).niche_key).toBe('v1:loop/guard/r1/s');
    expect((out.value as { fitness: number }).fitness).toBe(3);
  });

  it('is a no-op for a clean value, an unknown tag, a null field, and a non-object', () => {
    const clean = { body: 'nothing secret here' };
    expect(redactContentOpValueForEgress('agent-facts-by-key', clean)).toEqual({ value: clean, redacted: false });
    // unknown tag — value returned unchanged (same ref)
    const other = { body: `leak ${SECRET}` };
    expect(redactContentOpValueForEgress('hive-members', other).redacted).toBe(false);
    // null rationale
    expect(redactContentOpValueForEgress('gym-qd-elites-by-niche', { rationale: null }).redacted).toBe(false);
    // non-object
    expect(redactContentOpValueForEgress('agent-facts-by-key', 'a string').redacted).toBe(false);
    expect(redactContentOpValueForEgress('agent-facts-by-key', undefined).redacted).toBe(false);
  });

  it('maps exactly the two content tables that carry agent-authored free text', () => {
    expect(CONTENT_OP_REDACT_FIELD).toEqual({
      'agent-facts-by-key': 'body',
      'gym-qd-elites-by-niche': 'rationale',
    });
  });

  it('a redacted wire row still passes the receiver validators (redaction never breaks apply)', () => {
    const factRow = {
      harness_slug: 'hive-a',
      scope: 'harness',
      scope_ref: 'hive-a',
      key: 'k1',
      body: `leaked ${SECRET}`,
      source_ref: null,
      expires_at: '2027-01-01T00:00:00.000Z',
      retracted_at: null,
      created_by: 'agent-1',
    };
    expect(factTesting.isAgentFactWireRow(factRow)).toBe(true);
    const redFact = redactContentOpValueForEgress('agent-facts-by-key', factRow).value;
    expect(factTesting.isAgentFactWireRow(redFact)).toBe(true);
    expect((redFact as { body: string }).body).not.toContain(SECRET);

    const eliteRow = {
      harness_slug: 'hive-a',
      niche_key: 'v1:loop/guard/r1/s',
      candidate_id: 'c1',
      scope: 'local',
      domain: 'planning',
      risk: 'low',
      fitness: 4,
      descriptor: { coords: {} },
      rationale: `won via ${SECRET}`,
      federatable: true,
      updated_at: 1_700_000_000_000,
    };
    expect(eliteTesting.isGymQdEliteWireRow(eliteRow)).toBe(true);
    const redElite = redactContentOpValueForEgress('gym-qd-elites-by-niche', eliteRow).value;
    expect(eliteTesting.isGymQdEliteWireRow(redElite)).toBe(true);
    expect((redElite as { rationale: string }).rationale).not.toContain(SECRET);
  });
});
