# /// script
# requires-python = ">=3.10"
# dependencies = ["agent-client-protocol==0.12.1"]
# ///
"""Run the same ACP session probe against a reference or candidate stdio command."""

import argparse
import asyncio
import json
import os
import sys
from importlib.metadata import version
from pathlib import Path
from uuid import UUID

import acp
from acp import schema


CLIENT_VERSION = "0.12.1"
FIXTURE_WRITE_ID = "toolu_psu_acp_receipt"
FIXTURE_WRITE_INPUT = {"file_path": "/work/permission-receipt.txt", "content": "approved fixture receipt\n"}


class Observations:
    def __init__(self, fixture_decision=None):
        self.updates = []
        self.permissions = []
        self.fixture_decision = fixture_decision
        self.active_session = None

    async def session_update(self, session_id, update, **_kwargs):
        self.updates.append({
            "sessionId": session_id,
            "update": update.model_dump(mode="json", by_alias=True, exclude_none=True),
        })

    async def request_permission(self, session_id, tool_call, options, **_kwargs):
        call_id = tool_call.tool_call_id
        outcome = schema.DeniedOutcome(outcome="cancelled")
        source = any(
            event["sessionId"] == session_id
            and event["update"].get("toolCallId") == call_id
            and event["update"].get("_meta", {}).get("claudeCode", {}).get("toolName") == "Write"
            for event in self.updates
        )
        record = {"sessionId": session_id, "toolCallId": call_id, "decision": "cancelled"}
        if (self.fixture_decision and session_id == self.active_session and not self.permissions
                and call_id == FIXTURE_WRITE_ID and tool_call.raw_input == FIXTURE_WRITE_INPUT and source):
            matches = [option for option in options if option.kind == self.fixture_decision]
            if len(matches) == 1:
                outcome = schema.AllowedOutcome(outcome="selected", option_id=matches[0].option_id)
                record["decision"] = matches[0].kind
        self.permissions.append(record)
        return schema.RequestPermissionResponse(outcome=outcome)

    def verify_session(self, session_id):
        for event in self.updates + self.permissions:
            if event["sessionId"] != session_id:
                raise ValueError("received an event for a different ACP session")


def options_by_id(response):
    options = {}
    for option in response.config_options or []:
        if option.id in options:
            raise ValueError(f"duplicate session configuration option {option.id!r}")
        options[option.id] = option.current_value
    return options


async def probe(args):
    installed = version("agent-client-protocol")
    if installed != CLIENT_VERSION:
        raise ValueError(f"expected Python ACP {CLIENT_VERSION}, found {installed}")
    observations = Observations(args.fixture_decision)
    async with acp.spawn_agent_process(
        observations, *args.command,
        env=dict(os.environ),
        cwd=args.launch_cwd or args.cwd,
        use_unstable_protocol=True,
        transport_kwargs={"stderr": None},
    ) as (agent, _process):
        async def request(awaitable):
            return await asyncio.wait_for(awaitable, timeout=args.request_timeout)

        initialized = await request(agent.initialize(
            acp.PROTOCOL_VERSION,
            client_capabilities=schema.ClientCapabilities.model_validate({"elicitation": {"form": {}}}),
        ))
        if initialized.protocol_version != acp.PROTOCOL_VERSION:
            raise ValueError(f"unexpected negotiated protocol {initialized.protocol_version}")
        info = initialized.agent_info
        if args.expect_adapter_version and (info is None or info.version != args.expect_adapter_version):
            raise ValueError("the adapter did not report the expected version")
        servers = []
        if args.fixture_mcp_token_file:
            token = args.fixture_mcp_token_file.read_text(encoding="ascii")
            servers.append(schema.HttpMcpServer.model_validate({
                "type": "http", "name": "fixture-receipts", "url": "http://127.0.0.1:8911/mcp",
                "headers": [{"name": "Authorization", "value": "Bearer " + token}],
            }))
        opened = await request(agent.new_session(str(args.cwd), mcp_servers=servers))
        session_id = opened.session_id
        UUID(session_id)
        initial = options_by_id(opened)
        selected = {}
        for option, value in (("model", args.model), ("effort", args.effort)):
            if value is None:
                continue
            updated = await request(agent.set_config_option(option, session_id, value))
            if options_by_id(updated).get(option) != value:
                raise ValueError(f"{option} readback differs from the requested value")
            selected[option] = value

        result = None
        if args.prompt_file is not None:
            prompt = args.prompt_file.read_bytes().decode("utf-8")
            observations.active_session = session_id
            try:
                reply = await asyncio.wait_for(
                    agent.prompt(session_id=session_id, prompt=[acp.text_block(prompt)]),
                    timeout=args.prompt_timeout,
                )
            finally:
                observations.active_session = None
            result = reply.model_dump(mode="json", by_alias=True, exclude_none=True)
        await request(agent.close_session(session_id))
        observations.verify_session(session_id)
        return {
            "clientVersion": installed,
            "protocolVersion": initialized.protocol_version,
            "adapter": info.model_dump(mode="json", by_alias=True) if info else None,
            "agentCapabilities": initialized.agent_capabilities.model_dump(
                mode="json", by_alias=True, exclude_none=True
            ),
            "sessionId": session_id,
            "initialConfig": initial,
            "selectedConfig": selected,
            "updates": observations.updates,
            "permissions": observations.permissions,
            "result": result,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="absolute worktree in session/new")
    parser.add_argument("--launch-cwd", type=Path, help="local directory for a container or other launcher")
    parser.add_argument("--expect-adapter-version")
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--fixture-decision", choices=["allow_once", "reject_once"],
                        help="choose once for the isolated test fixture's exact receipt Write")
    parser.add_argument("--fixture-mcp-token-file", type=Path,
                        help="attach the approved loopback receipt server with its fixture credential")
    parser.add_argument("--prompt-file", type=Path, help="send this UTF-8 file without newline conversion")
    parser.add_argument("--request-timeout", type=float, default=30, help="seconds per session control request")
    parser.add_argument("--prompt-timeout", type=float, help="optional deadline in seconds for a model turn")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- followed by the adapter command and arguments")
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command or not args.cwd.is_absolute():
        parser.error("supply an absolute session working directory and an adapter command")
    if args.request_timeout <= 0 or (args.prompt_timeout is not None and args.prompt_timeout <= 0):
        parser.error("timeouts must be positive")
    print(json.dumps(asyncio.run(probe(args)), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, asyncio.TimeoutError, acp.RequestError) as exc:
        print(f"ACP probe failed ({type(exc).__name__}): {exc}", file=sys.stderr)
        sys.exit(1)
