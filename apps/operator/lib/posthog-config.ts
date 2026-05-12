/**
 * Resolve PostHog connection info for the operator's server-side
 * feature-flag evaluation.
 *
 * Resolution order:
 *   1. Explicit env (PAPERCUSP_POSTHOG_HOST + PAPERCUSP_POSTHOG_KEY [+ optional
 *      PAPERCUSP_POSTHOG_PERSONAL_KEY for write/admin]).
 *   2. Discovery file at ~/.papercusp/posthog.json — written by the
 *      operator's PostHog Docker bootstrap (Phase 1 of the V1 flag plan).
 *   3. null — PostHog is not configured. The server still answers
 *      /api/flags/bootstrap with FLAG_DEFAULTS, so the app works.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PostHogConfig } from '@papercusp/flags/server';

let cached: { config: PostHogConfig | null; source: string } | null = null;

export function getPosthogConfig(): PostHogConfig | null {
  return resolve().config;
}

export function getPosthogConfigWithSource(): {
  config: PostHogConfig | null;
  source: string;
} {
  return resolve();
}

export function resetPosthogConfigForTest(): void {
  cached = null;
}

function resolve(): { config: PostHogConfig | null; source: string } {
  if (cached) return cached;

  const envHost = process.env.PAPERCUSP_POSTHOG_HOST;
  const envKey = process.env.PAPERCUSP_POSTHOG_KEY;
  const envPersonal = process.env.PAPERCUSP_POSTHOG_PERSONAL_KEY ?? envKey;
  if (envHost && envKey) {
    cached = {
      config: { host: envHost, projectKey: envKey, personalApiKey: envPersonal ?? envKey },
      source: 'env',
    };
    return cached;
  }

  const discoveryPath = path.join(os.homedir(), '.papercusp', 'posthog.json');
  try {
    const raw = fs.readFileSync(discoveryPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PostHogConfig> & { host?: string };
    if (parsed.host && parsed.projectKey && parsed.personalApiKey) {
      cached = {
        config: {
          host: parsed.host,
          projectKey: parsed.projectKey,
          personalApiKey: parsed.personalApiKey,
        },
        source: 'discovery-file',
      };
      return cached;
    }
  } catch {
    // missing or malformed — fall through to unconfigured
  }

  cached = { config: null, source: 'unconfigured' };
  return cached;
}
