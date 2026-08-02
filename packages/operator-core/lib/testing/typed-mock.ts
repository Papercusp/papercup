/**
 * typed-mock.ts — the typed alternative to `fn.mockImplementation(x as never)`
 * (EI-19282401068515102).
 *
 * `vi.mocked(realFn)` exists to typecheck whatever you install via
 * `.mockImplementation(...)` / `.mockResolvedValue(...)` / `.mockReturnValue(...)` /
 * `.mockRejectedValue(...)` against `realFn`'s OWN real signature. Casting the
 * installed value `as never` (or `as any`) defeats that check completely — the
 * argument becomes assignable to ANY signature, so a fixture that goes stale the
 * moment the real function's return type changes (most commonly: a shared interface
 * gains a REQUIRED field) is invisible to tsc. It fails at RUNTIME instead, in a file
 * the actual change never touched, and `test:affected` will not even select it.
 *
 * CONFIRMED LIVE (2026-08-01, WI-6673): adding the required `admitted` field to
 * `IssueClaimabilityReading` silently broke 14 tests across two files, both committed
 * red, precisely because each fixture was cast `as never`.
 *
 * These three helpers forward directly to the real vitest mock methods — they add NO
 * new behavior. Their entire value is that TypeScript infers the function type `T`
 * from the `mock` argument itself (since `vi.mocked(realFn)` already carries it), so
 * the installed value/implementation is checked against `realFn`'s real signature
 * with NO generic to hand-write and NO cast to reach for. A fixture that goes stale
 * becomes a compile error at the fixture site instead of a runtime failure at some
 * unrelated peer's green-checkpoint run hours later.
 *
 * Usage (replacing a hand-rolled `as never` escape):
 *
 *   const readM = vi.mocked(readIssueClaimability);
 *   mockResolvedTyped(readM, { breakdown, rows, admitted });      // was: .mockResolvedValue({...} as never)
 *   mockImplementationTyped(readM, async (_filter, _opts, readOpts) => ({ ... }));
 *
 * If a fixture genuinely cannot be typed this way (a rare, deliberate exception —
 * not "the types are annoying to satisfy"), that is worth a comment at the call site
 * explaining why, not a silent `as never`: `check-mock-cast-escape.mjs` ratchets the
 * count of the latter so a new one never lands unnoticed.
 */
import type { Mock } from 'vitest';

/** A vitest mock installed FOR a specific async function `T`, preserving its real types. */
type AsyncMockFor<T extends (...args: never[]) => Promise<unknown>> = Mock<T>;
/** A vitest mock installed FOR a specific (possibly sync) function `T`. */
type MockFor<T extends (...args: never[]) => unknown> = Mock<T>;

/**
 * `mock.mockResolvedValue(value)`, with `value` checked against the real function's
 * own resolved-value type (`Awaited<ReturnType<T>>`) — inferred from `mock` itself.
 */
export function mockResolvedTyped<T extends (...args: never[]) => Promise<unknown>>(
  mock: AsyncMockFor<T>,
  value: Awaited<ReturnType<T>>,
): void {
  mock.mockResolvedValue(value);
}

/** `Once` sibling of {@link mockResolvedTyped}. */
export function mockResolvedOnceTyped<T extends (...args: never[]) => Promise<unknown>>(
  mock: AsyncMockFor<T>,
  value: Awaited<ReturnType<T>>,
): void {
  mock.mockResolvedValueOnce(value);
}

/**
 * `mock.mockReturnValue(value)`, with `value` checked against the real function's own
 * return type — inferred from `mock` itself.
 */
export function mockReturnTyped<T extends (...args: never[]) => unknown>(mock: MockFor<T>, value: ReturnType<T>): void {
  mock.mockReturnValue(value);
}

/** `Once` sibling of {@link mockReturnTyped}. */
export function mockReturnOnceTyped<T extends (...args: never[]) => unknown>(mock: MockFor<T>, value: ReturnType<T>): void {
  mock.mockReturnValueOnce(value);
}

/**
 * `mock.mockImplementation(impl)`, with `impl` checked against the real function's own
 * signature (parameters AND return type) — inferred from `mock` itself. This is the
 * form that matters most: an inline `(...) => ({...})` implementation is exactly what
 * `readM.mockImplementation((async (...) => ({...})) as never)` was hiding a stale
 * fixture inside.
 */
export function mockImplementationTyped<T extends (...args: never[]) => unknown>(mock: MockFor<T>, impl: T): void {
  mock.mockImplementation(impl);
}

/** `mock.mockRejectedValue(reason)` for a mock installed for an async function `T`. */
export function mockRejectedTyped<T extends (...args: never[]) => Promise<unknown>>(mock: AsyncMockFor<T>, reason: unknown): void {
  mock.mockRejectedValue(reason);
}
