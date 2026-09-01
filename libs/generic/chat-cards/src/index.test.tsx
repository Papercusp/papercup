import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CardRenderer, PendingCardsBar } from './index';

describe('@papercusp/chat-cards', () => {
  it('shapes a shared choice card submission as CardResponse', () => {
    const onResponse = vi.fn();
    render(<CardRenderer card={{
      correlationId: 'card-1',
      createdAt: 1,
      prompt: 'Choose',
      presentation: { kind: 'radio', options: [{ id: 'a', label: 'A' }] },
    }} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(onResponse).toHaveBeenCalledWith({
      action: 'submit',
      correlationId: 'card-1',
      value: { picks: ['a'] },
    });
  });

  it('renders one current card and states the remaining queue', () => {
    render(<PendingCardsBar cards={[
      { correlationId: 'a', createdAt: 1, prompt: 'First' },
      { correlationId: 'b', createdAt: 2, prompt: 'Second' },
    ]} onResponse={() => {}} />);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.queryByText('Second')).toBeNull();
    expect(screen.getByText('1 more card after this')).toBeTruthy();
  });
});
