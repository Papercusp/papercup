#!/usr/bin/env python3
"""Grade redacted observations and bind the dossier to the distributed package."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import median

EXPECTED = [
    "Initialize, advertise working routes, and keep stdout valid JSON-RPC.",
    "Authenticate a tool call to the caller's HTTP MCP server.",
    "Apply the selected model and effort to the first provider request.",
    "Deliver the final file-path line and nonzero token counts.",
    "Preserve the entire 40,000-byte mixed-character prompt.",
    "Retain three successive prompts in one session.",
    "Keep a real seven-minute Bash call open through completion.",
    "Settle once within five seconds on confirmed and withheld interruption.",
    "Deliver a steer into the current prompt.",
    "Resume native history in a new command using a fresh client credential.",
    "Fork and independently continue both histories.",
    "Observe Allow, Reject, and cancelled decisions at the filesystem.",
    "Run the declared subagent with a visible open Agent call.",
    "Hold the leader prompt for launched work and the final wake continuation.",
    "Deliver an idle wake inside the next prompt.",
    "Keep the public ID and open prompt across native replacement and resume.",
    "Reap the owned process tree within ten seconds of SIGTERM.",
    "Report unexpected native process loss as a retryable fault.",
    "Return a specific unavailable-operator error and exit nonzero.",
    "Run the complete candidate protocol matrix under the managed non-root profile.",
    "Run two members with launch-injected authenticated Papercusp tools.",
    "Route separately labelled member Allow and Reject to the correct file effects.",
    "Attribute two model-active native member UUIDs and match collector attributes.",
    "Reap both launched member trees after cancel and SIGTERM.",
    "Boot the relocated archive offline, non-root, with a clean database under 8 GiB and inspect SQL settings.",
]
WAIVER = {"id":"D-001","verdict":"skipped","disposition":"skipped by Avi, unverified",
          "scenario":"Live signed-Bedrock hook-free model turn and worker Allow/Reject."}

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda:handle.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def read(path):
    return json.loads(path.read_text())

def load_profiles(root,who,package):
    profiles={}
    for profile in ('core','hooks'):
        rows={}
        for name in ('matrix-final','long','profiles','faults'):
            path=root/(who+'-'+profile+'-'+name)/'cases.json'
            if path.is_file():
                for row in read(path):
                    if row.get('packageSha256')!=package: raise ValueError('Artifact mismatch '+str(path))
                    rows[str(row['case'])]=row
        profiles[profile]=rows
    return profiles

def grade(ids,rows):
    # Check identities and cardinality independently of the counters in a result.
    missing=sorted(set(ids)-set(rows))
    failed=[n for n in ids if n in rows and rows[n]['verdict']!='passed']
    return {'verdict':'not run' if missing else 'failed' if failed else 'passed','missing':missing,'failed':failed}

def release_gate(rows, profiles, extras):
    numbered={str(row['case']):row for row in rows}
    expected=[str(i) for i in range(1,26)]
    if len(numbered)!=len(rows) or set(numbered)!=set(expected):
        return False
    core=[str(i) for i in [*range(1,12),14,15,17,18,19]]+['8-withheld','EOF','isolation','RSS']
    return (grade(expected,numbered)['verdict']=='passed'
            and grade(core,profiles['core'])['verdict']=='passed'
            and grade(['B','C'],profiles['hooks'])['verdict']=='passed'
            and grade(['E'],extras)['verdict']=='passed')

def dossier(args):
    package=digest(args.package)
    source=args.observations
    profiles=load_profiles(source,args.adapter,package)
    host=profiles['hooks']
    native=read(args.native) if args.native.is_file() else {}
    case25=native.get('25',{'verdict':'not run','reason':'Archive verification pending'})
    if args.server and case25.get('verdict')=='passed' and case25.get('serverSha256')!=digest(args.server):
        raise ValueError('Server archive differs from its test subject')
    rows=[]
    for n,title in enumerate(EXPECTED,1):
        if n==25: observation=case25
        elif n==20:
            ids=[str(i) for i in range(1,25) if i!=20]+['20-host']
            observation=grade(ids,host)
            observation['profile']='hooks'
        else: observation=host.get(str(n),{'verdict':'not run','reason':'Missing managed-host observation'})
        if n==8:
            fault=profiles['core'].get('8-withheld')
            if observation.get('verdict')=='passed':
                observation={'verdict':fault['verdict'] if fault else 'not run','ordinary':observation,'withheld':fault}
        rows.append({'case':n,'expected':title,**observation})
    d=grade([str(i) for i in [*range(1,12),14,15,17,18,19]],profiles['core'])
    rs=profiles['core'].get('RSS',{}).get('observed',{})
    mem=rs.get('peaksMiB',[])
    counts={k:sum(r['verdict']==k for r in rows) for k in ('passed','failed','not run')}
    counts.update(total=26,executed=counts['passed']+counts['failed'],skipped=1)
    assert counts['total']==counts['executed']+counts['skipped']+counts['not run']
    return {'base':args.base,'packageSha256':package,'serverSha256':digest(args.server) if args.server else None,
       'patchSha256':digest(args.patch),'adapter':args.adapter,'pins':{'pythonACP':'0.12.1','reference':'0.88.0','nativeSDK':'0.3.293','nativeClaude':'2.1.293'},
       'counts':counts,'numberedCases':rows,'exception':WAIVER,'profiles':profiles,'hookFreeCore':d,
       'memory':{'concurrency':rs.get('concurrency'),'medianPeakMiB':median(mem) if mem else None,'rangeMiB':[min(mem),max(mem)] if mem else None},
       'requiredChecksPassed':release_gate(rows,profiles,native),
       'native':native,'releaseNotes':read(args.notes) if args.notes else []}

if __name__=='__main__':
    p=argparse.ArgumentParser()
    for flag in ('package','patch','observations','native','output'):p.add_argument('--'+flag,type=Path,required=True)
    p.add_argument('--server',type=Path)
    p.add_argument('--notes',type=Path)
    p.add_argument('--base',required=True)
    p.add_argument('--adapter',choices=['candidate','ref'],required=True)
    p.add_argument('--check',action='store_true',help='Exit unsuccessfully when a required observation is absent or failed.')
    args=p.parse_args()
    test=grade(['1','2'],{'1':{'verdict':'passed'}})
    assert test['verdict']=='not run' and test['missing']==['2']
    result=dossier(args)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result['counts']))
    if args.check and not result['requiredChecksPassed']:
        raise SystemExit(1)
