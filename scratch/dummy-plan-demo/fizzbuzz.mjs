/**
 * fizzbuzz(n) — the classic FizzBuzz mapping for a single integer.
 *
 * Rules (checked most-specific first):
 *   - n divisible by 15 → 'FizzBuzz'
 *   - n divisible by 3  → 'Fizz'
 *   - n divisible by 5  → 'Buzz'
 *   - otherwise         → the number as a string
 *
 * Part of the dummy-demo-plan-2026-06-29 exercise (P-001) — a scratch artifact
 * that walks the plan → work-item → implement → verify flow end to end.
 */
export function fizzbuzz(n) {
  if (n % 15 === 0) return 'FizzBuzz';
  if (n % 3 === 0) return 'Fizz';
  if (n % 5 === 0) return 'Buzz';
  return String(n);
}

export default fizzbuzz;
