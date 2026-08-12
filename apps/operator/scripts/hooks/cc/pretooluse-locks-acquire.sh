#!/usr/bin/env bash
# PreToolUse hook — claim SU-locks before a file edit. SHARED by Claude
# Code and Codex: both implement the same hook wire format (PreToolUse
# stdin with tool_name/tool_input/tool_use_id/session_id/cwd, and a
# `hookSpecificOutput.permissionDecision` decision contract).
#
# stdin (JSON) shapes we handle:
#   Claude:  { "tool_name": "Edit"|"Write"|"MultiEdit",
#              "tool_input": { "file_path": "..." }, ... }
#   Codex:   { "tool_name": "apply_patch",
#              "tool_input": <patch text or { ... patch text ... }>, ... }
#   Codex:   { "tool_name": "write_file",
#              "tool_input": { "path": "..." }, ... }
#
# Decision: we emit JSON on stdout. On contention we return
#   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
#       "permissionDecision": "deny", "permissionDecisionReason": "..." } }
# — `permissionDecisionReason` is fed back to the MODEL (on both clients),
# so the agent learns *why* and can retry/pivot/yield. (The deleted
# Claude shell hooks used exit-2 + stderr, which current clients surface
# to the user, not the model — so the agent never saw it. That is the
# one real modernization here.)
#
# On success we exit 0 with NO stdout — "no decision, proceed with the
# client's normal flow" — and cache the lock_id by tool_use_id so the
# matching PostToolUse hook can release only paths newly acquired by this
# edit. A same-owner already-held grant gets no release cache.
#
# Fail-open: if Papercusp isn't installed, or the operator is
# unreachable / unparseable, we ALWAYS allow the edit (cooperative
# discipline only works while the system is up) and drop a health
# marker so /coord can surface "enforcement offline".

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
# Managed sessions may receive either the operator origin or its full MCP
# endpoint. Normalize to the origin because the hook appends /api/mcp below.
OPERATOR_URL="${OPERATOR_URL%%/api/mcp*}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
CACHE_DIR="${PAPERCUSP_LOCKS_CACHE_DIR:-${HOME}/.papercusp/locks-cache}"

# Bail out fast if Papercusp isn't installed — never break an edit for
# someone who hasn't run install-standalone-mcp.sh.
if [ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]; then
  exit 0
fi

mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR" 2>/dev/null || true

TOKEN=$(cat "$TOKEN_PATH")
AGENT_ID=$(cat "$AGENT_ID_PATH")
INPUT=$(cat)

# Fail-open backstop: should the Python body ever exit non-zero from an
# error not caught inside (e.g. an OSError from realpath on a pathological
# path), ALLOW the edit rather than risk blocking it. The deny path emits
# its JSON then exits 0, so this guard only fires on an actual crash —
# never on a legitimate refusal.
python3 - "$INPUT" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$CACHE_DIR" <<'PYEOF' || { echo '[locks] hook error — allowing edit (fail-open)' >&2; exit 0; }
import json, os, re, sys, time, urllib.request, urllib.parse

raw, operator_url, token, agent_id, cache_dir = sys.argv[1:6]


def write_marker(name, value):
    """Atomic-ish health marker write; never raises (a marker failure
    must not wedge the edit). Mirrors the OMP hook's markers so one
    /api/su-locks/hook-health endpoint serves every client."""
    try:
        path = os.path.join(cache_dir, name)
        tmp = path + '.tmp-' + str(os.getpid())
        with open(tmp, 'w') as f:
            f.write(json.dumps(value))
        os.replace(tmp, path)
    except Exception:
        pass


def mark_success():
    value = {'ts': now_iso()}
    write_marker('last-success.json', value)
    owner_value = globals().get('owner')
    if isinstance(owner_value, str) and owner_value:
        value['owner'] = owner_value
        write_marker(owner_marker_name('success'), value)


def mark_error(phase, detail):
    value = {
        'ts': now_iso(), 'handler': 'pretooluse', 'phase': phase,
        'detail': str(detail)[:200], 'operator_url': operator_url,
    }
    write_marker('last-error.json', value)
    owner_value = globals().get('owner')
    if isinstance(owner_value, str) and owner_value:
        value['owner'] = owner_value
        write_marker(owner_marker_name('error'), value)


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def allow():
    # Exit 0, no stdout → no decision, client proceeds with normal flow.
    sys.exit(0)


def deny(reason):
    json.dump({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': reason,
    }}, sys.stdout)
    sys.exit(0)


try:
    payload = json.loads(raw)
except Exception:
    allow()  # Malformed input — never block.

tool_name = payload.get('tool_name', '') or ''
tool_input = payload.get('tool_input', {})
tool_use_id = payload.get('tool_use_id', '') or ''
cwd = payload.get('cwd') or os.getcwd()

# Identity: per-SESSION owner, NOT the machine-wide su-agent-id. The
# `-su` wrapper exports PAPERCUSP_SID (distinct per launch) AND bakes the
# same id into the interactive MCP `?client=`, so this hook and the
# agent's own coord/lock tool calls resolve to ONE owner — that's what
# lets a manual multi-file claim coexist with the per-edit hook instead
# of self-blocking. Fallbacks: the client's per-session session_id, then
# the machine-wide su-agent-id (two shells sharing only that collapse to
# one owner — the bug PAPERCUSP_SID fixes). Pre + Post share the env, so
# release still matches acquire.
env_sid = os.environ.get('PAPERCUSP_SID')
lock_sid = os.environ.get('PAPERCUSP_LOCK_SID')
session_id = payload.get('session_id')


def diagnostic_lock_sid():
    """Per-session CODEX_HOME is a second deterministic owner source. It lets
    an already-running Codex session pick up an identity repair even when Codex
    cached an older hook command/environment at launch."""
    try:
        codex_home = os.environ.get('CODEX_HOME')
        if not codex_home:
            return None
        with open(os.path.join(codex_home, 'papercusp-diagnostics.json')) as f:
            value = json.load(f).get('lockOwnerSid')
        return value if isinstance(value, str) and value else None
    except Exception:
        return None


owner = (
    lock_sid if isinstance(lock_sid, str) and lock_sid
    else diagnostic_lock_sid() or (
    env_sid if isinstance(env_sid, str) and env_sid
    else session_id if isinstance(session_id, str) and session_id
    else agent_id)
)


def owner_marker_name(kind):
    """Owner-scoped runtime proof; the global marker remains for machine health."""
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', owner)[:160] or 'unknown'
    return 'owner-' + safe + '-last-' + kind + '.json'


def patch_text(ti):
    """Codex apply_patch input may arrive as a raw string or wrapped in
    an object ({input|patch|...: <text>}). Be shape-robust: return any
    string content that looks like a patch."""
    if isinstance(ti, str):
        return ti
    if isinstance(ti, dict):
        for v in ti.values():
            if isinstance(v, str) and '*** ' in v:
                return v
        # Fall back: stringify the whole object and scan it.
        try:
            return json.dumps(ti)
        except Exception:
            return ''
    return ''


# ── Extract the file paths this tool will touch ────────────────────────
raw_paths = []
if tool_name in ('Edit', 'Write', 'MultiEdit'):
    fp = tool_input.get('file_path') if isinstance(tool_input, dict) else None
    if isinstance(fp, str) and fp:
        raw_paths.append(fp)
elif tool_name == 'apply_patch':
    # Patch headers: "*** Add File: p", "*** Update File: p",
    # "*** Delete File: p", and "*** Move to: p" (rename target).
    for m in re.finditer(r'^\*\*\* (?:Add|Update|Delete) File: (.+)$',
                         patch_text(tool_input), re.MULTILINE):
        raw_paths.append(m.group(1).strip())
    for m in re.finditer(r'^\*\*\* Move to: (.+)$',
                         patch_text(tool_input), re.MULTILINE):
        raw_paths.append(m.group(1).strip())
elif tool_name in ('write_file', 'edit_file'):
    p = tool_input.get('path') or tool_input.get('file_path') \
        if isinstance(tool_input, dict) else None
    if isinstance(p, str) and p:
        raw_paths.append(p)
else:
    allow()  # Not a file-editing tool.

if not raw_paths:
    allow()


# ── P-109 leg (i): FOREIGN-WORKSPACE guard (p2p-work-distribution, design §2) ──
# Two registry-derived directional policies, evaluated by the operator
# (POST /api/su-locks/foreign-guard → lib/p2p/foreign-guard.ts):
#   - a FOREIGN-marked session (spawn-injected PAPERCUSP_FOREIGN_OFFER_ID +
#     PAPERCUSP_FOREIGN_SESSION_ID, minted by P-104, verified against the
#     p2p_foreign_workspaces row — never trusted alone) may edit ONLY its own
#     registered root. FAIL-CLOSED: no verdict ⇒ no edit.
#   - a HOST session must never edit under a registered foreign root (the C7
#     blending hazard inverted). Roots come from a 30s cache of the registry;
#     an unreachable operator fails OPEN here (matching the hook's global
#     posture — containment is P-105's job, this is honest-path policy).
def _foreign_guard_post(payload, mark=True):
    """POST to the foreign-guard route; parsed JSON dict or None on ANY failure.
    mark=False keeps a best-effort call (the host-direction cache refresh) from
    writing the error marker — fail-open paths stay quiet, the fail-CLOSED
    foreign-session path stays loud."""
    try:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            operator_url.rstrip('/') + '/api/su-locks/foreign-guard',
            data=body,
            headers={'Authorization': 'Bearer ' + token,
                     'Content-Type': 'application/json'},
            method='POST',
        )
        # Never let an egress proxy intercept the localhost call (same reason
        # as the acquire call below).
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        resp = opener.open(req, timeout=6)
        out = json.loads(resp.read().decode('utf-8', errors='replace'))
        return out if isinstance(out, dict) else None
    except Exception as e:
        if mark:
            mark_error('foreign-guard', e)
        return None


_abs_paths = []
for _p in raw_paths:
    _ap = _p if os.path.isabs(_p) else os.path.join(cwd, _p)
    _abs_paths.append(os.path.abspath(_ap))

_foreign_offer = os.environ.get('PAPERCUSP_FOREIGN_OFFER_ID')
if _foreign_offer:
    # FOREIGN-marked session: one authoritative verdict per edit, FAIL-CLOSED.
    _v = _foreign_guard_post({
        'paths': _abs_paths,
        'offer_id': _foreign_offer,
        'session_id': os.environ.get('PAPERCUSP_FOREIGN_SESSION_ID', ''),
    })
    if not _v or _v.get('decision') != 'allow':
        _reason = _v.get('reason') if _v else None
        deny(_reason or (
            'foreign-work guard: refused — no guard verdict is reachable and this '
            f'session is foreign-marked (offer {_foreign_offer}). A foreign session '
            'edits nothing without a live registry verdict (fail-closed).'))
    # allow → fall through: a foreign clone lives outside the papercup
    # workspace, so the lock-scoping below skips it (nothing to lock).
else:
    # HOST session. Foreign roots live OUTSIDE the workspace root by the Q1
    # registration invariant, so only out-of-workspace paths can ever hit one
    # — in-workspace edits skip this check entirely (zero added latency on
    # the hot path).
    _ws_root = os.path.realpath(
        os.environ.get('PAPERCUSP_WORKSPACE_ROOT')
        or os.path.expanduser('~/papercupai-workspace'))
    _outside = [a for a in _abs_paths
                if not (os.path.realpath(a) == _ws_root
                        or os.path.realpath(a).startswith(_ws_root + os.sep))]
    # Cached foreign roots (30s TTL); on a hit, get the authoritative verdict
    # (which also bumps the P-004 counter). Refresh is best-effort: an
    # unreachable operator fails OPEN here.
    _roots = None
    if _outside:
        try:
            with open(os.path.join(cache_dir, 'foreign-roots.json')) as _f:
                _cached = json.load(_f)
            if time.time() - float(_cached.get('ts', 0)) < 30:
                _roots = _cached.get('roots')
        except Exception:
            pass
        if _roots is None:
            _v = _foreign_guard_post({'roots_only': True}, mark=False)
            _roots = _v.get('roots', []) if _v else []
            if _v is not None:
                write_marker('foreign-roots.json', {'ts': time.time(), 'roots': _roots})
    for _ap in _outside:
        _rap = os.path.realpath(_ap)
        _hit = None
        for _r in _roots or []:
            _root = _r.get('rootPath') if isinstance(_r, dict) else None
            if not _root:
                continue
            _rroot = os.path.realpath(_root)
            if _rap == _rroot or _rap.startswith(_rroot + os.sep):
                _hit = _r
                break
        if _hit is None:
            continue
        _v = _foreign_guard_post({'paths': _abs_paths})
        if _v and _v.get('decision') == 'allow':
            break  # registry moved on since the cache (row reaped) — fine.
        _reason = _v.get('reason') if _v else None
        deny(_reason or (
            f"foreign-work guard: refused — '{_ap}' is inside the FOREIGN "
            f"workspace of offer {_hit.get('offerId')} (root {_hit.get('rootPath')}). "
            'Host agents never edit foreign workspaces (C7): the foreign commit '
            'lane would attribute your work to the ORIGIN author.'))


def _valid_git_entry(d):
    """A `.git` entry only marks a repo root when VALID: a FILE (submodule /
    linked-worktree gitlink) or a DIR containing HEAD (every real git dir has
    one). A stray EMPTY `.git` dir (2026-07-13: an accidental `mkdir .git` at
    /tmp) must not re-key locks / red-pin tests — mirrors operator-core
    locks/valid-git-entry.ts (parity contract; keep in sync)."""
    g = os.path.join(d, '.git')
    if os.path.isfile(g):
        return True
    if os.path.isdir(g):
        return os.path.exists(os.path.join(g, 'HEAD'))
    return False


def find_repo_root(abs_path):
    """Walk up from a file (or its nearest existing parent) to the dir
    holding a VALID `.git` entry — gitlink file (worktree) or git dir with
    HEAD. Returns the repo root or None. Deriving the root per-edit keeps
    the hook correct across the many worktrees in this workspace (a
    hardcoded root would mis-key locks in every checkout but one)."""
    d = abs_path
    if not os.path.isdir(d):
        d = os.path.dirname(d)
    while d and d != '/':
        if _valid_git_entry(d):
            return d
        d = os.path.dirname(d)
    return None


def _repo_git_config_path(repo_root):
    """Absolute path to a repo's `config` for ANY repo shape — ordinary clone
    (`.git` dir), linked worktree (`.git` file → gitdir → commondir), or
    submodule (`.git` file → gitdir with its own config). None when it cannot
    be resolved. Split out of _repo_origin_url so the remote-less check below
    reads the SAME config by the SAME rules — the two must never disagree
    about which file they judged."""
    git_entry = os.path.join(repo_root, '.git')
    if os.path.isfile(git_entry):
        with open(git_entry) as f:
            m = re.match(r'gitdir:\s*(.+)$', f.read().strip())
        if not m:
            return None
        gd = m.group(1).strip()
        if not os.path.isabs(gd):
            gd = os.path.join(repo_root, gd)
        gd = os.path.realpath(gd)
        cfg = os.path.join(gd, 'config')
        if not os.path.exists(cfg):
            # Linked worktree: config lives in the COMMON git dir.
            cd_path = os.path.join(gd, 'commondir')
            if not os.path.exists(cd_path):
                return None
            with open(cd_path) as f:
                cd = f.read().strip()
            if not os.path.isabs(cd):
                cd = os.path.join(gd, cd)
            cfg = os.path.join(os.path.realpath(cd), 'config')
        return cfg
    return os.path.join(git_entry, 'config')


def _repo_origin_url(repo_root):
    """Best-effort `origin` fetch URL for ANY repo shape. None on ANY
    failure (unreadable, no origin remote, broken gitdir). Used by the
    worktree guard (WI-5031) to tell a stray checkout of the CANONICAL
    project apart from an independent repo that merely lives in the
    workspace dir. Parses .git/config directly — no `git` subprocess on
    the per-edit hot path."""
    try:
        cfg = _repo_git_config_path(repo_root)
        if cfg is None:
            return None
        url, in_origin = None, False
        with open(cfg) as f:
            for line in f:
                s = line.strip()
                if s.startswith('['):
                    in_origin = re.sub(r'\s+', '', s) == '[remote"origin"]'
                elif in_origin and s.split('=', 1)[0].strip() == 'url':
                    url = s.split('=', 1)[1].strip() if '=' in s else None
                    break
        return url or None
    except Exception:
        return None


def _repo_has_zero_remotes(repo_root):
    """True when the repo's config was READ SUCCESSFULLY and declares NO
    remotes at all; False when it declares at least one; None when the config
    could not be read.

    EI-18825797177551487 — why this exists, and why it is sound. WI-5031 made
    an independent sibling exempt from the worktree guard, but used `origin` as
    the independence proof and treated an UNREADABLE-or-ABSENT origin as
    "not proven independent" (deny). That conflates two very different repos:
    one we could not read, and one that provably has no remote at all.

    A stray checkout of the canonical project is, by construction, a CLONE — so
    it always carries an origin. A repo declaring zero remotes was never cloned
    from anything and therefore cannot be a stray checkout of the canonical
    tree, which is the only hazard this guard exists to prevent. Verified
    against every sibling in this workspace when the fix was written: the
    same-project checkouts (papercup-checkpoint, papercup-release,
    papercusp-checkpoint, papercusp-staging) carry
    origin=.../papercup.git, while every remote-less sibling (hive-canary — a
    REGISTERED harness with its own `auto-commit hive-canary` git-sync lane —
    plus brood-box-alpha and the greenfield-* project trees) is a genuinely
    independent local project. Denying those parked the daily loop-health
    canary as unworkable, the same failure mode WI-5031 was written to fix.

    Deliberately distinguishes "read it, found none" from "could not read":
    only the former proves independence. Unreadable still denies.

    ⚠ Do NOT read that sibling list as "every papercup* directory is a checkout
    the origin test refuses". Two of them are SYMLINKS and reach neither this
    function nor the origin comparison: `papercup` -> `papercusp` IS the canonical
    tree (edits through it are correctly ALLOWED — realpath normalizes them), and
    `papercusp-release` -> `papercup-release`. The rest are LINKED WORKTREES,
    refused earlier by the commondir branch. An earlier revision of this list
    named `papercup` among the refused checkouts, which reads as a guard hole the
    moment you observe an edit there succeed — it cost a bogus major-severity bug
    filing (EI-18826235967595309). Enumerate the shapes before believing any
    summary of them, this one included."""
    try:
        cfg = _repo_git_config_path(repo_root)
        if cfg is None:
            return None
        saw_remote = False
        with open(cfg) as f:
            for line in f:
                s = line.strip()
                if s.startswith('[') and re.match(r'\[remote\s*"', re.sub(r'\s+', ' ', s)):
                    saw_remote = True
                    break
        return not saw_remote
    except Exception:
        return None


def _norm_origin(url):
    """Normalize remote-URL spellings to `host/path` so ssh and https forms
    of the SAME remote compare equal (git@github.com:Org/repo.git ≡
    https://github.com/Org/repo). None in → None out."""
    if not url:
        return None
    u = url.strip().rstrip('/')
    if u.lower().endswith('.git'):
        u = u[:-4]
    m = re.match(r'^(?:git@|ssh://(?:git@)?|https?://|git://)([^/:]+)[:/](.*)$', u)
    return (m.group(1) + '/' + m.group(2)).lower() if m else u.lower()


def _origin_is_local_path_into_canonical(url, repo_root, canonical_tree,
                                        canon_origin_norm):
    """True when `url` is a LOCAL FILESYSTEM origin that points AT the canonical
    project — the same-project checkout `_norm_origin` structurally cannot see.

    EI-18826235967595309. WI-5031's independence test compares NORMALIZED REMOTE
    URLS, which quietly assumes every checkout of the canonical project was cloned
    from the same forge URL. A tree cloned from a SIBLING PATH
    (`git clone ../papercup runner`) records origin=/abs/path; that normalizes to
    the path itself and so never equals the canonical tree's
    `github.com/papercusp/papercup`. `_origins_differ` therefore computed True and
    the guard ALLOWED edits inside a full checkout of the canonical project, which
    is precisely the stranding hazard it exists to refuse.

    Verified live when this was written: `papercup-improvement-runner` is exactly
    this shape — origin `<ws>/papercup`, itself a symlink to `<ws>/papercusp` — and
    it was holding 22 uncommitted files that git-sync will never commit.

    Resolves ONE hop, deliberately: the path itself (a clone of the canonical
    tree), and a clone-of-a-clone whose own origin is the canonical forge URL.
    Anything unresolvable returns False, which keeps this strictly ADDITIVE — it
    can only catch checkouts the URL comparison already missed, and can never
    newly refuse an independent sibling."""
    if not url:
        return False
    try:
        p = url.strip()
        if p.startswith('file://'):
            p = p[len('file://'):]
        elif re.match(r'^(?:git@|ssh://|https?://|git://)', p):
            return False  # a genuine remote URL — _norm_origin already decided it
        if not os.path.isabs(p):
            # git records `clone ../sibling` verbatim; resolve it against the
            # cloned repo, which is the base git itself uses.
            p = os.path.join(repo_root, p)
        real = os.path.realpath(p)
        if os.path.basename(real) == '.git':
            real = os.path.dirname(real)
        if real == canonical_tree:
            return True
        nested = _norm_origin(_repo_origin_url(real))
        return (nested is not None and canon_origin_norm is not None
                and nested == canon_origin_norm)
    except Exception:
        return False


# Scope enforcement to the papercup workspace. Its worktrees (papercup,
# papercup-<topic>, …) are direct children of WORKSPACE_ROOT. We compute
# lock keys as paths RELATIVE TO each worktree root, so the same logical
# file collides across worktrees AND with the OMP hook (which keys the
# same way) — that's the cross-client/cross-worktree contention we want.
# A non-repository file below HOME is mapped to the reserved
# `@external/home/<relative>` key. This coordinates shared desktop/config edits
# (mimeapps.list, KDE settings, agent config) without weakening the server's
# no-absolute-path lock-store contract. Other repos and paths outside HOME stay
# unguarded.
workspace_root = os.path.realpath(
    os.environ.get('PAPERCUSP_WORKSPACE_ROOT')
    or os.path.expanduser('~/papercupai-workspace')
)

# ── Resolve to repo-relative POSIX, refuse symlinked paths ─────────────
repo_relative = []
repo_domains = set()


def _external_home_key(abs_path):
    """Reserved key for hidden HOME configuration. A user's HOME may itself
    be a git repo, so this check cannot depend on find_repo_root returning None.
    Keep automatic scope to dot-directories; an unrelated ~/project repo stays
    outside Papercusp coordination. Explicit locks:acquire external_paths may
    authorize any file below HOME."""
    try:
        home_root = os.path.realpath(
            os.environ.get('PAPERCUSP_EXTERNAL_LOCK_HOME')
            or os.path.expanduser('~'))
        logical_abs = os.path.abspath(abs_path)
        rel_home = os.path.relpath(logical_abs, home_root)
        first = rel_home.split(os.sep, 1)[0]
        if (rel_home and rel_home != '..'
                and not rel_home.startswith('..' + os.sep)
                and not os.path.isabs(rel_home)
                and first.startswith('.')):
            return '@external/home/' + rel_home.replace(os.sep, '/')
    except Exception:
        pass
    return None


for p in raw_paths:
    abs_p = p if os.path.isabs(p) else os.path.join(cwd, p)
    abs_p = os.path.abspath(abs_p)

    root = find_repo_root(abs_p)
    if not root:
        _external_key = _external_home_key(abs_p)
        if _external_key:
            repo_relative.append(_external_key)
        continue  # Outside a repo and outside HOME remains uncoordinated.

    # The hook may call an operator serving a DIFFERENT checkout than the one
    # being edited (normally :3070's release tree vs the canonical staging
    # tree). Preserve the physical repo root so locks:acquire keys the same
    # domain as this edit instead of the operator process's own checkout.
    repo_domains.add(os.path.realpath(root))

    # ── Worktree discipline: only the canonical staging tree is editable ──
    # The shared staging tree (papercusp) is the ONE tree agents edit — its
    # changes are what git-sync auto-commits + deploys. A stray sibling
    # worktree (papercup-staging, papercup-release, papercup-checkpoint,
    # papercusp-staging, old feature worktrees) is a direct child of the
    # workspace root just like the canonical tree, but work left in one never
    # reaches the committed tree (it stranded a whole feature on 2026-06-30).
    # Refuse edits in any such sibling. Isolation worktrees created by the
    # migration/synthesis roles live under <tree>/.papercusp/worktrees/, whose
    # parent is NOT the workspace root, so they pass through; foreign repos
    # outside the workspace are likewise unaffected. See plan
    # worktree-discipline-single-tree-enforcement-2026-06-30.
    #
    # EI-8820: the sibling-of-workspace-root check above only catches a
    # linked worktree that lives as a DIRECT CHILD of workspace_root. A
    # linked worktree of the canonical repo can be registered ANYWHERE
    # (e.g. ~/.papercusp-workspaces/<ws>/.papercusp/env-trees/<name> — a
    # per-workspace ephemeral checkout `git worktree add`-ed from the
    # canonical tree) and that shape slips past the parent-dir test
    # entirely, then hits the `continue` below as an unrelated "foreign"
    # repo — so edits there were silently ALLOWED and never git-sync
    # committed (a live repro stranded 6 edits + 1 write for 4+ ticks).
    # Catch it structurally instead of by location: a linked worktree's
    # `.git` is a FILE (`gitdir: .../worktrees/<name>`), not a directory;
    # resolve it through `commondir` to the real main repo's `.git`, and
    # if THAT main repo is the canonical tree, this worktree is exactly
    # as off-limits as a sibling one — no matter where on disk it sits.
    def _resolve_worktree_main_root(repo_root):
        """None if repo_root is an ordinary repo (its `.git` is a dir) or
        resolution fails for any reason (fail-open); else the main repo's
        working-tree root that this LINKED worktree belongs to."""
        try:
            git_entry = os.path.join(repo_root, '.git')
            if not os.path.isfile(git_entry):
                return None  # ordinary repo dir, or no .git at all
            with open(git_entry) as f:
                m = re.match(r'gitdir:\s*(.+)$', f.read().strip())
            if not m:
                return None
            wt_gitdir = m.group(1).strip()
            if not os.path.isabs(wt_gitdir):
                wt_gitdir = os.path.join(repo_root, wt_gitdir)
            wt_gitdir = os.path.realpath(wt_gitdir)
            commondir_path = os.path.join(wt_gitdir, 'commondir')
            if not os.path.exists(commondir_path):
                return None
            with open(commondir_path) as f:
                commondir = f.read().strip()
            if not os.path.isabs(commondir):
                commondir = os.path.join(wt_gitdir, commondir)
            main_git_dir = os.path.realpath(commondir)
            return os.path.dirname(main_git_dir)
        except Exception:
            return None  # fail-open — never wedge an edit on a parse error

    try:
        _canonical_tree = os.path.realpath(
            os.environ.get('PAPERCUSP_CANONICAL_TREE')
            or os.path.join(workspace_root, 'papercusp'))
        _real_root = os.path.realpath(root)
        _wt_main = _resolve_worktree_main_root(root)
        if _wt_main is not None and os.path.realpath(_wt_main) == _canonical_tree:
            if _real_root != _canonical_tree:
                deny(
                    f"worktree guard: refused — '{root}' is a LINKED WORKTREE of "
                    f"the canonical staging tree ({_canonical_tree}), registered "
                    f"outside it. Agents edit ONLY the canonical tree itself; work "
                    f"left in any of its linked worktrees is never committed by "
                    f"git-sync (it silently strands). cd into the canonical tree "
                    f"and make this edit there."
                )
        elif (os.path.realpath(os.path.dirname(root)) == workspace_root
                and _real_root != _canonical_tree):
            # WI-5031: a sibling is only a stranding hazard when it is a
            # checkout of the SAME project as the canonical tree (papercup-
            # release, papercup-checkpoint, old feature clones) — git-sync
            # commits only the canonical tree, so work left in those dies.
            # An INDEPENDENT repo that merely lives in the workspace dir
            # (papercup-rust-mobile: own .git, own remote, own commit
            # discipline) is legitimate to edit; denying it parked the whole
            # mobile release campaign as needs-human. Deny only when the
            # sibling's origin remote matches the canonical tree's, or when
            # either origin is unreadable (conservative: an unprovable
            # sibling keeps the old refusal).
            _sib_origin_raw = _repo_origin_url(root)
            _sib_origin = _norm_origin(_sib_origin_raw)
            _canon_origin = _norm_origin(_repo_origin_url(_canonical_tree))
            # Independent by EITHER proof:
            #  (a) both origins readable and DIFFERENT (WI-5031's original test), or
            #  (b) the sibling provably declares NO remotes — never cloned, so it
            #      cannot be a stray checkout of the canonical project
            #      (EI-18825797177551487; see _repo_has_zero_remotes).
            # Unproven in both directions still denies — the conservative default.
            #
            # (a) carries one blind spot: "different URL" is not "different
            # project" when the URL is a LOCAL PATH pointing back at the canonical
            # tree (EI-18826235967595309 — see
            # _origin_is_local_path_into_canonical). Such a sibling is a
            # same-project checkout wearing an unrecognizable origin, so it must
            # not earn independence from the mere string difference.
            _origins_differ = (_sib_origin is not None
                               and _canon_origin is not None
                               and _sib_origin != _canon_origin
                               and not _origin_is_local_path_into_canonical(
                                   _sib_origin_raw, root, _canonical_tree,
                                   _canon_origin))
            if not (_origins_differ or _repo_has_zero_remotes(root) is True):
                deny(
                    f"worktree guard: refused — you are editing in '{root}', which "
                    f"is not the canonical staging tree. Agents edit ONLY the shared "
                    f"staging tree ({_canonical_tree}); other worktrees are off-limits "
                    f"because work left in them never reaches the auto-committed tree. "
                    f"cd into the staging tree and make this edit there. (An "
                    f"INDEPENDENT sibling repo is exempt — one whose `origin` remote "
                    f"provably differs from the canonical tree's, OR which provably "
                    f"declares no remotes at all. This tree's origin matches the "
                    f"canonical project, or is a LOCAL PATH that resolves to it "
                    f"(a `git clone ../papercup` checkout — same project, different "
                    f"origin spelling), or its git config could not be read.)"
                )
    except Exception:
        pass  # The guard must never wedge an edit on its own error (fail-open).

    if os.path.realpath(os.path.dirname(root)) != workspace_root:
        _external_key = _external_home_key(abs_p)
        if _external_key:
            repo_relative.append(_external_key)
        continue  # A git repo, but not a papercup-workspace worktree.

    rel = os.path.relpath(abs_p, root)
    if rel.startswith('..'):
        continue  # Escapes the repo — not coordinated.

    # Symlink refusal (mirrors the OMP hook). The lock store keys on the
    # path STRING, so a symlink alias and its target are two keys — two
    # agents could "edit the same file" through different names and both
    # acquire. We run ON the agent's filesystem (the operator doesn't),
    # so we can catch it. REFUSE rather than silently rewrite to the
    # canonical path (rewriting would hide the aliasing from the agent).
    try:
        real_root = os.path.realpath(root)
        # For a not-yet-existent leaf (new file), realpath its parent so
        # a symlinked *directory* component is still caught.
        target = abs_p if os.path.exists(abs_p) else os.path.dirname(abs_p)
        real_rel = os.path.relpath(os.path.realpath(target), real_root)
        logical_rel = rel if os.path.exists(abs_p) else os.path.dirname(rel)
        if real_rel != (logical_rel or '.'):
            deny(
                f"locks: refused — '{rel}' resolves through a symlink "
                f"(real path '{real_rel}'). Edit the canonical path "
                f"directly so the lock keys on one name."
            )
    except Exception:
        pass  # realpath failure (broken link, EACCES) → leave to server.

    repo_relative.append(rel)

if not repo_relative:
    allow()

# Dedupe, keep order. Do this explicitly rather than using a truthiness-based
# list-comprehension idiom: set.add() returns the set (truthy), so
# `not (x in seen or seen.add(x))` drops every first occurrence and emits the
# invalid `paths: []` request shape.
seen = set()
deduped_repo_relative = []
for x in repo_relative:
    if x in seen:
        continue
    seen.add(x)
    deduped_repo_relative.append(x)
repo_relative = deduped_repo_relative

# ── Acquire (no server-side wait: block immediately so the agent can
#    replan now rather than hang the edit). ──────────────────────────────
body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'locks:acquire', 'arguments': {
        'paths': repo_relative,
        'intent': f'PreToolUse:{tool_name}',
        'ttl_sec': 1200,
        'wait': {'max_sec': 0},
        **({'coordination_domain': next(iter(repo_domains))} if len(repo_domains) == 1 else {}),
    }},
}).encode()

req = urllib.request.Request(
    # format=json: the MCP result-format default flipped to compact (TOON-rendered
    # text); this hook json.loads the tool result, so it MUST request json or the
    # parse fails and lock protection silently drops (fail-open).
    operator_url.rstrip('/') + '/api/mcp?superuser=1&format=json&client='
    + urllib.parse.quote(owner, safe=''),
    data=body,
    headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    },
    method='POST',
)
def _is_conn_refused(exc):
    # The :3070 host has no hot-reload, so picking up a lib/** edit means a
    # RESTART; during that few-second boot the port REFUSES connections. That
    # is the one transient worth retrying — distinguish it from a genuinely
    # down operator (which should still fail open promptly).
    if isinstance(exc, ConnectionRefusedError):
        return True
    if isinstance(getattr(exc, 'reason', None), ConnectionRefusedError):
        return True
    s = str(exc)
    return 'Connection refused' in s or 'Errno 111' in s

# Bounded retry on connection-refused so a short restart window doesn't drop
# lock protection for every concurrent agent (single-shot used to fail open
# instantly). ~2.4s max added delay, then fail open as before. Any non-refused
# error fails open immediately (no point waiting on a 500 / parse error).
RETRY_BACKOFFS = (0.4, 0.8, 1.2)
# The operator is ALWAYS local (127.0.0.1/localhost); an egress http(s)_proxy in
# the env must NEVER intercept this call — it 502s the localhost POST, which the
# loop below would treat as "operator unreachable" and fail OPEN, silently
# dropping file-lock protection for every concurrent agent (and reds the
# pretooluse-locks-decision gate test). Bypass all proxies for the operator call.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _locks_acquire_once():
    """One locks:acquire POST → the parsed inner tool result (a dict).
    Fail-open (allow → exit 0) on any transport or parse failure — identical
    posture to the previous inline flow; extracted so the EI-9478 transient
    retry below can re-attempt without duplicating the fail-open plumbing."""
    raw_resp = None
    last_exc = None
    for _attempt in range(len(RETRY_BACKOFFS) + 1):
        try:
            resp = _opener.open(req, timeout=10)
            raw_resp = resp.read().decode('utf-8', errors='replace')
            break
        except Exception as e:
            last_exc = e
            if _is_conn_refused(e) and _attempt < len(RETRY_BACKOFFS):
                time.sleep(RETRY_BACKOFFS[_attempt])
                continue
            break
    if raw_resp is None:
        mark_error('connect', last_exc)
        print(f'[locks] operator unreachable ({last_exc}); allowing edit (fail-open)',
              file=sys.stderr)
        allow()

    # Parse the first JSON-RPC result out of a JSON or text/event-stream body.
    result = None
    for line in raw_resp.splitlines():
        line = line.strip()
        if not line or line.startswith('event:'):
            continue
        if line.startswith('data:'):
            line = line[5:].strip()
        try:
            cand = json.loads(line)
            if isinstance(cand, dict) and 'result' in cand:
                result = cand['result']
                break
        except Exception:
            pass

    if not result:
        mark_error('parse', 'no JSON-RPC result in response')
        allow()

    inner = None
    for item in (result.get('content') or []):
        if item.get('type') == 'text':
            try:
                inner = json.loads(item['text'])
                break
            except Exception:
                continue

    if not inner:
        mark_error('parse', 'no text content in tool result')
        allow()
    return inner


def _grant(granted):
    """Cache the lock_id (+ only newly acquired paths) for the matching
    PostToolUse release, then allow.

    EI-63: when the calling owner already holds one of these paths under a
    distinct EXPLICIT lock_id (a deliberate multi-file locks:acquire held
    across several edits), the server's tryAcquire REUSES that existing
    lock_id for this grant (su-lock-store.ts: "reuse that lock_id ... so the
    entire returned set shares ONE lock_id"). If PostToolUse then releases by
    lock_id ALONE, it deletes every path under that lock_id — silently
    dissolving the rest of the explicit hold, not just the one path this edit
    touched. Caching the paths here lets PostToolUse scope its release to
    exactly this edit's path(s), which is a no-op regression for the common
    case (a fresh, non-shared lock_id covers exactly these paths anyway) and
    the actual fix for the shared-lock_id case. The server now returns
    ``newly_held``; an empty list means this automatic edit was covered by an
    existing deliberate hold, so it must not create a release token at all."""
    lock_id = granted.get('lock_id')
    newly_held = granted.get('newly_held')
    if isinstance(newly_held, list):
        release_paths = [p for p in newly_held if isinstance(p, str) and p]
    else:
        # Older operators do not send the additive field. Preserve their
        # existing behavior rather than silently allowing an untracked edit.
        release_paths = repo_relative[:50]
    decision = {
        'ts': now_iso(),
        'decision': 'already-held' if isinstance(newly_held, list) and not release_paths else 'granted',
        'owner': owner,
        'tool': tool_name,
        'paths': repo_relative[:50],
        'release_paths': release_paths,
        'lock_id': lock_id,
        **({'coordination_domain': next(iter(repo_domains))} if len(repo_domains) == 1 else {}),
    }
    write_marker('last-decision.json', decision)
    write_marker(owner_marker_name('decision'), decision)
    if lock_id and tool_use_id and release_paths:
        try:
            with open(os.path.join(cache_dir, tool_use_id + '.lock'), 'w') as f:
                f.write(lock_id)
            with open(os.path.join(cache_dir, tool_use_id + '.paths'), 'w') as f:
                json.dump(release_paths, f)
            if len(repo_domains) == 1:
                with open(os.path.join(cache_dir, tool_use_id + '.domain'), 'w') as f:
                    f.write(next(iter(repo_domains)))
        except Exception:
            pass
    _clear_transient_streak()
    allow()


def _is_transient(res):
    """EI-9478: `workspace_contended` = an advisory-lock serialization
    timeout whose holder identity is UNKNOWN. It does not prove that no
    agent holds the requested paths. Older servers surfaced the same
    condition as ok:false with NO reason and an EMPTY busy list — treat that
    shape as transient too, never as a foreign hold."""
    return res.get('reason') == 'workspace_contended' or (
        not res.get('reason') and not (res.get('busy') or []))


# EI-19324697909459657: "transient" and "one-off" are NOT the same claim, and
# the pre-fix message conflated them — it told the agent to "Simply RETRY"
# even after the SAME owner had already retried (both in-hook backoffs above
# AND the server's own acquireWithContentionRetry) and failed repeatedly. A
# genuine parallel-edit race self-heals in 1-2 attempts (see the 'heals on
# retry' test below); a run of consecutive failures for one owner instead
# points at a condition that has not self-healed. Track a per-owner streak
# across separate hook invocations (each Edit call is a fresh subprocess, so
# in-process state can't see across attempts) and, once it crosses a threshold,
# stop suggesting blind retry while preserving the only truthful fact: the
# advisory timeout did not identify its holder.
TRANSIENT_STREAK_ESCALATE_AT = 3


def _transient_streak_file():
    return os.path.join(cache_dir, owner_marker_name('transient-streak'))


def _read_transient_streak():
    try:
        with open(_transient_streak_file()) as f:
            v = json.load(f)
        c = v.get('count') if isinstance(v, dict) else None
        if isinstance(c, int) and c >= 0:
            return c
    except Exception:
        pass
    return 0


def _bump_transient_streak():
    count = _read_transient_streak() + 1
    write_marker(owner_marker_name('transient-streak'), {'count': count, 'ts': now_iso()})
    return count


def _clear_transient_streak():
    try:
        os.remove(_transient_streak_file())
    except Exception:
        pass


inner = _locks_acquire_once()
# We reached the operator and got a usable answer → enforcement healthy.
mark_success()

if inner.get('ok') is True:
    _grant(inner)

# EI-9478: transient serialization timeout — RETRY briefly before any deny, so
# a batch of parallel edits from one session self-heals instead of one arm
# being denied with a fabricated "held by another agent" (which could strand a
# half-applied multi-edit batch for git-sync to auto-commit broken).
if _is_transient(inner):
    for _backoff in (0.6, 1.2):
        time.sleep(_backoff)
        inner = _locks_acquire_once()
        if inner.get('ok') is True:
            _grant(inner)
        if not _is_transient(inner):
            break

if _is_transient(inner):
    _streak = _bump_transient_streak()
    if _streak >= TRANSIENT_STREAK_ESCALATE_AT:
        deny(
            f'locks: PERSISTENT transient contention — attempt #{_streak} in a row for '
            'this session. The advisory-lock timeout did not identify a holder; '
            'that is unknown, not evidence that the requested files are unheld. '
            'Stop immediately repeating this same acquire and inspect the lock '
            'service state or pivot to another task. Do NOT queue wake_on_grant '
            'for a timeout that produced no holder or waiter ticket.'
        )
    deny(
        'locks: transient contention — the lock service could not serialize this '
        'acquire in time (advisory-lock timeout; holder identity is unknown). '
        'This does not prove the requested files are unheld. Simply RETRY this '
        'same edit — do NOT queue wake_on_grant for this timeout because no '
        'holder or waiter ticket was returned.'
    )

# Busy (or another refusal) → deny with a reason the agent can act on.
busy = inner.get('busy') or []
lines = []
if inner.get('reason'):
    lines.append(f"locks: refused — {inner['reason']}")
else:
    lines.append('locks: file(s) held by another agent:')
for b in busy[:5]:
    label = b.get('owner_label') or b.get('owner')
    # Prefer the holder's DECLARED coord intent (what they're actually
    # changing) over the lock's own `intent`, which is a generic
    # 'PreToolUse:Edit' for hook-acquired edit locks. The server fills
    # holder_intent from coord:presence (declare-intent) when set.
    intent = b.get('holder_intent') or b.get('intent')
    focus = ' [focused on this file]' if b.get('holder_focused') else ''
    lines.append(
        f"  - {b.get('path')}: {label} — {intent!r}{focus} "
        f"(until {b.get('expires_ts')})"
    )
if len(busy) > 5:
    lines.append(f"  …and {len(busy) - 5} more")
lines.append('Options: locks:acquire {paths, intent, wake_on_grant:true} to queue '
             'and SLEEP — end your turn and you are re-invoked when the lock is '
             'granted (no polling). Or pivot to other work meanwhile; the wake '
             'arrives either way.')
paths = [b.get('path') for b in busy[:5] if b.get('path')]
lines.append('If locks:acquire is not on this client surface, use '
             'tools:invoke {name:"locks:acquire", args:{paths:' + json.dumps(paths) +
             ', intent:"<your intent>", wake_on_grant:true}} and end this turn.')
deny('\n'.join(lines))
PYEOF
