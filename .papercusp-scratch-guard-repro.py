#!/usr/bin/env python3
"""Drive the real PreToolUse bash-resource-gate hook with the filed repros.

Hermetic: fake $HOME carrying the two credential files the hook gates on,
dead OPERATOR_URL so any resource-gate round-trip fails open fast, and
PAPERCUSP_CANONICAL_TREE pinned to a fake canonical root with cwd inside it
(the exact situation the shell-write guard protects).
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.environ.get('REPRO_SCRIPT') or os.path.join(
    HERE, 'apps', 'operator', 'scripts', 'hooks', 'cc',
    'pretooluse-bash-resource-gate.sh')
CANON = '/ws/papercupai-workspace/papercusp'

REPROS = [
    # (label, command)
    ('EI-19418179098729784 psql now() interval',
     'psql "$DB" -Atc "SELECT count(*) FROM harness_shared.tool_invocations '
     "WHERE invoked_at > now() - interval '2 minutes'\""),
    ('EI-19417957171220978 node -e arrow (double-quoted)',
     'node -e "import(\'./libs/papercusp/libs/db/dist/index.js\')'
     '.then(m=>console.log(m.getHarnessAdminUrl()))"'),
    ('EI-19323309702408274 node -e arrow (single-quoted)',
     "node -e ' const a = [1,2,3].map(x => x * 2); console.log(a) '"),
    ('control: real unquoted redirect into tree (MUST DENY)',
     'echo hi > apps/operator/lib/should-deny.ts'),
    ('control: plain read (MUST ALLOW)', 'git status --porcelain'),
    # --- hypothesis: an APOSTROPHE outside quotes breaks quote parity, so a
    # `>` that really was inside quotes becomes exposed to the redirect scan.
    ('H1 apostrophe in a # comment, then quoted SQL with > now()',
     "# doesn't matter\n"
     'psql -Atc "SELECT 1 FROM t WHERE ts > now() - interval \'2 minutes\'"'),
    ('H2 apostrophe in an unquoted echo word, then quoted SQL',
     "echo it's fine && "
     'psql -Atc "SELECT 1 FROM t WHERE ts > now() - interval \'2 minutes\'"'),
    ('H3 arrow fn after an unquoted apostrophe',
     "echo don't && node -e \"x.then(m=>console.log(1))\""),
    ('H4 two single-quoted args around a quoted redirect-looking string',
     "grep -o 'a' file && psql -Atc \"SELECT 1 WHERE ts > now()\" && grep -o 'b' f2"),
]


def main():
    fake_home = tempfile.mkdtemp(prefix='guard-repro-home-')
    pc = os.path.join(fake_home, '.papercusp')
    os.makedirs(pc, exist_ok=True)
    with open(os.path.join(pc, 'superuser-token'), 'w') as f:
        f.write('t' * 32)
    with open(os.path.join(pc, 'su-agent-id'), 'w') as f:
        f.write('su-00000000-0000-0000-0000-000000000000')

    env = {
        'PATH': os.environ.get('PATH', ''),
        'HOME': fake_home,
        'PAPERCUSP_SID': 's-repro',
        'PAPERCUSP_OPERATOR_URL': 'http://127.0.0.1:1',
        'PC_HEAVY_LOAD1_OVERRIDE': '0',
        'PAPERCUSP_CANONICAL_TREE': CANON,
    }

    failures = 0
    for label, command in REPROS:
        payload = {
            'tool_name': 'Bash',
            'tool_input': {'command': command},
            'session_id': 's-repro',
            'cwd': CANON,
        }
        r = subprocess.run(['bash', SCRIPT], input=json.dumps(payload),
                           capture_output=True, text=True, env=env, timeout=30)
        out = (r.stdout or '').strip()
        decision = 'ALLOW (silent)'
        reason = ''
        if out:
            try:
                parsed = json.loads(out)
                hook = parsed.get('hookSpecificOutput') or {}
                dec = (hook.get('permissionDecision') or parsed.get('decision')
                       or 'allow')
                reason = (hook.get('permissionDecisionReason')
                          or parsed.get('reason') or '')
                decision = dec.upper()
            except Exception as exc:  # noqa: BLE001
                decision = 'UNPARSEABLE: %s' % exc
                reason = out[:400]
        print('=' * 78)
        print('CASE: %s' % label)
        print('CMD : %s' % command)
        print('-> %s' % decision)
        if reason:
            print('   reason: %s' % reason[:600].replace('\n', '\n   '))
        if r.stderr.strip():
            print('   stderr: %s' % r.stderr.strip()[:300])
    print('=' * 78)
    return failures


if __name__ == '__main__':
    sys.exit(main())
