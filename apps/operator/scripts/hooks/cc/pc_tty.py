"""pc_tty — resolve the terminal a papercusp hook's OSC-0 title write belongs to.

WHY THIS EXISTS (WI-3665, 2026-07-09). Every papercusp CLI hook renders the
fleet identity (👑 leader / 👤 member + fleet name + colour square) into the OS
terminal title via an OSC-0 escape. Historically each hook opened `/dev/tty` —
the process's CONTROLLING terminal. That silently stopped working on Claude
Code, which spawns the `statusLine` command in its OWN SESSION (setsid'd):

    pid=853874 ppid=853873 sid=853873 tty=?
      /dev/tty  -> ENXIO (no controlling terminal)

A setsid'd child has no controlling terminal, so the open failed, the hook
failed open (by design), and the title write was a silent no-op on EVERY tick
for as long as that spawn mode has existed. The title was computed correctly the
whole time — it just never landed. Nothing detected it because "fail open" and
"succeeded" look identical from outside.

WHY NOT WALK /proc ANCESTRY. The obvious fix — climb the parent chain to the
first ancestor with a controlling tty (`/proc/<pid>/stat` field 7 → tty_nr →
major 136 = /dev/pts/<minor>) — WORKS, and was verified to work. It is also
WRONG, because process ancestry crosses ownership boundaries. Measured on this
box: a bash under one agent's session walks up to `claude tty_nr=34881` =
/dev/pts/65, a DIFFERENT agent's terminal. A headless bee spawned by an operator
that was itself started from a dev terminal would happily retitle that dev
terminal. A title write must only ever touch a terminal this session OWNS.

THE RULE. Terminal ownership is knowable exactly once — at launch, by the
process that attaches the agent to the terminal. `psu-launcher` resolves its own
tty and exports it as `PAPERCUSP_TTY`; every descendant (including a setsid'd
statusline child, which still inherits the ENV) reads it back from here. No
guessing, no walking, no chance of writing to a window we don't own.

Consumed by `statusline-fleet.sh` (Claude) and `posttooluse-objective-title.sh`
(Codex). The OMP twin lives in `hooks/omp/coord-hook.ts` (`ttyCandidates` /
`writeOscTitle`) and is held in lockstep by objective-title-parity.test.ts.

Everything here is FAIL-OPEN: a title is cosmetic and must never break a hook,
a tool call, or a turn.
"""

import os

__all__ = ['strip_control', 'tty_candidates', 'osc_title', 'write_osc_title']


def strip_control(title):
    """Drop control chars that could break out of the OSC string.

    The server render (status-display.ts) already strips these; this guards a
    buggy `display.title`, the legacy per-hook fallback renders, and any future
    caller. Kept identical to the TS twin's filter so titles stay byte-identical
    across CLIs.
    """
    return ''.join(c for c in str(title or '') if ord(c) >= 32 and c not in '\x07\x1b')


def tty_candidates(env=None, extra_first=()):
    """Ordered terminal paths to try, most authoritative first.

    1. `extra_first` — the caller's own test seam (e.g. PAPERCUSP_OBJECTIVE_TTY),
       so a test can capture the escape in a temp FILE instead of a real tty.
    2. `PAPERCUSP_TTY` — the owning terminal, resolved at launch by psu-launcher
       and inherited through every intermediate process, setsid'd or not. This is
       the ONLY entry that survives Claude's detached statusline spawn.
    3. `/dev/tty` — the controlling terminal. Correct for hooks that kept one
       (Codex's child hooks, OMP's in-process hook) and for a plain `claude` run
       outside psu. Harmless when absent: the open just fails.

    A stale/unopenable candidate is skipped, not fatal — hence a LIST, not a
    single answer. Terminals close; a session outliving its window must not start
    throwing.
    """
    env = os.environ if env is None else env
    out = []
    for name in extra_first:
        val = (env.get(name) or '').strip()
        if val:
            out.append(val)
    owned = (env.get('PAPERCUSP_TTY') or '').strip()
    if owned:
        out.append(owned)
    out.append('/dev/tty')
    return out


def osc_title(title):
    """The OSC-0 set-title escape, or '' when there's nothing safe to write.

    OSC 0 sets BOTH the icon name and the window title: ESC ] 0 ; <text> BEL.
    """
    clean = strip_control(title)
    return '\033]0;{}\007'.format(clean) if clean else ''


def write_osc_title(title, env=None, extra_first=()):
    """Set the terminal title. Returns True if some terminal accepted the write.

    Tries each candidate in order and stops at the first success. Returns False
    when every candidate fails (headless session, closed terminal, no tty
    anywhere) — the caller ignores the result; a title is cosmetic.
    """
    osc = osc_title(title)
    if not osc:
        return False
    for path in tty_candidates(env, extra_first):
        try:
            with open(path, 'w') as fh:
                fh.write(osc)
                fh.flush()
            return True
        except Exception:
            continue  # stale seam / closed terminal / no tty — try the next
    return False
