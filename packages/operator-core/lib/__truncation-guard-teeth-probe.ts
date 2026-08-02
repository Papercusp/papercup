// TEMP probe — verifying the truncation-honesty guard bites. Deleted immediately.
import { capInjectionText } from './context-doors';
export function fakeNewDoor(text: string): string {
  const { kept } = capInjectionText(text, 100);
  return `${kept}\n[fake-door: this result was truncated]`;
}
