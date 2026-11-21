#!/usr/bin/env python3
"""Run the exact setup-generated client entry against the relocated server."""
import argparse
import json
from pathlib import Path
import subprocess

from verify import HERE, Host


class ConfiguredHost(Host):
    def start(self):
        prefix = self.work / 'configured-install'
        self.prefix = prefix
        token = '/work/relocated server/papercusp-server/state/superuser-token'
        subprocess.run(['sh', str(HERE / 'setup.sh'), str(self.args.package), str(prefix),
                        'http://127.0.0.1:8912', 'papercusp-workspace', token], check=True)
        (prefix / 'sessions').mkdir()
        # Both the real host and fixture user can traverse the installed program.
        prefix.chmod(0o755)
        subprocess.run(['chmod','-R','a+rX',str(prefix/'node_modules')],check=True)
        (prefix/'psu-acp.json').chmod(0o644)
        entry = json.loads((prefix/'client.json').read_text())['agent_servers']
        assert list(entry)==['Papercusp']
        super().start()
        adapter = entry['Papercusp']
        self.command = self.docker+['exec','-i',self.cid,adapter['command'],*adapter['args']]
        (self.args.out/'client-entry.json').write_text(json.dumps(entry,indent=2)+'\n')
        return self

    def docker_cmd(self,*args,**kwargs):
        if args[0]=='run':
            at=args.index(self.image)
            extra=('--mount',f'type=bind,src={self.prefix},dst={self.prefix},readonly',
                   '--tmpfs',f'{self.prefix}/sessions:rw,uid=65534,gid=65534,mode=0700')
            args=(*args[:at],*extra,*args[at:])
        return super().docker_cmd(*args,**kwargs)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--package',type=Path,required=True)
    parser.add_argument('--server',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--node',type=Path,default=Path('/usr/lib/Papercusp Server/sidecar/bin/node'))
    args=parser.parse_args()
    args.profile='core'
    args.out.mkdir(parents=True,exist_ok=True)
    with ConfiguredHost(args) as host:
        host.probe()
