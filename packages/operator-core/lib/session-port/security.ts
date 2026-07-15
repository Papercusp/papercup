export const SESSION_PORT_FRAME_OPEN = '<PAPERCUSP_SESSION_PORT_DATA>';
export const SESSION_PORT_FRAME_CLOSE = '</PAPERCUSP_SESSION_PORT_DATA>';

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{12,}/gi },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gi },
  { name: 'github-token', re: /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi },
  {
    name: 'secret-assignment',
    re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s,;]{8,})/gi,
  },
];

export interface SanitizedText {
  text: string;
  redactions: number;
  controlBytesRemoved: number;
  delimiterEscapes: number;
}

/** Redact before a byte can enter an artifact or summarizer request, strip
 * terminal controls, and neutralize our own framing delimiters. */
export function sanitizePortableText(input: unknown): SanitizedText {
  let text = String(input ?? '');
  const beforeControls = text.length;
  text = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const controlBytesRemoved = beforeControls - text.length;
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern.re, (...args: string[]) => {
      redactions++;
      return pattern.name === 'secret-assignment' ? `${args[1]}=[REDACTED]` : '[REDACTED]';
    });
  }
  let delimiterEscapes = 0;
  for (const delimiter of [SESSION_PORT_FRAME_OPEN, SESSION_PORT_FRAME_CLOSE]) {
    text = text.split(delimiter).join(delimiter.replace('<', '&lt;'));
    delimiterEscapes += String(input ?? '').split(delimiter).length - 1;
  }
  return { text, redactions, controlBytesRemoved, delimiterEscapes };
}
