import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const runtime = 'nodejs';

const exec = promisify(execFile);

async function readConfig(scope: 'global' | 'system', key: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['config', `--${scope}`, '--get', key], { timeout: 3000 });
    const v = stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function GET(req: NextRequest) {
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  const [globalName, globalEmail, systemName, systemEmail] = await Promise.all([
    readConfig('global', 'user.name'),
    readConfig('global', 'user.email'),
    readConfig('system', 'user.name'),
    readConfig('system', 'user.email'),
  ]);

  if (globalName || globalEmail) {
    return NextResponse.json({ name: globalName, email: globalEmail, source: 'global' });
  }
  if (systemName || systemEmail) {
    return NextResponse.json({ name: systemName, email: systemEmail, source: 'system' });
  }
  return NextResponse.json({ source: 'none' });
}
