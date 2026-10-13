import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOSTED_CONTROL_PLANE_FIELD_REGISTRY,
  HOSTED_RELAY_FRAME_REGISTRY,
  PLAINTEXT_CONSUMERS,
} from './hosted-relay-confidentiality-registry';

const REPO = resolve(__dirname, '../../../..');

/** Every source that defines or dispatches a hosted relay frame type. */
const FRAME_SOURCES = [
  'packages/operator-core/lib/workspace-host/hosted-session-host.ts',
  'packages/operator-core/lib/workspace-host/hosted-app-relay.ts',
  'packages/operator-core/lib/workspace-host/hosted-operator-http.ts',
  'packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts',
  'apps/operator/app/cloud-workspaces/hosted-desktop-viewer-protocol.ts',
  'apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol.ts',
];

/**
 * Literals the frame-type regex also matches that are NOT frame types: channel/open
 * kinds (`HostedHostOpenKind`), handoff discriminants and a `typeof` check.
 */
const NON_FRAME_LITERALS = new Set([
  'pty', 'psu', 'desktop', 'operator-http', 'app-http', 'app-key-mint',
  'file', 'directory', 'string', 'enrollment', 'session',
]);

const FRAME_RE = /(?:case|type ===|type !==|type:)\s*(['"])([a-z0-9_.-]+)\1/g;

function frameLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const rel of FRAME_SOURCES) {
    const src = readFileSync(resolve(REPO, rel), 'utf8');
    for (const m of src.matchAll(FRAME_RE)) {
      const lit = m[2]!;
      if (NON_FRAME_LITERALS.has(lit)) continue;
      found.set(lit, [...(found.get(lit) ?? []), rel]);
    }
  }
  return found;
}

function interfaceKeys(rel: string, name: string): string[] {
  const src = readFileSync(resolve(REPO, rel), 'utf8');
  const start = src.indexOf(`export interface ${name} {`);
  expect(start, `${name} not found in ${rel}`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...body.matchAll(/^\s+([a-zA-Z]+)\??:/gm)].map((m) => m[1]!);
}

/** Scan the literal INSERT column lists, including every writer of this table. */
function routeInvocationColumns(source: string): string[] {
  const columns = new Set<string>();
  const inserts = /\bINSERT\s+INTO\s+harness_shared\.route_invocations\s*\(([^)]+)\)/gi;
  for (const match of source.matchAll(inserts)) {
    for (const column of match[1]!.split(',')) columns.add(column.trim());
  }
  return [...columns].sort();
}

describe('hosted relay confidentiality registry (P-001)', () => {
  it('classifies every frame type literal in the relay sources', () => {
    const found = frameLiterals();
    // Positive control: the scan must see a known content frame, or it is blind.
    expect(found.has('pty.output')).toBe(true);
    expect(found.has('http.request')).toBe(true);
    const unclassified = [...found.keys()].filter((t) => !(t in HOSTED_RELAY_FRAME_REGISTRY));
    expect(unclassified, 'new frame types must be classified in hosted-relay-confidentiality-registry.ts').toEqual([]);
  });

  it('has no stale registry entries (every classified type still exists in source)', () => {
    const found = frameLiterals();
    const stale = Object.keys(HOSTED_RELAY_FRAME_REGISTRY).filter((t) => !found.has(t));
    expect(stale).toEqual([]);
  });

  it('classifies every control-plane audit field', () => {
    const sinks: Array<[string, string, string]> = [
      ['broker-audit', 'packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts', 'HostedWorkspaceSessionAuditEvent'],
      ['host-audit', 'packages/operator-core/lib/workspace-host/hosted-session-host.ts', 'HostedHostAuditEvent'],
      ['app-relay-audit', 'packages/operator-core/lib/workspace-host/hosted-app-relay.ts', 'HostedAppRelayAuditEvent'],
    ];
    for (const [sink, rel, name] of sinks) {
      const keys = interfaceKeys(rel, name);
      expect(keys.length).toBeGreaterThan(0);
      expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]!).sort()).toEqual([...keys].sort());
    }
  });

  it('records no audit field as content (control-plane sinks are metadata-only)', () => {
    for (const sink of ['broker-audit', 'host-audit', 'app-relay-audit']) {
      const fields = HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]!;
      for (const cls of Object.values(fields)) expect(cls.sensitivity).toBe('control');
    }
  });


  it('classifies every column written by both route telemetry INSERT paths', () => {
    const source = readFileSync(resolve(REPO, 'packages/operator-core/lib/endpoint-route/telemetry.ts'), 'utf8');
    const columns = routeInvocationColumns(source);
    // Positive controls distinguish the ordinary route and internal receipt writers.
    expect(columns).toContain('resolved_path');
    expect(columns).toContain('metadata_json');
    expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocations']!).sort()).toEqual(columns);
  });

  it('detects a new persisted telemetry field instead of silently ignoring it', () => {
    const source = readFileSync(resolve(REPO, 'packages/operator-core/lib/endpoint-route/telemetry.ts'), 'utf8');
    const changed = source.replace('resolved_path, response_bytes)', 'resolved_path, response_bytes, customer_payload)');
    expect(changed).not.toBe(source);
    const registered = HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocations']!;
    expect(routeInvocationColumns(changed).filter((column) => !(column in registered))).toEqual(['customer_payload']);
  });

  it('does not classify unallowlisted telemetry paths or structured receipts as control metadata', () => {
    const fields = HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocations']!;
    for (const field of ['resolved_path', 'error_message', 'metadata_json']) {
      expect(fields[field]!.sensitivity).toBe('content');
    }
  });

  it('every content-bearing plane has at least one content frame', () => {
    for (const plane of ['workspace-session', 'operator-http', 'app-http', 'desktop-viewer'] as const) {
      expect(Object.values(HOSTED_RELAY_FRAME_REGISTRY).some((c) => c.planes.includes(plane) && c.sensitivity === 'content')).toBe(true);
    }
  });

  it('names the control-plane plaintext consumers the census found', () => {
    expect(PLAINTEXT_CONSUMERS.filter((c) => c.readsContent).map((c) => c.site)).toEqual([
      'hosted-app-relay.ts handleHostedAppRelay() (portal)',
      'hosted-app-relay.ts portal token relay',
    ]);
  });
});
