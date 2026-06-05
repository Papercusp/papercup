/**
 * GET  /api/flags/testing-features  - returns { testingFeatures, source }
 * POST /api/flags/testing-features  - { enabled } persists to ~/.papercusp/posthog.json
 *
 * Ported from app/api/flags/testing-features/route.ts. `auth: 'public'`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import {
  getPosthogConfigWithSource,
  resetPosthogConfigForTest,
} from '../../../posthog-config';
import { defineTool } from '@papercusp/agent-mcp';

const CONFIG_PATH = path.join(os.homedir(), '.papercusp', 'posthog.json');
const Body = z.object({ enabled: z.boolean() });

const get = defineTool({
  method: 'GET',
  path: '/flags/testing-features',
  auth: 'public',
  handler() {
    const { testingFeatures, source } = getPosthogConfigWithSource();
    return Response.json({ testingFeatures, source });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/flags/testing-features',
  auth: 'public',
  input: Body,
  async handler(_req, ctx) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      // file may not exist yet
    }
    parsed.testingFeatures = ctx.input.enabled;
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.promises.writeFile(
      CONFIG_PATH,
      JSON.stringify(parsed, null, 2) + '\n',
      { mode: 0o600 },
    );
    resetPosthogConfigForTest();
    const { reinitFlagBackend } = await import('../../../flag-bus');
    reinitFlagBackend();
    return Response.json({ ok: true, testingFeatures: ctx.input.enabled });
  },
});

export default [get, post];
