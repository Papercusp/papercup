// @vitest-environment jsdom
/**
 * RenderBoundary — the per-SECTION / per-ITEM boundaries (WI-6668).
 *
 * The property under test is BLAST RADIUS, not error formatting: a throw inside
 * one child must degrade THAT child and leave its siblings mounted. WI-6551
 * shipped because every existing fixture was fully populated, so no test had
 * ever rendered a malformed row at all — these deliberately do.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RenderBoundary, RowBoundary, SectionBoundary, boundaryMessage } from './RenderBoundary';

afterEach(cleanup);

/** React logs caught boundary errors itself; the boundary logs its own line on
 *  purpose (it is the only signal a survived crash leaves). Silence both so a
 *  passing suite is readable — but keep the spy so a test can assert we logged. */
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

function Boom({ what = 'kaboom' }: { what?: string }): React.ReactElement {
  throw new Error(what);
}

describe('RowBoundary', () => {
  it('degrades ONE bad row and leaves its siblings rendered', () => {
    render(
      <div>
        <RowBoundary label="WI-1">
          <p>first row</p>
        </RowBoundary>
        <RowBoundary label="WI-2">
          <Boom what="undefined is not an object (evaluating 'item.actions')" />
        </RowBoundary>
        <RowBoundary label="WI-3">
          <p>third row</p>
        </RowBoundary>
      </div>,
    );

    // The siblings survive — this is the whole point.
    expect(screen.getByText('first row')).toBeTruthy();
    expect(screen.getByText('third row')).toBeTruthy();

    // The bad row is REPLACED, not dropped: a silently missing row would make
    // the column's count a lie.
    const placeholder = screen.getByTestId('row-boundary-error');
    expect(placeholder.textContent).toContain('WI-2');
    // The message rides on `title`, not inline — a stack in a list row would
    // push every sibling off screen.
    expect(placeholder.getAttribute('title')).toContain('item.actions');
  });

  it('logs the crash — the survived-crash console line is the only signal', () => {
    render(
      <RowBoundary label="WI-9" scope="hud-card">
        <Boom />
      </RowBoundary>,
    );
    const logged = (errSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join('\n');
    expect(logged).toContain('[hud-card:WI-9]');
  });
});

describe('SectionBoundary', () => {
  it('degrades ONE section and leaves the others rendered', () => {
    render(
      <div>
        <SectionBoundary label="Needs you" className="hud__col">
          <section>needs-you body</section>
        </SectionBoundary>
        <SectionBoundary label="Working" className="hud__col">
          <Boom what="column blew up" />
        </SectionBoundary>
        <SectionBoundary label="Parked" className="hud__col">
          <section>parked body</section>
        </SectionBoundary>
      </div>,
    );

    expect(screen.getByText('needs-you body')).toBeTruthy();
    expect(screen.getByText('parked body')).toBeTruthy();

    const failed = screen.getByTestId('section-boundary-error');
    expect(failed.textContent).toContain('Working');
    expect(failed.textContent).toContain('column blew up');
    // The fallback keeps the caller's classes so the grid does not reflow
    // around a missing column.
    expect(failed.className).toContain('hud__col');
    // Announced, because a section vanishing is not something to discover.
    expect(failed.getAttribute('role')).toBe('alert');
  });

  /* The geometry guarantee, asserted mechanically rather than by screenshot.
     `.hud__cols` is a CSS GRID whose direct children are the columns, so if a
     boundary inserted a wrapper element on the HEALTHY path it would silently
     re-parent every column and collapse the board. RenderBoundary returns
     `this.props.children` — no DOM node — and this pins that: adopting the
     boundary must be a zero-DOM-diff change until something actually throws. */
  it('adds NO wrapper element while nothing is throwing (grid stays intact)', () => {
    const { container } = render(
      <div className="hud__cols">
        <SectionBoundary label="A" className="hud__col">
          <section className="hud__col hud__col--a">a</section>
        </SectionBoundary>
        <SectionBoundary label="B" className="hud__col">
          <section className="hud__col hud__col--b">b</section>
        </SectionBoundary>
      </div>,
    );
    const grid = container.querySelector('.hud__cols')!;
    expect(grid.children).toHaveLength(2);
    for (const child of Array.from(grid.children)) {
      expect(child.tagName).toBe('SECTION');
      expect(child.className).toContain('hud__col');
    }
  });

  it('the FALLBACK is still a direct grid child, so the row does not reflow', () => {
    const { container } = render(
      <div className="hud__cols">
        <SectionBoundary label="A" className="hud__col hud__col--a">
          <Boom />
        </SectionBoundary>
        <SectionBoundary label="B" className="hud__col hud__col--b">
          <section className="hud__col hud__col--b">b</section>
        </SectionBoundary>
      </div>,
    );
    const grid = container.querySelector('.hud__cols')!;
    expect(grid.children).toHaveLength(2);
    expect(grid.children[0].tagName).toBe('SECTION');
    expect(grid.children[0].className).toContain('hud__col--a');
  });

  it('recovers on "Try again" once the cause is gone', () => {
    let broken = true;
    function Sometimes() {
      if (broken) throw new Error('transient');
      return <p>healed</p>;
    }
    render(
      <SectionBoundary label="Flaky">
        <Sometimes />
      </SectionBoundary>,
    );
    expect(screen.getByTestId('section-boundary-error')).toBeTruthy();

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('healed')).toBeTruthy();
    expect(screen.queryByTestId('section-boundary-error')).toBeNull();
  });
});

describe('RenderBoundary', () => {
  it('clears a caught error when resetKey changes (escape-on-data-change)', () => {
    let broken = true;
    function Sometimes() {
      if (broken) throw new Error('stale row');
      return <p>fresh data</p>;
    }
    const fallback = () => <p>fallback shown</p>;

    const { rerender } = render(
      <RenderBoundary label="x" resetKey="v1" fallback={fallback}>
        <Sometimes />
      </RenderBoundary>,
    );
    expect(screen.getByText('fallback shown')).toBeTruthy();

    broken = false;
    rerender(
      <RenderBoundary label="x" resetKey="v2" fallback={fallback}>
        <Sometimes />
      </RenderBoundary>,
    );
    expect(screen.getByText('fresh data')).toBeTruthy();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <RenderBoundary label="x" fallback={() => <p>nope</p>}>
        <p>healthy</p>
      </RenderBoundary>,
    );
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.queryByText('nope')).toBeNull();
  });
});

describe('boundaryMessage', () => {
  it('keeps an Error message', () => {
    expect(boundaryMessage(new Error('boom'))).toBe('boom');
  });
  it('passes a thrown string through', () => {
    expect(boundaryMessage('just a string')).toBe('just a string');
  });
  it('does not render a thrown object as [object Object]', () => {
    // A non-Error throw is real (a rejected value, a thrown POJO) and the
    // placeholder's title is the only place the cause is visible.
    expect(boundaryMessage({ code: 'E_BAD' })).toBe('{"code":"E_BAD"}');
  });
  it('survives an unserializable throw', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof boundaryMessage(cyclic)).toBe('string');
  });
  it('never returns an empty string for an Error with no message', () => {
    expect(boundaryMessage(new Error(''))).toBe('Error');
  });
});
