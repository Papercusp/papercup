/**
 * Unit tests for parseRequestContext + InvalidRequestContextError —
 * the per-spawn URL → PluginRequestContext parser that fronts every
 * projected-tool MCP request. Pure (`new URL`); no mocks.
 */

import { describe, expect, it } from 'vitest';
import {
  parseRequestContext,
  InvalidRequestContextError,
  type PluginRequestContext,
} from './spawn-context';

const BASE = 'https://host.example/api/mcp';

/** Build a request URL from a param bag, dropping undefined entries. */
function url(params: Record<string, string | undefined>): string {
  const u = new URL(BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return u.toString();
}

const ALL_REQUIRED = {
  harness: 'sheets',
  workspace: 'ws_1',
  role: 'worker',
  run: 'run_1',
  spawn: 'spw_1',
};

describe('parseRequestContext — happy path', () => {
  it('parses all five required params', () => {
    const ctx = parseRequestContext(url(ALL_REQUIRED));
    expect(ctx).toEqual<PluginRequestContext>({
      harnessSlug: 'sheets',
      workspaceId: 'ws_1',
      role: 'worker' as PluginRequestContext['role'],
      runId: 'run_1',
      spawnId: 'spw_1',
      featureId: null,
      chunkId: null,
      parentSpawnId: null,
      uiClientId: null,
      detectorSessionKey: null,
    });
  });

  it('parses all required + optional params', () => {
    const ctx = parseRequestContext(
      url({
        ...ALL_REQUIRED,
        feature: 'F-9',
        chunk: 'ck_3',
        parent_spawn: 'spw_parent',
        client: 'tab_42',
        detector: ' sid-auditor-1 ',
      }),
    );
    expect(ctx.featureId).toBe('F-9');
    expect(ctx.chunkId).toBe('ck_3');
    expect(ctx.parentSpawnId).toBe('spw_parent');
    expect(ctx.uiClientId).toBe('tab_42');
    expect(ctx.detectorSessionKey).toBe('sid-auditor-1');
  });
});

describe('parseRequestContext — required param validation', () => {
  it.each(['workspace', 'role', 'run', 'spawn'])(
    'throws InvalidRequestContextError when %s is omitted, with that exact missing key',
    (omit) => {
      const params: Record<string, string | undefined> = { ...ALL_REQUIRED };
      delete params[omit];
      let err: unknown;
      try {
        parseRequestContext(url(params));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InvalidRequestContextError);
      expect((err as InvalidRequestContextError).missing).toEqual([omit]);
    },
  );

  it('harness is OPTIONAL — absent/whitespace → the "*" unscoped sentinel (workspace-level role session, hive-agent-tabs P-003)', () => {
    const params: Record<string, string | undefined> = { ...ALL_REQUIRED };
    delete params.harness;
    expect(parseRequestContext(url(params)).harnessSlug).toBe('*');
    expect(parseRequestContext(url({ ...ALL_REQUIRED, harness: '  ' })).harnessSlug).toBe('*');
  });

  it('reports EVERY omitted required key, in declaration order', () => {
    // Omit all required params (harness is optional → never reported).
    let err: unknown;
    try {
      parseRequestContext(BASE);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidRequestContextError);
    expect((err as InvalidRequestContextError).missing).toEqual([
      'workspace',
      'role',
      'run',
      'spawn',
    ]);
  });

  it('reports a partial set of omitted keys in declaration order', () => {
    // Provide harness + run; omit workspace, role, spawn.
    let err: unknown;
    try {
      parseRequestContext(url({ harness: 'h', run: 'r' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidRequestContextError);
    expect((err as InvalidRequestContextError).missing).toEqual([
      'workspace',
      'role',
      'spawn',
    ]);
  });

  it('treats a whitespace-only required param as missing', () => {
    let err: unknown;
    try {
      parseRequestContext(url({ ...ALL_REQUIRED, role: '   ' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidRequestContextError);
    expect((err as InvalidRequestContextError).missing).toEqual(['role']);
  });

  it('error message lists the missing params', () => {
    const err = new InvalidRequestContextError(['workspace', 'spawn']);
    expect(err.message).toContain('workspace, spawn');
    expect(err.name).toBe('InvalidRequestContextError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('parseRequestContext — trimming', () => {
  it('trims whitespace off every required field', () => {
    const ctx = parseRequestContext(
      url({
        harness: '  sheets  ',
        workspace: '\tws_1\t',
        role: ' worker ',
        run: ' run_1 ',
        spawn: ' spw_1 ',
      }),
    );
    expect(ctx.harnessSlug).toBe('sheets');
    expect(ctx.workspaceId).toBe('ws_1');
    expect(ctx.role).toBe('worker');
    expect(ctx.runId).toBe('run_1');
    expect(ctx.spawnId).toBe('spw_1');
  });

  it('trims whitespace off every optional field', () => {
    const ctx = parseRequestContext(
      url({
        ...ALL_REQUIRED,
        feature: '  F-9  ',
        chunk: ' ck_3 ',
        parent_spawn: ' spw_parent ',
        client: ' tab_42 ',
      }),
    );
    expect(ctx.featureId).toBe('F-9');
    expect(ctx.chunkId).toBe('ck_3');
    expect(ctx.parentSpawnId).toBe('spw_parent');
    expect(ctx.uiClientId).toBe('tab_42');
  });
});

describe('parseRequestContext — optional param null-coercion', () => {
  it('coerces absent optional params to null', () => {
    const ctx = parseRequestContext(url(ALL_REQUIRED));
    expect(ctx.featureId).toBeNull();
    expect(ctx.chunkId).toBeNull();
    expect(ctx.parentSpawnId).toBeNull();
    expect(ctx.uiClientId).toBeNull();
    expect(ctx.detectorSessionKey).toBeNull();
  });

  it('coerces empty-string optional params to null', () => {
    const ctx = parseRequestContext(
      url({ ...ALL_REQUIRED, feature: '', chunk: '', parent_spawn: '', client: '', detector: '' }),
    );
    expect(ctx.featureId).toBeNull();
    expect(ctx.chunkId).toBeNull();
    expect(ctx.parentSpawnId).toBeNull();
    expect(ctx.uiClientId).toBeNull();
    expect(ctx.detectorSessionKey).toBeNull();
  });

  it('coerces whitespace-only optional params to null', () => {
    const ctx = parseRequestContext(
      url({ ...ALL_REQUIRED, feature: '  ', chunk: '\t', parent_spawn: ' ', client: '   ', detector: ' \t ' }),
    );
    expect(ctx.featureId).toBeNull();
    expect(ctx.chunkId).toBeNull();
    expect(ctx.parentSpawnId).toBeNull();
    expect(ctx.uiClientId).toBeNull();
    expect(ctx.detectorSessionKey).toBeNull();
  });
});

describe('parseRequestContext — URL vs string input', () => {
  it('accepts a string URL', () => {
    const ctx = parseRequestContext(url(ALL_REQUIRED));
    expect(ctx.harnessSlug).toBe('sheets');
  });

  it('accepts a URL object', () => {
    const u = new URL(url(ALL_REQUIRED));
    const ctx = parseRequestContext(u);
    expect(ctx.harnessSlug).toBe('sheets');
    expect(ctx.spawnId).toBe('spw_1');
  });

  it('string and URL forms produce equal results', () => {
    const s = url({ ...ALL_REQUIRED, feature: 'F-1', client: 'tab_9', detector: 'sid-auditor-2' });
    const fromString = parseRequestContext(s);
    const fromUrl = parseRequestContext(new URL(s));
    expect(fromString).toEqual(fromUrl);
  });
});
