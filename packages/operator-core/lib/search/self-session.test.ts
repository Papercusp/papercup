import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSelfSession } from './self-session';

const SID = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveSelfSession — fresh Codex without a rollout', () => {
  it('uses the active adv-session to find the isolated history fallback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const codexHome = join(home, '.papercusp', 'su-codex-homes', 'session-11801');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'history.jsonl'),
      `${JSON.stringify({ session_id: SID, ts: 1_783_926_209, text: 'audit this session' })}\n`,
    );

    const resolved = await resolveSelfSession('su-current', {
      home,
      loadActiveSessions: async () => [{
        id: 11801,
        agent: 'codex',
        session_id: null,
        omp_thread_id: null,
      }],
    });

    expect(resolved).toEqual({
      sourceKind: 'codex',
      sessionId: SID,
      filePath: join(codexHome, 'history.jsonl'),
    });
  });
});
