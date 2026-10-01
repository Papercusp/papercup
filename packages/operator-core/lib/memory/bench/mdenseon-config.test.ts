import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bench = fileURLToPath(new URL('.', import.meta.url));
it('retains independent boundary reference and candidate failure/profile before rethrowing an allocation error', () => {
  const result = spawnSync('python3', ['-c', `
import ast, hashlib, json, tempfile
from pathlib import Path
source = Path('mdenseon-vectors.py')
tree = ast.parse(source.read_text())
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ['boundary_infer', 'file_sha256']]
scope = dict(Path=Path, json=json, hashlib=hashlib)
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), scope)
with tempfile.TemporaryDirectory() as tmp:
 destination = Path(tmp); profile = destination/'profile.json'; profile.write_text('[]')
 metadata = dict(cell=dict(id='single-full-8192'), tokenLengths=[8192], referenceVectors=[[1.0]],
                 providerOptions={'CUDAExecutionProvider': {'use_tf32': '1'}}, inputShapeActuallySubmitted=[1,8192])
 class Candidate:
  def run(self, names, inputs):
   assert json.loads((destination/'single-full-8192.reference.json').read_text()) == metadata
   raise RuntimeError('Failed to allocate memory for requested buffer of size 3221225472')
  def end_profiling(self): return str(profile)
 try: scope['boundary_infer'](Candidate(), {}, destination, metadata)
 except RuntimeError as error: assert '3221225472' in str(error)
 else: raise AssertionError('candidate failure swallowed')
 failure = json.loads((destination/'single-full-8192.failure.json').read_text())
 assert failure['status']=='inference-failed' and failure['actual8192Completed'] is False
 assert failure['tokenLengths']==[8192] and failure['referenceVectors']==[[1.0]]
 assert failure['profile']['sha256']==hashlib.sha256(b'[]').hexdigest()
 assert failure['error']['name']=='RuntimeError'
print('boundary-failure-proof-passed')
`], { cwd: bench, encoding: 'utf8' });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('boundary-failure-proof-passed');
});
it('refuses incomplete, tokenizer-only or relaxed boundary contracts before loading weights', () => {
  const result = spawnSync('python3', ['-c', `
import ast, copy
from pathlib import Path
source = Path('mdenseon-vectors.py')
tree = ast.parse(source.read_text())
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'validate_boundary_request')
scope = dict(MODEL='lightonai/mDenseOn', REVISION='a5fdb000f7a21da96c3bddde3a782ef777316df3',
             VECTOR_COSINE_FLOOR=0.99999, VECTOR_MAX_ABS_ERROR=3e-5)
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), scope)
ids = ['short-query', 'short-document', 'unicode', 'code', 'whitespace', 'empty', 'full-8192', 'over-limit']
request = dict(formatVersion=1, model=scope['MODEL'], revision=scope['REVISION'],
 thresholds=dict(minimumCosine=.99999, maximumAbsoluteError=3e-5, ranking='exact'),
 execution=dict(dtype='fp32', intraOpThreads=4, interOpThreads=1, maxLength=8192),
 cases=[dict(id=i, kind='query', text='', untruncatedTokens=8192 if i=='full-8192' else 8193 if i=='over-limit' else 4) for i in ids],
 batches=[dict(id='padded', caseIds=ids[:2]), dict(id='mixed-length', caseIds=ids[:2])],
 assets=[dict(path='/pinned', bytes=1, sha256='a'*64)], snapshot='/snapshot', export='/export')
assert scope['validate_boundary_request'](request) == request
for field, value in [('cases', request['cases'][:-1]), ('batches', request['batches'][:1]),
 ('thresholds', dict(minimumCosine=.999, maximumAbsoluteError=3e-5, ranking='exact')),
 ('execution', dict(dtype='fp32', intraOpThreads=4, interOpThreads=1, maxLength=8191)), ('assets', [])]:
 bad = copy.deepcopy(request); bad[field] = value
 try: scope['validate_boundary_request'](bad)
 except ValueError: pass
 else: raise AssertionError('accepted invalid boundary ' + field)
bad = copy.deepcopy(request); bad['cases'][-2]['untruncatedTokens'] = 8189
try: scope['validate_boundary_request'](bad)
except ValueError: pass
else: raise AssertionError('accepted tokenizer-only maximum')
print('boundary-contract-passed')
`], { cwd: bench, encoding: 'utf8' });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('boundary-contract-passed');
});
it('hashes a JSON-declared asset path as well as a Path without loading model packages', () => {
  const result = spawnSync('python3', ['-c', `
import ast, hashlib
from pathlib import Path
source = Path('mdenseon-vectors.py')
tree = ast.parse(source.read_text())
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'file_sha256')
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'))
assert file_sha256(str(source)) == hashlib.sha256(source.read_bytes()).hexdigest()
assert file_sha256(source) == file_sha256(str(source))
print('asset-path-contract-passed')
`], { cwd: bench, encoding: 'utf8' });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('asset-path-contract-passed');
});
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
