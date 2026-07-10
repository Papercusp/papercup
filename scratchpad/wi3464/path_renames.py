import sys
sys.path.insert(0, 'scratchpad/wi3464')
import re
from codemod import PAIRS_PLURAL, PAIRS_SINGULAR, case_variants, KEPT_SLUGS

def transform_nopath(text):
    masks = []
    def mask_pattern(pattern, flags=0):
        nonlocal text
        def repl(m):
            masks.append(m.group(0))
            return f"{chr(0xE000)}{len(masks)-1}{chr(0xE001)}"
        text = re.sub(pattern, repl, text, flags=flags)
    mask_pattern(r"\bred-queen\b", re.IGNORECASE)
    mask_pattern(r"\bthe-hive\b", re.IGNORECASE)
    for slug in KEPT_SLUGS:
        mask_pattern(r"\b" + re.escape(slug) + r"\b", re.IGNORECASE)
    for old, new in PAIRS_PLURAL + PAIRS_SINGULAR:
        for ov, nv in case_variants(old, new):
            text = re.sub(r"\b" + re.escape(ov) + r"\b", nv, text)
    for i, val in enumerate(masks):
        text = text.replace(f"{chr(0xE000)}{i}{chr(0xE001)}", val)
    return text

files = [l.strip() for l in open('scratchpad/wi3464/md_target_files4.txt')]
renames = []
for p in files:
    newp = transform_nopath(p)
    if newp != p:
        renames.append((p, newp))
print(len(renames))
for o, n in renames:
    print(o + "\t" + n)
