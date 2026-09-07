import { describe, expect, it } from 'vitest';
import {
  capabilityClassRef,
  normalizeCapabilityClassId,
  parseCapabilityClassRef,
  validateProviderInterface,
  type CapabilityClassRow,
  type ProviderToolContract,
} from './capability-class-registry-store';

const capabilityClass = (overrides: Partial<CapabilityClassRow> = {}): CapabilityClassRow => ({
  id: 'crm.email',
  version: '1.0.0',
  ref: 'crm.email@1.0.0',
  workspaceId: 'ws-a',
  title: 'CRM email',
  description: 'Send a templated email through a customer record provider.',
  interfaceVerbs: {
    send: {
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string' }, contactId: { type: 'string' } },
        required: ['contactId', 'body'],
      },
      outputSchema: {
        type: 'object',
        properties: { messageId: { type: 'string' } },
        required: ['messageId'],
      },
    },
  },
  behavioralSuiteRef: null,
  status: 'active',
  published: false,
  reviewStatus: 'none',
  tags: ['crm', 'email'],
  hasEmbedding: false,
  createdBy: 'operator',
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
  ...overrides,
});

const providerTool = (overrides: Partial<ProviderToolContract> = {}): ProviderToolContract => ({
  name: 'acme:send-email',
  pluginName: 'acme-crm',
  // Deliberately reverse property insertion order. Structural comparison is
  // canonical, never JSON.stringify insertion-order theatre.
  inputSchema: {
    required: ['contactId', 'body'],
    properties: { contactId: { type: 'string' }, body: { type: 'string' } },
    type: 'object',
  },
  outputSchema: {
    required: ['messageId'],
    properties: { messageId: { type: 'string' } },
    type: 'object',
  },
  ...overrides,
});

describe('capability class identity', () => {
  it('normalizes namespace/job spelling and round-trips an exact versioned ref', () => {
    expect(normalizeCapabilityClassId(' CRM / Email ')).toBe('crm-email');
    expect(normalizeCapabilityClassId('CRM.Email')).toBe('crm.email');
    expect(capabilityClassRef('CRM.Email', '1.2.3')).toBe('crm.email@1.2.3');
    expect(parseCapabilityClassRef('crm.email@1.2.3')).toEqual({ id: 'crm.email', version: '1.2.3' });
    expect(parseCapabilityClassRef('crm.email')).toBeNull();
  });
});

describe('validateProviderInterface', () => {
  it('passes only from the real provider-owned tool contract and ignores JSON object key order', () => {
    const report = validateProviderInterface({
      capabilityClass: capabilityClass(),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'acme:send-email' },
      lookup: (name) => name === 'acme:send-email' ? providerTool() : null,
    });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      { verb: 'send', tool: 'acme:send-email', ok: true, problems: [] },
    ]);
    expect(report.behavioral).toEqual({ status: 'not-required', suiteRef: null });
  });

  it('refuses absent tools, wrong package ownership, schema drift and undeclared extra verbs', () => {
    const wrongOwner = validateProviderInterface({
      capabilityClass: capabilityClass(),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'other:send', extra: 'acme:extra' },
      lookup: (name) => name === 'other:send'
        ? providerTool({ name, pluginName: 'other-vendor', inputSchema: { type: 'null' } })
        : name === 'acme:extra'
          ? providerTool({ name })
          : null,
    });
    expect(wrongOwner.ok).toBe(false);
    expect(wrongOwner.checks.find((check) => check.verb === 'send')?.problems).toEqual(
      expect.arrayContaining([
        'tool is owned by other-vendor, not provider package acme-crm',
        'input schema differs from the class contract',
      ]),
    );
    expect(wrongOwner.checks.find((check) => check.verb === 'extra')?.problems).toEqual([
      'binding names a verb the class does not declare',
    ]);

    const absent = validateProviderInterface({
      capabilityClass: capabilityClass(),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'missing:tool' },
      lookup: () => null,
    });
    expect(absent.ok).toBe(false);
    expect(absent.checks[0]?.problems).toContain('tool is not present in the live projected-tool registry');
  });

  it('reports a behavioral suite as not-run instead of laundering structural success into behavior proof', () => {
    const report = validateProviderInterface({
      capabilityClass: capabilityClass({ behavioralSuiteRef: 'suite:crm-email-v1' }),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'acme:send-email' },
      lookup: () => providerTool(),
    });
    expect(report.ok).toBe(true);
    expect(report.behavioral).toEqual({ status: 'not-run', suiteRef: 'suite:crm-email-v1' });
  });
});

