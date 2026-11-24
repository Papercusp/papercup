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

Set `operatorUrl`, `tokenFile`, and `workspace` in that file. Use the actual listener port from server startup. The bundled default model mapping uses Bedrock Sonnet 4.6. Configure the full model ID and effort levels that your local provider and managed host allow. A model may also say its context `window` in tokens. Papercusp reads a session's context limit off its model's name, where `[1m]` marks a 1M window and anything else gets the small one, and a native model ID carries no such mark: a session opened on the first model is registered under that mark when its `window` is a million or more, so it is not told to compact at the small window's limit. Set `tools` to the Papercusp tool seed the identity needs. Set `memberTools` to the seed a launched fleet member needs, which is smaller: a member bound to an outside plan (`su.outside-fleet-member`) pulls, builds and closes work-items and messages its leader, so `coord:orient`, `scheduler:get_next`, `work_items:get`, `work_items:claim`, `work_items:release`, `work_items:complete`, `coord:send`, `coord:inbox`, `coord:read`, `memory:search` and `session:request-compaction` are all it is told of. Without `memberTools` a member is given `tools`. Set `role` and `stack` for fixed defaults. A local `stateDir` stores private UUID mappings. Preserve it, the native Claude transcript directory, and the original worktree to resume or fork in a new process.

## Client configuration

The package contains `client.json` with one `agent_servers` entry. Set its command to the absolute installed path, typically `/home/USER/.local/node_modules/.bin/psu-acp`, and replace its config argument with the absolute path above. The client launches the command in its chosen worktree and provides its normal Claude environment. Machine-wide managed settings must allow the launch-supplied `papercusp-su` MCP server and any caller servers. The operator URL must be loopback. Stdio carries newline-delimited ACP JSON-RPC. Diagnostic output goes to stderr.

A client may set `_meta.psuAcp` on `session/new`. `role` and `stack` choose the session's identity in place of the configured defaults. `planRef` names the outside plan item the session works on: an opaque string the operator binds to the session, so no Papercusp plan is written for that work. `compactionLimit` is the session's context limit in tokens, a positive integer the operator clamps to what the role allows. Both last for the session, across resume. A fleet member takes them from its launch, never from the client, and opens in the folder its launch names (`members[].cwd` on `fleet:launch-on-plan`), else in the leader's.

A client may host the members its session launches. A session opened with `_meta.psuAcp.hostMembers: true` does not start a launched member itself: for each launch it sends its client the request `_psu/host_member` with `{sessionId, job}`, and the client answers `{accepted: true}` (or `{accepted: false, reason}`, which fails that launch). The client then starts the member as a session of its own with `psu-acp --config <config> --member-job <file>`, where the file holds the job as it was handed over, and opens it in the job's `spec.cwd`. Such a member is the fleet member the launch registered (its owner id, fleet, brief and model are the job's), its governed kickoff goes ahead of the client's first prompt, and its transcript, permission requests and usage are the client's own session's. Nothing of it runs inside the launching session's turn. Every `session/new` and `session/resume` response carries `_meta.psuAcp.owner`, the session's Papercusp owner id, which is how anything outside the session addresses it.

Papercusp's own hooks run in a session opened here when the config names their file: `hooks`, the absolute path of the hooks file the Papercusp installer generates for its Claude plugin (`<home>/.papercusp/claude-plugins/plugins/papercusp/hooks/hooks.json`). A host whose managed settings admit only managed hooks drops the hooks a user's settings or plugin enrolls, Papercusp's included, and admits the ones the program hosting the session registers itself. This command is that program, so it registers each enrolled command as its own hook and runs it as Claude Code runs a command hook: the event's JSON on stdin, the session's environment, an exit of 2 refusing what is about to happen, JSON output passed through, and a time limit. The file is read at each native start and stays the one source of the enrollment. With hooks on, each prompt the client sends is first enrolled with the operator as machine-sent (origin `acp-client`) and carries that envelope at its head, so the session's provenance hook does not take a program's prompt for the owner's words.

Without `hooks` no Papercusp hook runs, and in either case the command itself keeps the session told how full its context is. Each time the native session reports its context size the command asks the operator for the gauge it shows every other session, and a gauge that has reached a louder band (80%, then 90% of the session's limit) is put in front of the session: into the turn in flight, or with its next prompt, after the prompt's own blocks. With hooks on the gauge line is enrolled as machine-sent like a client's prompt, so the provenance hook does not take it for the owner's words. A carry the session then asks for with `session:request-compaction` is carried out and continued inside the client's prompt. The fresh context holds Papercusp's carry and nothing of what the turn was asked, so once the carry has continued the client's prompt is sent again, unchanged, under a line saying the context was carried and the work is to go on from where it stands.

## Compatibility and verification

The paired client is Python `agent-client-protocol==0.12.1` in unstable mode. The pinned reference is `@agentclientprotocol/claude-agent-acp@0.88.0`, SDK `0.3.293`, native Claude `2.1.293`. The command installs no Papercusp hook: it registers the ones the config's `hooks` file enrolls. The optional managed test hook records Bash and Agent PreToolUse when the fixture trace variable is set. Removing it removes this recording. Client permission, tool and cancellation handling use structured native messages.

From the repository root, set `A=apps/operator/scripts/psu-acp/adapter` and use the following commands. Set `DOCKER_HOST` to the test daemon. Supply an absolute Linux Node executable with `--node` if the installed sidecar path differs.

```sh
"$A/build.sh" "$PWD/artifacts"
python3 "$A/verify.py" --package artifacts/psu-acp-0.1.0.tgz --server artifacts/papercusp-server.tar.gz --out observations/roundtrip
uv run --no-project --script "$A/cases.py" --package artifacts/psu-acp-0.1.0.tgz --profile core --out observations/core
uv run --no-project --script "$A/cases.py" --package artifacts/psu-acp-0.1.0.tgz --profile hooks --out observations/hooks
```

`--reference` uses the same client against the pinned reference. `--only long` selects the real seven-minute shell case. Omitting `--server` uses an isolated operator bootstrap and a deterministic local inference service. Results identify their profile and bootstrap. An isolated run does not certify a production operator journey. See the digest-bound release results for the individual observations, failures and coverage limits. D-001, the live signed-Bedrock hook-free turn and worker Allow/Reject scenario, is skipped by Avi, unverified, and excluded from executed and passed counts.
