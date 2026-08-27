/** Regression coverage for leaked lock-resolve node:test fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteDefinition } from '../define-route';
import { registerRoute } from '../define-route';

const rootState = vi.hoisted(() => ({ root: '' }));

vi.mock('../../papercusp-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../papercusp-root')>()),
  papercuspRoot: () => rootState.root,
}));

import globalRoute, { isLockResolveFixtureName } from '../routes/plugins/global';

type AnyRoute = RouteDefinition<never>;

function makePlugin(parent: string, dirName: string, manifestName = dirName): void {
  const dir = join(parent, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'papercusp.json'),
    JSON.stringify({ name: manifestName, version: '0.1.0' }),
    'utf8',
  );
}

function app(): Hono {
  const a = new Hono();
  registerRoute(a, globalRoute as AnyRoute);
  return a;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugins-global-'));
  rootState.root = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rootState.root = '';
});

describe('GET /plugins/global — lock-resolve fixture hygiene', () => {
  it('hides stale flat, mismatched-manifest, and scoped fixture entries', async () => {
    const globalDir = join(root, 'global-plugins');
    makePlugin(globalDir, 'real-plugin');
    makePlugin(globalDir, 'lockresolve-12345-root');
    makePlugin(globalDir, 'old-fixture-dir', 'lockresolve-987654-lone');
    makePlugin(join(globalDir, '@fixture-scope'), 'lockresolve-42-scoped');

    const response = await app().request('/plugins/global');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { plugins: Array<{ name: string }> };
    expect(body.plugins.map((plugin) => plugin.name)).toEqual(['real-plugin']);
  });

  it('keeps the filter narrow enough for non-fixture names', async () => {
    const globalDir = join(root, 'global-plugins');
    makePlugin(globalDir, 'lockresolve-dev-root');
    makePlugin(globalDir, 'lockresolve-abc-root');

    const response = await app().request('/plugins/global');
    const body = (await response.json()) as { plugins: Array<{ name: string }> };
    expect(body.plugins.map((plugin) => plugin.name)).toEqual([
      'lockresolve-abc-root',
      'lockresolve-dev-root',
    ]);
  });
});

describe('isLockResolveFixtureName', () => {
  it.each(['lockresolve-1-root', 'lockresolve-987654-lone'])('recognizes %s', (name) => {
    expect(isLockResolveFixtureName(name)).toBe(true);
  });

  it.each([
    'lockresolve',
    'lockresolve-123',
    'lockresolve-dev-root',
    'lockresolve-abc-root',
    'my-lockresolve-123-root',
  ])('does not classify %s as a fixture', (name) => {
    expect(isLockResolveFixtureName(name)).toBe(false);
  });
});
