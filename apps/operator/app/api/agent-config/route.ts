/**
 * GET  /api/agent-config — return saved AgentConfig + detected binary
 *                          paths + the backend that would actually be
 *                          used right now (after applying env-var
 *                          fallbacks).
 * POST /api/agent-config — replace AgentConfig (full body, not partial).
 *                          Mirrors into process.env so subsequent
 *                          spawns pick up the change immediately.
 */
import { NextResponse } from 'next/server';
import { spawnSync } from 'node:child_process';
import {
  readAgentConfig,
  writeAgentConfig,
  type AgentConfig,
} from '@/lib/agent-config';

export const dynamic = 'force-dynamic';

interface DetectedBinaries {
  claude: string | null;
  omp: string | null;
  pi: string | null;
}

function detectBinaries(): DetectedBinaries {
  const which = (bin: string): string | null => {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  return { claude: which('claude'), omp: which('omp'), pi: which('pi') };
}

function effectiveBackend(cfg: AgentConfig): 'claude-code' | 'omp' {
  if (cfg.backend !== 'auto') return cfg.backend;
  const cmd = (cfg.cmd || process.env.AGENT_CMD || process.env.CLAUDE_CMD || 'omp').trim();
  const first = cmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(?:^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(?:^|\/)claude$/.test(first)) return 'claude-code';
  return 'omp';
}

export async function GET() {
  const cfg = await readAgentConfig();
  return NextResponse.json({
    config: cfg,
    binaries: detectBinaries(),
    effectiveBackend: effectiveBackend(cfg),
    envOverrides: {
      AGENT_BACKEND: process.env.AGENT_BACKEND ?? null,
      AGENT_CMD: process.env.AGENT_CMD ?? null,
      CLAUDE_CMD: process.env.CLAUDE_CMD ?? null,
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as Partial<AgentConfig> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const next: AgentConfig = {
    backend: body.backend === 'claude-code' || body.backend === 'omp'
      ? body.backend
      : 'auto',
    cmd: typeof body.cmd === 'string' ? body.cmd : '',
    models: body.models && typeof body.models === 'object' && !Array.isArray(body.models)
      ? Object.fromEntries(
          Object.entries(body.models)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && v.trim())
            .map(([k, v]) => [k, (v as string).trim()]),
        )
      : {},
  };
  await writeAgentConfig(next);
  return NextResponse.json({
    config: next,
    binaries: detectBinaries(),
    effectiveBackend: effectiveBackend(next),
  });
}
