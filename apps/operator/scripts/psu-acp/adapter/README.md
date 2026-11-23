# psu-acp

The command runs one Papercusp Claude session per stdin/stdout connection. Use Linux x86-64, Node 22.12 or newer, a configured Claude provider, and a local Papercusp operator built with the corresponding patch. The operator and command run as the same unprivileged user and share the session worktree, transcript storage, and Papercusp home.

## Install

Unpack the server archive into any user-owned directory. Start its direct Node launcher in a separate terminal.

```sh
mkdir -p "$HOME/papercusp-server-install" "$HOME/.config/psu-acp"
tar -xzf papercusp-server.tar.gz -C "$HOME/papercusp-server-install"
"$HOME/papercusp-server-install/papercusp-server/start-server"
```

Use the operator's configured workspace ID. For a clean install, create the workspace using the local operator workspace setup or select its built-in `default` workspace. The launcher keeps its state beside itself by default. Use its existing `superuser-token` for the adapter and protect the file with mode 0600. On a fresh private headless installation an administrator can provision the token before startup with `umask 077` and `openssl rand -hex 32`. Configure the same state root on both sides.

```sh
npm install --offline --ignore-scripts --prefix "$HOME/.local" ./psu-acp-0.1.0.tgz
cp "$HOME/.local/node_modules/psu-acp/config.example.json" "$HOME/.config/psu-acp/config.json"
```

Set `operatorUrl`, `tokenFile`, and `workspace` in that file. Use the actual listener port from server startup. The bundled default model mapping uses Bedrock Sonnet 4.6. Configure the full model ID and effort levels that your local provider and managed host allow. Set `tools` to the Papercusp tool seed the identity needs. Set `role` and `stack` for fixed defaults. A local `stateDir` stores private UUID mappings. Preserve it, the native Claude transcript directory, and the original worktree to resume or fork in a new process.

## Client configuration

The package contains `client.json` with one `agent_servers` entry. Set its command to the absolute installed path, typically `/home/USER/.local/node_modules/.bin/psu-acp`, and replace its config argument with the absolute path above. The client launches the command in its chosen worktree and provides its normal Claude environment. Machine-wide managed settings must allow the launch-supplied `papercusp-su` MCP server and any caller servers. The operator URL must be loopback. Stdio carries newline-delimited ACP JSON-RPC. Diagnostic output goes to stderr.

A client may set `_meta.psuAcp` on `session/new`. `role` and `stack` choose the session's identity in place of the configured defaults. `planRef` names the outside plan item the session works on: an opaque string the operator binds to the session, so no Papercusp plan is written for that work. `compactionLimit` is the session's context limit in tokens, a positive integer the operator clamps to what the role allows. Both last for the session, across resume. A fleet member takes them from its launch, never from the client, and opens in the folder its launch names (`members[].cwd` on `fleet:launch-on-plan`), else in the leader's.

## Compatibility and verification

The paired client is Python `agent-client-protocol==0.12.1` in unstable mode. The pinned reference is `@agentclientprotocol/claude-agent-acp@0.88.0`, SDK `0.3.293`, native Claude `2.1.293`. No Papercusp hook is installed by the command. The optional managed test hook records Bash and Agent PreToolUse when the fixture trace variable is set. Removing it removes this recording. Client permission, tool and cancellation handling use structured native messages.

From the repository root, set `A=apps/operator/scripts/psu-acp/adapter` and use the following commands. Set `DOCKER_HOST` to the test daemon. Supply an absolute Linux Node executable with `--node` if the installed sidecar path differs.

```sh
"$A/build.sh" "$PWD/artifacts"
python3 "$A/verify.py" --package artifacts/psu-acp-0.1.0.tgz --server artifacts/papercusp-server.tar.gz --out observations/roundtrip
uv run --no-project --script "$A/cases.py" --package artifacts/psu-acp-0.1.0.tgz --profile core --out observations/core
uv run --no-project --script "$A/cases.py" --package artifacts/psu-acp-0.1.0.tgz --profile hooks --out observations/hooks
```

`--reference` uses the same client against the pinned reference. `--only long` selects the real seven-minute shell case. Omitting `--server` uses an isolated operator bootstrap and a deterministic local inference service. Results identify their profile and bootstrap. An isolated run does not certify a production operator journey. See the digest-bound release results for the individual observations, failures and coverage limits. D-001, the live signed-Bedrock hook-free turn and worker Allow/Reject scenario, is skipped by Avi, unverified, and excluded from executed and passed counts.
