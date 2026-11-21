import { diffChars, diffLines } from 'diff';

interface Edit {
  from: number;
  to: number;
  insert: string;
}

function edits(parts: ReadonlyArray<{ value: string; added?: boolean; removed?: boolean }>, offset = 0): Edit[] {
  const result: Edit[] = [];
  let current: Edit | undefined;
  for (const part of parts) {
    if (part.added || part.removed) {
      if (!current) {
        current = { from: offset, to: offset, insert: '' };
        result.push(current);
      }
      if (part.added) current.insert += part.value;
      if (part.removed) {
        offset += part.value.length;
        current.to = offset;
      }
    } else {
      current = undefined;
      offset += part.value.length;
    }
  }
  return result;
}

function markdownEdits(before: string, after: string): Edit[] {
  // Keep the character comparison local to the changed lines in a large plan.
  return edits(diffLines(before, after)).flatMap(block =>
    block.from === block.to || !block.insert ? [block] :
      edits(diffChars(before.slice(block.from, block.to), block.insert), block.from));
}

/** Vditor serializes the whole Markdown document when a single character is edited.
 * Replay the user's edits and retain the source representation of untouched ranges. */
export function applyPlanMarkdownEdit(source: string, rendered: string, draft: string): string {
  if (draft === rendered || draft === source) return source;
  if (source === rendered || !draft) return draft;
  const changes = markdownEdits(rendered, draft);
  if (changes.length === 1 && changes[0]!.from === 0 && changes[0]!.to === rendered.length) return draft;

  let index = 0;
  const retained = markdownEdits(rendered, source).filter(format => {
    while (index < changes.length && changes[index]!.to <= format.from) index++;
    const change = changes[index];
    // Adjacent changes can coexist. For an edit inside reformatted syntax, the
    // user's current rendering supplies that syntax as well as their new text.
    return !change || change.from >= format.to;
  });
  const merged = [...retained, ...changes].sort((a, b) => a.from - b.from || a.to - b.to);
  const pieces: string[] = [];
  let position = 0;
  for (const edit of merged) {
    pieces.push(rendered.slice(position, edit.from), edit.insert);
    position = edit.to;
  }
  pieces.push(rendered.slice(position));
  return pieces.join('');
}
