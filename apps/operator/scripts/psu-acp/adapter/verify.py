#!/usr/bin/env python3
"""Drive an installed candidate with the common pinned client under a managed host profile."""
import argparse
import hashlib
import json
import os
import runpy
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"


class Host:
    def __init__(self, args):
        self.args = args
        self.docker = ["docker", "--host", os.environ.get("DOCKER_HOST", "unix:///run/docker-bench.sock")]
        self.cid = None
        self.token = secrets.token_hex(32)
        self.work = Path(tempfile.mkdtemp(prefix="psu-acp-matrix-"))

    def host(self, *argv, timeout=180, **kwargs):
        return subprocess.run(list(map(str, argv)), check=True, text=True, capture_output=True, timeout=timeout, **kwargs).stdout

    def docker_cmd(self, *argv, **kwargs):
        return self.host(*self.docker, *argv, **kwargs).strip()

    def execute(self, *argv, **kwargs):
        return self.docker_cmd("exec", self.cid, *argv, **kwargs)

    def __enter__(self):
        try:
            return self.start()
        except BaseException:
            self.__exit__(None,None,None)
            raise

    def start(self):
        a = self.args
        self.sha = file_digest(a.package)
        install = self.work / "install"
        oracle = self.work / "oracle"
        oracle.mkdir(mode=0o755)
        for name in ("package.json", "package-lock.json", "provider.mjs"):
            shutil.copyfile(FIXTURES / "reference" / name, oracle / name)
        shutil.copyfile(HERE / "scenario-provider.mjs", oracle / "scenario-provider.mjs")
        self.host("npm","ci","--workspaces=false","--include=optional","--ignore-scripts","--prefer-offline",
                  "--no-audit","--no-fund","--prefix",oracle)
        self.host("npm","install","--legacy-peer-deps","--workspaces=false","--offline","--ignore-scripts","--no-audit",
                  "--no-fund","--prefix",install, a.package.resolve())
        installed=install/"node_modules/psu-acp"
        candidates=list(install.rglob("@anthropic-ai/claude-agent-sdk-linux-x64/claude"))
        natives=list(oracle.rglob("@anthropic-ai/claude-agent-sdk-linux-x64/claude"))
        if len(candidates)!=1 or len(natives)!=1: raise RuntimeError("Ambiguous native Claude executable")
        manifest={"candidatePackage":self.sha,"candidateCommandSha256":file_digest(installed/"psu-acp"),
            "candidateSupervisorSha256":file_digest(installed/"supervise"),"candidateNativeSha256":file_digest(candidates[0]),
            "referenceNativeSha256":file_digest(natives[0]),"referenceCommandSha256":file_digest(oracle/"node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"),
            "referenceLockSha256":file_digest(oracle/"package-lock.json"),"nodeSha256":file_digest(a.node),
            "nativeVersion":self.host(str(natives[0]),"--version").strip()}
        image_source=self.work/"managed-host"
        image_source.mkdir()
        for name in ["Dockerfile","observe-hook.sh"]:
            shutil.copyfile(FIXTURES/name,image_source/name)
        managed=json.loads((FIXTURES/("managed-"+a.profile+".json")).read_text())
        managed["allowedMcpServers"].append({"serverUrl":"http://127.0.0.1:8912/api/mcp?*"})
        managed["allowedMcpServers"].extend({"serverUrl":"http://127.0.0.1:8911/mcp/"+suffix} for suffix in ('a','b'))
        (image_source/("managed-"+a.profile+".json")).write_text(json.dumps(managed))
        self.image = self.docker_cmd("build","--network=none","--pull=false","--quiet",
                                     "--build-arg","PROFILE="+a.profile,image_source)
        manifest.update(profile=a.profile,fixtureImage=self.image,managedSettingsSha256=file_digest(image_source/("managed-"+a.profile+".json")))
        (a.out/"host.json").write_text(json.dumps(manifest,indent=2)+"\n")
        mounts = []
        def mount(src, dst):
            mounts.extend(["--mount", f"type=bind,src={src},dst={dst},readonly"])
        mount(install, "/opt/adapter")
        mount(oracle,"/oracle")
        mount(HERE / "fixtures.mjs","/probe/operator.mjs")
        mount(a.node.resolve(),"/usr/local/bin/node")
        if a.server:
            mount(a.server.resolve(),"/input/server.tar.gz")
        sidecar=getattr(a,"sidecar",None)
        build_env=[]
        if sidecar:
            source,_=runpy.run_path(str(HERE/'pack-server.py'))['verified_source'](sidecar)
            build_env=['-e','PAPERCUSP_BUILD_SHA='+source]
            mount(sidecar.resolve(),"/opt/boot/sidecar")
            mount(HERE.parents[4]/"papercusp-desktop/bin/start-headless-server.sh","/opt/boot/start-server")
        self.cid = self.docker_cmd("run","-d","--network","none","--memory","8g","--memory-swap","8g",
            "--cap-drop","ALL","--security-opt","no-new-privileges",*mounts,
            "-e","FIXTURE_MCP_TOKEN_SHA256="+hashlib.sha256(self.token.encode()).hexdigest(),
            "-e","AWS_REGION=us-east-1","-e","CLAUDE_CODE_SKIP_BEDROCK_AUTH=1",
            "-e","PSU_ACP_MATRIX=1",
            "-e","CLAUDE_CODE_ENABLE_TELEMETRY=1","-e","CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1",
            "-e","OTEL_LOGS_EXPORTER=otlp","-e","OTEL_METRICS_EXPORTER=otlp","-e","OTEL_EXPORTER_OTLP_PROTOCOL=http/json",
            "-e","OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8911","-e","OTEL_METRIC_EXPORT_INTERVAL=1000",
            "-e","OTEL_LOGS_EXPORT_INTERVAL=1000","-e","OTEL_RESOURCE_ATTRIBUTES=fixture.tenant=acp-matrix",
            "-e","ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:8911",self.image,
            "/usr/local/bin/node","/oracle/provider.mjs")
        config = json.loads((HERE / "config.example.json").read_text())
        config.update(operatorUrl="http://127.0.0.1:8912",tokenFile="/work/operator.token",stateDir="/work/acp-state")
        if a.server or sidecar:
            server="/opt/boot"
            state="/work/operator-state"
            if a.server:
                self.execute("mkdir","-p","/work/relocated server")
                self.execute("tar","-xzf","/input/server.tar.gz","-C","/work/relocated server",timeout=300)
                server="/work/relocated server/papercusp-server"
                state=server+"/state"
            config["tokenFile"]=state+"/superuser-token"
            self.execute("mkdir","-p",state)
            self.write(config["tokenFile"],secrets.token_hex(32))
            self.docker_cmd("exec","-d",*build_env,"-e","PAPERCUSP_HOME="+state,"-e","PAPERCUSP_HONO_PORT=8912","-e","PAPERCUSP_PG_PORT=5491",
                            self.cid,"sh","-c",'exec sh "$1" > /work/server.log 2>&1',"server",server+"/start-server")
        else:
            self.write("/work/operator.token",secrets.token_hex(32))
            self.docker_cmd("exec","-d",self.cid,"/usr/local/bin/node","/probe/operator.mjs")
        self.write("/work/acp.json",json.dumps(config))
        for _ in range(150):
            try:
                self.execute("node","-e","fetch('http://127.0.0.1:8912/api/health').then(r=>process.exit(+!r.ok)).catch(()=>process.exit(1))")
                break
            except subprocess.CalledProcessError:
                time.sleep(0.75)
        else:
            raise RuntimeError("Isolated operator failed to become ready")
        if a.server or sidecar:
            # Register the disposable workspace through the same route as a local operator.
            self.execute("node","--input-type=module","-e",
                "const r=await fetch('http://127.0.0.1:8912/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Papercusp workspace'})});const w=await r.json();if(w.id!=='papercusp-workspace')throw Error(JSON.stringify(w));")
        self.command = self.docker+["exec","-i",self.cid,"/opt/adapter/node_modules/.bin/psu-acp","--config","/work/acp.json"]
        return self

    def write(self,path,data):
        self.docker_cmd("exec","-i",self.cid,"sh","-c",'umask 077; cat > "$1"',"write",path,input=data)

    def rotate(self):
        self.token=secrets.token_hex(32)
        self.write('/work/client-token.sha256',hashlib.sha256(self.token.encode()).hexdigest())

    def __exit__(self,*_):
        if self.cid:
            if self.args.server or getattr(self.args,"sidecar",None):
                subprocess.run(self.docker+["cp",self.cid+":/work/server.log",str(self.args.out/"server.log")],
                               capture_output=True)
            self.docker_cmd("rm","-f",self.cid)
        shutil.rmtree(self.work)

    def probe(self):
        a = self.args
        prompt=self.work/"prompt"
        credential=self.work/"caller.token"
        prompt.write_text("Return the managed fixture receipt.")
        credential.write_text(self.token)
        credential.chmod(0o600)
        cmd=["uv","run","--no-project","--script",str(HERE.parent/"contract_client.py"),
             "--cwd","/work","--launch-cwd",str(self.work),"--expect-adapter-version","0.1.0",
             "--model","sonnet","--effort","low","--fixture-mcp-token-file",str(credential),
             "--prompt-file",str(prompt),"--request-timeout","45","--prompt-timeout","70","--",*self.command]
        res=subprocess.run(cmd,text=True,capture_output=True,timeout=150)
        if self.token in res.stderr+res.stdout:
            raise ValueError("Credential appeared on the protocol or diagnostic stream")
        (a.out/"roundtrip.stderr").write_text(res.stderr)
        if res.returncode: raise ValueError(res.stderr[-1200:])
        trace=json.loads(res.stdout)
        packets=[json.loads(line) for line in self.execute("cat","/work/provider-requests.jsonl").splitlines()]
        reply="".join(x["update"]["content"]["text"] for x in trace["updates"] if
            x["update"]["sessionUpdate"]=="agent_message_chunk" and x["update"].get("_meta",{}).get("claudeCode",{}).get("kind")!="informational")
        result={"trace":trace,"provider":packets,"reply":reply,"image":self.image,
                "bootstrap":"packaged operator" if a.server else "built sidecar" if getattr(a,"sidecar",None) else "isolated bootstrap fixture",
                "packageSha256":file_digest(a.package),
                "firstRequestMatches":bool(packets and packets[0]["model"]=="us.anthropic.claude-sonnet-4-6" and packets[0]["effort"]=="low")}
        (a.out/"roundtrip.json").write_text(json.dumps(result,indent=2)+"\n")
        assert result["firstRequestMatches"], packets
        assert reply=="Native managed fixture completed.\n/work/result.txt",reply
        assert trace["result"]["usage"]["totalTokens"]==22
        print(json.dumps({k:result[k] for k in ("packageSha256","firstRequestMatches","reply","bootstrap")}))


def file_digest(path):
    h=hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
    return h.hexdigest()


if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--package",type=Path,required=True)
    p.add_argument("--server",type=Path)
    p.add_argument("--sidecar",type=Path)
    p.add_argument("--node",type=Path,default=Path("/usr/lib/Papercusp Server/sidecar/bin/node"))
    p.add_argument("--profile",choices=["core","hooks"],default="core")
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    with Host(args) as host:
        host.probe()
