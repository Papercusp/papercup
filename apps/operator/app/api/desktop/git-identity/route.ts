import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const runtime = 'nodejs';

const exec = promisify(execFile);

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  return (
    host.startsWith('127.0.0.1:') ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

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
  if (!isLoopback(req)) return NextResponse.json({ error: 'loopback only' }, { status: 403 });
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
