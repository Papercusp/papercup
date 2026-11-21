#!/usr/bin/env python3
"""Use the pinned headless packer with an attributable loopback server launcher."""
import argparse
import errno
import os
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

def sha256(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def verified_source(sidecar):
    proof=json.loads((sidecar/'build-provenance.json').read_text())
    commit=proof.get('gitHead','')
    if (not re.fullmatch('[0-9a-f]{40}',commit) or proof.get('gitHeadAtEmit')!=commit or
        proof.get('gitDirty') is not False or proof.get('gitDirtyAtEmit') is not False):
        raise ValueError('A consistent clean sidecar build is required for tool discovery')
    bundle=sha256(sidecar/'serve.mjs')
    if not any(a.get('name')=='serve.mjs' and a.get('sha256')==bundle for a in proof.get('artifacts',[])):
        raise ValueError('The server executable differs from the recorded build')
    return commit,bundle

def plan_guidance(prompt):
    start = '- **Plan before non-trivial work.**'
    if prompt.count(start) != 1:
        raise ValueError('Cannot identify the unique SU planning rule')
    tail = prompt[prompt.index(start):]
    rule, separator, _ = tail.partition('\n- **')
    if not separator:
        raise ValueError('Cannot identify the end of the SU planning rule')
    return rule


def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError as error:
        if error.errno not in (errno.EXDEV, errno.EPERM, errno.EACCES, errno.EMLINK):
            raise
        shutil.copy2(source, destination)


def staged_prompts(sidecar, directory):
    # SU launch renders su.md. The pinned blueprint also ships the authoritative
    # kernel, including the externally planned split. Project only that rule.
    prompt_dir = Path('harness/blueprints/base/prompts')
    persona = prompt_dir / 'su.md'
    original = (sidecar / persona).read_text()
    old = plan_guidance(original)
    rule = plan_guidance((sidecar / prompt_dir / 'su.kernel.md').read_text())
    text = ' '.join(rule.split())
    has_field_guidance = '`external_plan_ref`' in text and '`claimKinds`' in text
    has_outside_plan_guidance = (
        'outside plan reference is already planned' in text
        and 'register each split piece under the reference' in text
    )
    if not (has_field_guidance or has_outside_plan_guidance):
        raise ValueError('Missing external work-item guidance in the blueprint kernel')
    if old == rule:
        return sidecar
    suffix = rule[len(old):]
    if not rule.startswith(old) or not suffix[:1].isspace():
        raise ValueError('Conflicting planning rules in the rendered persona and kernel')
    stage = directory / 'sidecar'
    shutil.copytree(sidecar, stage, symlinks=True, copy_function=link_or_copy)
    replacement = stage / persona
    replacement.unlink()  # Detach before writing so the source sidecar stays immutable.
    replacement.write_text(original.replace(old, rule, 1))
    shutil.copymode(sidecar / persona, replacement)
    return stage


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('sidecar',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('--desktop-bin',type=Path,default=Path(__file__).resolve().parents[5]/'papercusp-desktop/bin')
    args=parser.parse_args()
    sidecar=args.sidecar.resolve(strict=True)
    commit,bundle=verified_source(sidecar)
    # The stock packer reads its launcher from beside its own file. Keep that
    # producer byte-for-byte and supply its expected launcher with the release pin.
    with tempfile.TemporaryDirectory(dir=args.output.resolve().parent) as stage:
        directory=Path(stage)
        packer=directory/'pack-headless-server.py'
        shutil.copyfile(args.desktop_bin/packer.name,packer)
        original=(args.desktop_bin/'start-headless-server.sh').read_text()
        shebang,newline,body=original.partition('\n')
        if not newline or not shebang.startswith('#!'):raise ValueError('Invalid headless launcher')
        (directory/'start-headless-server.sh').write_text(shebang+newline+'export PAPERCUSP_BUILD_SHA='+commit+'\n'+body)
        packaged_sidecar = staged_prompts(sidecar, directory)
        prompt = packaged_sidecar / 'harness/blueprints/base/prompts/su.md'
        prompt_digest = sha256(prompt)
        subprocess.run([sys.executable,str(packer),str(packaged_sidecar),str(args.output.resolve())],check=True)
    print(json.dumps({'source':commit,'serveSha256':bundle,'renderedSuSourceSha256':prompt_digest,'serverSha256':sha256(args.output)}))

if __name__=='__main__':main()
