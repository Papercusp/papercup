/**
 * Incrementally exposes user-visible text from the operator's `<say>` envelope.
 *
 * The converse stream also carries control tags (`<sleep>`, `<continue/>`, …),
 * so rendering raw SSE deltas would leak protocol text into the chat. This
 * projector stays silent until it has seen a complete `<say>` opener, emits
 * only its body, and withholds any suffix that could be a split `</say>` tag.
 * The completed turn still goes through parseOperatorTurn; this is only the
 * low-latency visual projection while that canonical parse is in flight.
 */

const SAY_OPEN = "<say>";
const SAY_CLOSE = "</say>";

function trailingClosePrefixLength(value: string): number {
  const max = Math.min(value.length, SAY_CLOSE.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(SAY_CLOSE.slice(0, length))) return length;
  }
  return 0;
}

export class OperatorSayStreamProjector {
  private raw = "";
  private emittedLength = 0;
  private projectedText = "";
  private closed = false;

  push(chunk: string): string {
    if (!chunk || this.closed) return "";
    this.raw += chunk;

    const openAt = this.raw.indexOf(SAY_OPEN);
    if (openAt < 0) return "";

    const contentStart = openAt + SAY_OPEN.length;
    const closeAt = this.raw.indexOf(SAY_CLOSE, contentStart);
    const bodySoFar = this.raw.slice(
      contentStart,
      closeAt >= 0 ? closeAt : undefined,
    );
    const safeBody =
      closeAt >= 0
        ? bodySoFar
        : bodySoFar.slice(
            0,
            bodySoFar.length - trailingClosePrefixLength(bodySoFar),
          );

    if (closeAt >= 0) this.closed = true;
    if (safeBody.length <= this.emittedLength) return "";

    const delta = safeBody.slice(this.emittedLength);
    this.emittedLength = safeBody.length;
    this.projectedText = safeBody;
    return delta;
  }

  get text(): string {
    return this.projectedText;
  }

  get complete(): boolean {
    return this.closed;
  }
}
