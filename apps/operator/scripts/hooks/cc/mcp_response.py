"""Shared parser for the JSON-RPC/SSE envelope returned by the local MCP endpoint.

The endpoint can return an HTTP 200 response whose JSON-RPC ``result`` carries
``isError: true``.  That is still a rejected tool call, not a usable inner
payload.  Keeping this distinction here prevents each CC hook from silently
reimplementing the fail-open bug.
"""

import json


def parse_mcp_response(raw_resp):
    """Return ``(inner, rpc_error, phase)`` for a JSON or SSE MCP response.

    ``inner`` is the JSON object encoded in the first text content block only
    when the outer response is a successful tool result.  ``rpc_error`` holds
    either a JSON-RPC ``error`` object or the rejected outer ``result`` carrying
    ``isError: true``.  ``phase`` is one of ``ok``, ``rpc-error``, ``is-error``,
    ``no-result``, or ``no-text``.
    """
    result = None
    rpc_error = None
    for line in (raw_resp or '').splitlines():
        line = line.strip()
        if not line or line.startswith('event:'):
            continue
        if line.startswith('data:'):
            line = line[5:].strip()
        try:
            candidate = json.loads(line)
        except Exception:
            continue
        if not isinstance(candidate, dict):
            continue
        if 'result' in candidate:
            result = candidate['result']
            break
        if 'error' in candidate:
            rpc_error = candidate['error']
            break

    if rpc_error is not None:
        return None, rpc_error, 'rpc-error'
    if not isinstance(result, dict):
        return None, None, 'no-result'
    if result.get('isError') is True:
        return None, result, 'is-error'

    for item in result.get('content') or []:
        if not isinstance(item, dict) or item.get('type') != 'text':
            continue
        try:
            inner = json.loads(item['text'])
        except Exception:
            continue
        if isinstance(inner, dict):
            return inner, None, 'ok'
    return None, None, 'no-text'
