import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('retained search baseline edition custody',()=>{
  it('requires every pin, safe table counts, fresh output and immutable execution source',()=>{
    const driver=fileURLToPath(new URL('../../../../../scripts/backup/search-bench/run-retained-baseline.py',import.meta.url));
    const result=execFileSync('python3',['-B','-c',[
      'import importlib.util,json,tempfile,pathlib,hashlib,sys',
      'spec=importlib.util.spec_from_file_location("baseline",sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
      'with tempfile.TemporaryDirectory() as root:',
      ' p=pathlib.Path(root); f=p/"input.json";f.write_text("{}")',
      ' pin={"path":str(f),"sha256":hashlib.sha256(f.read_bytes()).hexdigest()}',
      ' plan={"schemaVersion":1,"workItemId":"WI-fixture","expectedCounts":{"session_turns":0},"outputDirectory":str(p/"new"),**{k:pin for k in ["consumption","schema","queries","configuration"]}}',
      ' m.validate_plan(plan);assert m.pinned(pin)=={}',
      ' rejected=[]',
      ' for key in ["consumption","schema","queries","configuration"]:',
      '  altered={**plan};del altered[key]',
      '  try:m.validate_plan(altered)',
      '  except ValueError:rejected.append(key)',
      ' for label,changes in [("existing",{"outputDirectory":root}),("relative",{"outputDirectory":"relative"}),("negative",{"expectedCounts":{"t":-1}}),("unsafe",{"expectedCounts":{"t;drop":0}})]:',
      '  try:m.validate_plan({**plan,**changes})',
      '  except ValueError:rejected.append(label)',
      ' f.write_text("[]")',
      ' try:m.pinned(pin)',
      ' except ValueError:rejected.append("pin-drift")',
      ' print(json.dumps(rejected))',
    ].join('\n'),driver],{encoding:'utf8'});
    expect(JSON.parse(result)).toEqual(['consumption','schema','queries','configuration','existing','relative','negative','unsafe','pin-drift']);
  });
});
