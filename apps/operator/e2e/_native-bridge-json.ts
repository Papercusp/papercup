/**
 * JSON-valued tauri-agent-tools commands print the decoded bridge value as JSON.
 * Decode stdout once: a resulting string is the value, even if it resembles JSON.
 * Raw text commands such as screenshot use their own caller path.
 */
export function decodeNativeBridgeJson(stdout: string) {
  return JSON.parse(stdout);
}
