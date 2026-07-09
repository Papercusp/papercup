#!/usr/bin/env python3
"""WI-3464 / P-007: docs+prompts lexicon rename codemod.
hive->pot, bee->cup, queen->mug, sentinel->papercup (case-preserving, word-bounded).
Protects: red-queen, the-hive (brand pack), kept historical plan slugs,
SCREAMING_SNAKE / snake_case identifiers, camelCase identifiers (all safe
automatically because '_'/letters don't create a \\b boundary).
"""
import re, sys, os

KEPT_SLUGS = [
    "sentinel-as-claude-tui-2026-06-22",
    "sentinel-tui-shared-backend-and-cards-2026-06-22",
    "SELF-BRIEF-solo-hive-git-takeover-2026-07-02",
]

PAIRS_PLURAL = [
    ("hives", "pots"), ("bees", "cups"), ("queens", "mugs"), ("sentinels", "papercups"),
]
PAIRS_SINGULAR = [
    ("hive", "pot"), ("bee", "cup"), ("queen", "mug"), ("sentinel", "papercup"),
]

def case_variants(old, new):
    return [
        (old.lower(), new.lower()),
        (old.capitalize(), new.capitalize()),
        (old.upper(), new.upper()),
    ]

MASK_OPEN, MASK_CLOSE = "", ""

def transform(text):
    masks = []

    def mask_pattern(pattern, flags=0):
        nonlocal text
        def repl(m):
            masks.append(m.group(0))
            return f"{MASK_OPEN}{len(masks)-1}{MASK_CLOSE}"
        text = re.sub(pattern, repl, text, flags=flags)

    mask_pattern(r"\bred-queen\b", re.IGNORECASE)
    mask_pattern(r"\bthe-hive\b", re.IGNORECASE)
    for slug in KEPT_SLUGS:
        mask_pattern(r"\b" + re.escape(slug) + r"\b", re.IGNORECASE)

    # Protect literal current-repo SOURCE-TREE paths (not yet renamed by other
    # slices — packages/apps/libs/scripts/desktop dirs still use old names on
    # disk today). Docs-site paths (apps/operator-docs, the built
    # apps/operator/public/internal/docs mirror) ARE being renamed as part of
    # this sweep, so they're excluded from the path guard.
    NOT_DOCS = r"(?!operator-docs\b)(?!operator/public/internal/docs\b)"
    mask_pattern(
        r"`(?:packages|libs|papercusp-desktop|scripts)/[^`]*`"
        r"|`apps/" + NOT_DOCS + r"[^`]*`",
    )
    mask_pattern(
        r"\b(?:packages|libs|papercusp-desktop|scripts)/[\w./-]*"
        r"|\bapps/" + NOT_DOCS + r"[\w./-]*",
    )

    for old, new in PAIRS_PLURAL + PAIRS_SINGULAR:
        for ov, nv in case_variants(old, new):
            text = re.sub(r"\b" + re.escape(ov) + r"\b", nv, text)

    for i, val in enumerate(masks):
        text = text.replace(f"{MASK_OPEN}{i}{MASK_CLOSE}", val)
    return text


def main():
    file_list_path = sys.argv[1]
    dry = "--dry" in sys.argv
    with open(file_list_path) as f:
        paths = [l.strip() for l in f if l.strip()]

    changed = []
    renames = []
    for p in paths:
        if not os.path.isfile(p):
            print(f"SKIP missing: {p}")
            continue
        with open(p, "r", encoding="utf-8", errors="surrogateescape") as f:
            orig = f.read()
        new = transform(orig)
        if new != orig:
            changed.append(p)
            if not dry:
                with open(p, "w", encoding="utf-8", errors="surrogateescape") as f:
                    f.write(new)
        newpath = transform(p)
        if newpath != p:
            renames.append((p, newpath))

    print(f"content-changed: {len(changed)} / {len(paths)}")
    print(f"renames-needed: {len(renames)}")
    with open("scratchpad/wi3464/renames.tsv", "w") as f:
        for old, new in renames:
            f.write(f"{old}\t{new}\n")
    with open("scratchpad/wi3464/changed.txt", "w") as f:
        for c in changed:
            f.write(c + "\n")

if __name__ == "__main__":
    main()
