/**
 * Pure admission-rule matching and validation (plan enterprise-data-sources-2026-10-01 P-020,
 * D-004, D-030). The integration test (data-sources/ticket-admission.integration.test.ts) proves
 * the rules admit real tickets; this file pins the matcher's semantics without a database.
 */
import { describe, expect, it } from 'vitest';
import { matchAdmissionRule, validateAdmissionMatch, type AdmissionMatch } from './admission-rules';

const ticket = {
  state: 'open',
  project: 'Tulip',
  priority: 2,
  blocked: false,
  assignees: ['papercusp-agents', 'carol-gh'],
  labels: ['bug'],
};

describe('matchAdmissionRule', () => {
  it('matches eq case-insensitively on strings, numbers and booleans', () => {
    expect(matchAdmissionRule({ project: { eq: 'tulip' } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ priority: { eq: 2 } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ priority: { eq: '2' } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ blocked: { eq: false } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ project: { eq: 'rose' } }, ticket)).toBe(false);
  });

  it('matches in against a list of scalars', () => {
    expect(matchAdmissionRule({ state: { in: ['closed', 'OPEN'] } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ state: { in: ['closed'] } }, ticket)).toBe(false);
  });

  it('matches contains only against an array field', () => {
    expect(matchAdmissionRule({ assignees: { contains: 'papercusp-agents' } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ assignees: { contains: 'dave-gh' } }, ticket)).toBe(false);
    // A scalar field never satisfies contains, even when the value is a substring.
    expect(matchAdmissionRule({ project: { contains: 'tul' } }, ticket)).toBe(false);
  });

  it('requires every field condition to hold', () => {
    const both: AdmissionMatch = { assignees: { contains: 'papercusp-agents' }, labels: { contains: 'bug' } };
    expect(matchAdmissionRule(both, ticket)).toBe(true);
    expect(matchAdmissionRule(both, { ...ticket, labels: ['feature'] })).toBe(false);
  });

  it('never matches a missing field, an empty match, or an unknown operator', () => {
    expect(matchAdmissionRule({ milestone: { eq: 'v1' } }, ticket)).toBe(false);
    expect(matchAdmissionRule({ assignees: { contains: 'x' } }, { ...ticket, assignees: undefined })).toBe(false);
    expect(matchAdmissionRule({}, ticket)).toBe(false);
    expect(matchAdmissionRule({ state: { like: 'op%' } } as unknown as AdmissionMatch, ticket)).toBe(false);
  });

  it('never treats an object or null field as a scalar', () => {
    expect(matchAdmissionRule({ owner: { eq: '[object Object]' } }, { owner: { login: 'x' } })).toBe(false);
    expect(matchAdmissionRule({ owner: { eq: 'null' } }, { owner: null })).toBe(false);
  });
});

describe('validateAdmissionMatch', () => {
  it('accepts well-formed matches', () => {
    expect(() => validateAdmissionMatch({ assignees: { contains: 'papercusp-agents' } })).not.toThrow();
    expect(() => validateAdmissionMatch({ state: { in: ['open', 'reopened'] }, priority: { eq: 1 } })).not.toThrow();
  });

  it.each([
    ['a non-object', 'assignees', /match must be an object/],
    ['an array', [], /match must be an object/],
    ['an empty match', {}, /at least one field/],
    ['an empty field name', { ' ': { eq: 'x' } }, /empty field name/],
    ['a field without a condition object', { state: 'open' }, /must map to/],
    ['a field with no operator', { state: {} }, /has no condition/],
    ['an unknown operator', { state: { like: 'op%' } }, /unknown operator 'like'/],
    ['an empty in list', { state: { in: [] } }, /non-empty array of scalars/],
    ['an in list with an object', { state: { in: [{ a: 1 }] } }, /non-empty array of scalars/],
    ['a non-scalar eq value', { state: { eq: ['open'] } }, /must be a string, number or boolean/],
    ['a null contains value', { assignees: { contains: null } }, /must be a string, number or boolean/],
  ])('rejects %s', (_label, match, why) => {
    expect(() => validateAdmissionMatch(match)).toThrow(/^admission_rule_invalid/);
    expect(() => validateAdmissionMatch(match)).toThrow(why);
  });
});
