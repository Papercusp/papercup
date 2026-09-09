/**
 * Minimal VT screen grid for installed-binary Ratatui PTY tests.
 *
 * Ratatui writes cursor-jump diffs: later frames contain only changed cells,
 * so stripping ANSI from the raw stream cannot recover what a person sees.
 * This parser replays the stream into a fixed-size grid and exposes the
 * rendered screen for assertions.
 */

// Written as an escape sequence rather than a raw control byte so
// lint:no-control-bytes remains green. Runtime-identical.
const ESC = '\x1b';

export class VtScreen {
  private grid: string[][];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;

  constructor(
    private rows: number,
    private cols: number,
  ) {
    this.grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  }

  private clamp(v: number, max: number): number {
    return Math.max(0, Math.min(v, max));
  }

  private clearAll(): void {
    for (const row of this.grid) row.fill(' ');
  }

  private clearRow(row: number, from: number, to: number): void {
    for (let col = from; col < to; col++) this.grid[row][col] = ' ';
  }

  private lineFeed(): void {
    this.row++;
    if (this.row >= this.rows) {
      this.grid.shift();
      this.grid.push(new Array<string>(this.cols).fill(' '));
      this.row = this.rows - 1;
    }
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.col] = ch;
    this.col++;
  }

  private csi(params: string, final: string): void {
    const isPrivate = params.startsWith('?');
    const nums = (isPrivate ? params.slice(1) : params)
      .split(';')
      .map((param) => parseInt(param, 10))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const first = nums[0] ?? 0;
    switch (final) {
      case 'H':
      case 'f':
        this.row = this.clamp((nums[0] || 1) - 1, this.rows - 1);
        this.col = this.clamp((nums[1] || 1) - 1, this.cols - 1);
        break;
      case 'A':
        this.row = this.clamp(this.row - (first || 1), this.rows - 1);
        break;
      case 'B':
        this.row = this.clamp(this.row + (first || 1), this.rows - 1);
        break;
      case 'C':
        this.col = this.clamp(this.col + (first || 1), this.cols - 1);
        break;
      case 'D':
        this.col = this.clamp(this.col - (first || 1), this.cols - 1);
        break;
      case 'G':
        this.col = this.clamp((first || 1) - 1, this.cols - 1);
        break;
      case 'd':
        this.row = this.clamp((first || 1) - 1, this.rows - 1);
        break;
      case 'J':
        if (first === 2 || first === 3) this.clearAll();
        else if (first === 1) {
          for (let row = 0; row < this.row; row++) this.clearRow(row, 0, this.cols);
          this.clearRow(this.row, 0, this.col + 1);
        } else {
          this.clearRow(this.row, this.col, this.cols);
          for (let row = this.row + 1; row < this.rows; row++) {
            this.clearRow(row, 0, this.cols);
          }
        }
        break;
      case 'K':
        if (first === 2) this.clearRow(this.row, 0, this.cols);
        else if (first === 1) this.clearRow(this.row, 0, this.col + 1);
        else this.clearRow(this.row, this.col, this.cols);
        break;
      case 'h':
      case 'l':
        // Alt-screen enter/leave means a fresh screen. Other private modes
        // (cursor visibility, mouse, bracketed paste) do not affect the grid.
        if (isPrivate && nums.includes(1049)) {
          this.clearAll();
          this.row = 0;
          this.col = 0;
        }
        break;
      default:
        break;
    }
  }

  /**
   * Feed the whole raw stream from scratch. An incomplete trailing escape
   * sequence is left for the next replay instead of being mis-parsed.
   */
  feed(data: string): void {
    let index = 0;
    while (index < data.length) {
      const ch = data[index];
      if (ch === ESC) {
        const kind = data[index + 1];
        if (kind === undefined) break;
        if (kind === '[') {
          let end = index + 2;
          while (end < data.length && !(data[end] >= '@' && data[end] <= '~')) end++;
          if (end >= data.length) break;
          this.csi(data.slice(index + 2, end), data[end]);
          index = end + 1;
        } else if (kind === ']') {
          let end = index + 2;
          while (end < data.length && data[end] !== '\x07' && !(data[end] === ESC && data[end + 1] === '\\')) {
            end++;
          }
          if (end >= data.length) break;
          index = data[end] === '\x07' ? end + 1 : end + 2;
        } else if (kind === '7') {
          this.savedRow = this.row;
          this.savedCol = this.col;
          index += 2;
        } else if (kind === '8') {
          this.row = this.savedRow;
          this.col = this.savedCol;
          index += 2;
        } else if (kind === '(' || kind === ')') {
          index += 3;
        } else {
          index += 2;
        }
        continue;
      }
      if (ch === '\n') this.lineFeed();
      else if (ch === '\r') this.col = 0;
      else if (ch === '\b') this.col = this.clamp(this.col - 1, this.cols - 1);
      else if (ch === '\t') {
        this.col = this.clamp((Math.floor(this.col / 8) + 1) * 8, this.cols - 1);
      } else if (ch >= ' ' && ch !== '\x7f') {
        this.put(ch);
      }
      index++;
    }
  }

  text(): string {
    return this.grid.map((row) => row.join('').trimEnd()).join('\n');
  }
}

/** Normalize column padding while retaining row boundaries. */
export function screenContains(screen: string, needle: string): boolean {
  const normalized = screen
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n');
  return normalized.includes(needle.replace(/\s+/g, ' ').trim());
}

/** Match an assistant bubble, never an echoed owner prompt. */
export function screenHasAssistantReply(screen: string, needle: string | RegExp): boolean {
  const rows = screen.split('\n');
  const top = rows.findIndex((row) => row.startsWith('┌ Agent Chat'));
  if (top < 0) return false;
  const right = rows[top].indexOf('┐');
  if (right < 2) return false;
  const body = rows.slice(top + 1);
  const bottom = body.findIndex((row) => row.startsWith('└'));
  // The transcript's border defines its columns; content may itself contain
  // pipes, and another pane may contain words that resemble an answer.
  const lines = (bottom < 0 ? body : body.slice(0, bottom))
    .filter((row) => row.startsWith('│'))
    .map((row) => row.slice(1, right).trimEnd());
  const matches = (line: string): boolean => {
    if (typeof needle === 'string') return line.includes(needle);
    needle.lastIndex = 0;
    return needle.test(line);
  };
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== 'agent') continue;
    for (let replyIndex = index + 1; replyIndex < lines.length; replyIndex++) {
      const line = lines[replyIndex];
      if (line === 'agent' || line === 'you') break;
      // Reasoning/tool detail rows are indented; the rendered final answer is
      // top-level even when it follows those sections in the same bubble.
      if (line.trim() && !/^\s/.test(line) && matches(line)) return true;
    }
  }
  return false;
}
