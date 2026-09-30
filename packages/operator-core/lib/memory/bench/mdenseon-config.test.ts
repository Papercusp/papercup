import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bench = fileURLToPath(new URL('.', import.meta.url));
function apply(snapshot: unknown) {
  const result = spawnSync('python3', ['-c', `
import json, sys
from types import SimpleNamespace
from mdenseon_config import apply_pinned_rope
config = SimpleNamespace(global_rope_theta=160000.0, local_rope_theta=10000.0)
snapshot = json.load(sys.stdin)
try:
    apply_pinned_rope(config, snapshot)
    print(json.dumps({'global': config.global_rope_theta, 'local': config.local_rope_theta,
                      'parameters': config.rope_parameters}))
except ValueError as error:
    print(json.dumps({'error': str(error), 'local': config.local_rope_theta}))
`], { cwd: bench, input: JSON.stringify(snapshot), encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const pinned = (full = 160000, sliding = 160000) => ({
  model_type: 'modernbert',
  rope_parameters: {
    full_attention: { rope_type: 'default', rope_theta: full },
    sliding_attention: { rope_type: 'default', rope_theta: sliding },
  },
});

describe('pinned ModernBERT RoPE compatibility', () => {
  it('overrides the older runtime local default with the publisher value', () => {
    const snapshot = pinned();
    expect(apply(snapshot)).toEqual({ global: 160000, local: 160000, parameters: snapshot.rope_parameters });
  });

  it('preserves distinct full/sliding frequencies instead of assuming they match', () => {
    expect(apply(pinned(200000, 80000))).toMatchObject({ global: 200000, local: 80000 });
  });

  it.each([
    {},
    { model_type: 'modernbert' },
    { ...pinned(), model_type: 'other' },
    { ...pinned(), local_rope_theta: 10000 },
    { ...pinned(), rope_parameters: { ...pinned().rope_parameters, sliding_attention: { rope_type: 'linear', rope_theta: 160000 } } },
    { ...pinned(), rope_parameters: { ...pinned().rope_parameters, sliding_attention: { rope_type: 'default', rope_theta: true } } },
    pinned(160000, 0),
    pinned(160000, -1),
  ])('refuses an incomplete, unsupported or conflicting contract before mutation: %j', (snapshot) => {
    expect(apply(snapshot)).toMatchObject({ error: expect.any(String), local: 10000 });
  });
});
