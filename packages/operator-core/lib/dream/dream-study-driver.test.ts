import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
describe('D017 standalone study environment admission', () => {
  it.each(['', 'https://external.example', 'http://127.0.0.1:3384/other'])('refuses sidecar setting %j before any study execution', (sidecar) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scratchpad/dream-study-2026-09-09/run-one-cycle.mts', '--run'], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_EMBED_SIDECAR_URL: sidecar },
      encoding: 'utf8', timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('D017 study requires PAPERCUSP_EMBED_SIDECAR_URL');
    expect(result.stdout).not.toContain('prepared');
    expect(result.stdout).not.toContain('routines:set');
  });
});
