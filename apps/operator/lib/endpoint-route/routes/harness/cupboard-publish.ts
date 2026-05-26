/**
 * POST /api/harness/cupboard/publish — Phase 9 P-053 server-side proxy.
 *
 * The ShareWizard's shared-public finalize step calls this route. The
 * operator forwards the publish to the Cupboard server with the user's
 * gh-token added server-side, so the browser never holds the token.
 *
 * Request body (mirrors apps/operator-public CupboardPublishInput):
 *   {
 *     github_repository_id: number,
 *     github_owner: string,
 *     github_name: string,
 *     github_url: string,
 *     title?: string,
 *     description?: string,
 *     topic_hex: string,
 *   }
 *
 * Response: { ok: true, id: string, harness: HarnessRow } on success,
 *           { ok: false, error: string, detail?: string } otherwise.
 *
 * Cupboard URL resolution:
 *   - PAPERCUSP_CUPBOARD_URL env var if set (override / self-host)
 *   - else 'https://cupboard.papercusp.com' (canonical hostname per 2026-05-26 deploy)
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getGhAuthToken } from '@/lib/identity/gh-token';

const DEFAULT_CUPBOARD_URL = 'https://cupboard.papercusp.com';
const TOPIC_HEX_RE = /^[0-9a-f]{64}$/;

interface PublishInput {
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  topic_hex: string;
}

export function resolveCupboardBaseUrl(): string {
  const env = process.env.PAPERCUSP_CUPBOARD_URL;
  return env && env.trim() ? env.trim().replace(/\/+$/, '') : DEFAULT_CUPBOARD_URL;
}

export function validatePublishInput(raw: unknown): { ok: true; input: PublishInput } | { ok: false; error: string; field?: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_body' };
  const b = raw as Record<string, unknown>;
  if (typeof b.github_repository_id !== 'number' || !Number.isInteger(b.github_repository_id) || b.github_repository_id <= 0) {
    return { ok: false, error: 'invalid_field', field: 'github_repository_id' };
  }
  if (typeof b.github_owner !== 'string' || !b.github_owner) {
    return { ok: false, error: 'invalid_field', field: 'github_owner' };
  }
  if (typeof b.github_name !== 'string' || !b.github_name) {
    return { ok: false, error: 'invalid_field', field: 'github_name' };
  }
  if (typeof b.github_url !== 'string' || !/^https:\/\/github\.com\//.test(b.github_url)) {
    return { ok: false, error: 'invalid_field', field: 'github_url' };
  }
  if (typeof b.topic_hex !== 'string' || !TOPIC_HEX_RE.test(b.topic_hex)) {
    return { ok: false, error: 'invalid_field', field: 'topic_hex' };
  }
  if (b.title != null && (typeof b.title !== 'string' || b.title.length > 200)) {
    return { ok: false, error: 'invalid_field', field: 'title' };
  }
  if (b.description != null && (typeof b.description !== 'string' || b.description.length > 280)) {
    return { ok: false, error: 'invalid_field', field: 'description' };
  }
  return {
    ok: true,
    input: {
      github_repository_id: b.github_repository_id,
      github_owner: b.github_owner,
      github_name: b.github_name,
      github_url: b.github_url,
      title: typeof b.title === 'string' ? b.title : undefined,
      description: typeof b.description === 'string' ? b.description : undefined,
      topic_hex: b.topic_hex,
    },
  };
}

const cupboardPublish = defineTool({
  method: 'POST',
  path: '/harness/cupboard/publish',
  auth: 'public',                       // loopback-only via the operator's Host header gate
  async handler(req) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const v = validatePublishInput(body);
    if (!v.ok) {
      return Response.json({ ok: false, error: v.error, field: 'field' in v ? v.field : undefined }, { status: 400 });
    }

    const tokenRes = await getGhAuthToken();
    if (tokenRes.kind !== 'ok') {
      return Response.json(
        { ok: false, error: 'gh_auth_required', detail: tokenRes.error.kind },
        { status: 401 },
      );
    }

    const url = `${resolveCupboardBaseUrl()}/harnesses`;
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenRes.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'papercusp-operator-cupboard-proxy',
        },
        body: JSON.stringify(v.input),
      });
    } catch (e) {
      return Response.json(
        { ok: false, error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) },
        { status: 502 },
      );
    }

    const text = await upstream.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json(
        { ok: false, error: 'cupboard_bad_response', detail: text.slice(0, 200), upstream_status: upstream.status },
        { status: 502 },
      );
    }

    if (!upstream.ok) {
      return Response.json(
        { ok: false, error: 'cupboard_error', detail: parsed, upstream_status: upstream.status },
        { status: upstream.status },
      );
    }

    return Response.json(parsed, { status: 200 });
  },
});

export default cupboardPublish;
