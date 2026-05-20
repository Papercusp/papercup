/**
 * Build a minimal ConsoleEnvelope for the Setup Wizard's "Sign in to
 * Claude / OpenAI" buttons. The native console_launch Tauri command
 * spawns a new OS terminal window running `greetingCmd`, which is what
 * we want for OAuth flows that need an interactive shell.
 *
 * Unlike the full /api/agent-mcp/console/resolve envelope, we don't
 * write .mcp.json or bootstrap superuser tokens — `claude /login` and
 * `omp /login` are stand-alone OAuth flows that don't need either.
 */
import { NextRequest } from 'next/server';
import { homedir } from 'node:os';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROVIDER_COMMANDS: Record<string, string> = {
  claude: 'claude /login',
  openai: 'omp /login',
  // `gh auth login` is the GitHub CLI's interactive OAuth flow. Same
  // console-launch pattern as the others — opens a real terminal so
  // the device-code prompt + paste-token UX works.
  github: 'gh auth login',
};

export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return Response.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider ?? '';
  const cmd = PROVIDER_COMMANDS[provider];
  if (!cmd) {
    return Response.json({ error: `unknown provider: ${provider}` }, { status: 400 });
  }
  return Response.json({
    cwd: homedir(),
    env: {},
    mcpJsonContents: '',
    greetingCmd: cmd,
    needsSuperuserBootstrap: false,
  });
}
