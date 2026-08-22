// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServerConnectionGate, { normalizeRemoteServerUrl } from './ServerConnectionGate';

afterEach(() => {
  cleanup();
  delete window.__papercuspBootError;
  delete window.__papercuspServerConnectionRequired;
});

describe('normalizeRemoteServerUrl', () => {
  it('keeps only a credential-free HTTPS origin', () => {
    expect(normalizeRemoteServerUrl('https://server.example.com:8443/path?q=1#x')).toBe(
      'https://server.example.com:8443/',
    );
    expect(normalizeRemoteServerUrl('http://server.example.com')).toBeNull();
    expect(normalizeRemoteServerUrl('https://user:secret@server.example.com')).toBeNull();
    expect(normalizeRemoteServerUrl('not a url')).toBeNull();
  });
});

describe('<ServerConnectionGate>', () => {
  it('stays absent during normal connected/browser operation', () => {
    const { container } = render(<ServerConnectionGate />);
    expect(container.innerHTML).toBe('');
  });

  it('presents local and remote/hosted choices when Rust reports no endpoint', () => {
    render(<ServerConnectionGate />);
    fireEvent(
      window,
      new CustomEvent('papercusp:server-connection-required', {
        detail: 'Papercusp Server is not installed.',
      }),
    );

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Use this computer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry local Server' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Use another Server' })).toBeTruthy();
    expect(screen.getByLabelText('Server address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect securely' })).toBeTruthy();
    expect(screen.getByText('Papercusp Server is not installed.')).toBeTruthy();
  });

  it('rejects an insecure remote address without navigating', () => {
    window.__papercuspServerConnectionRequired = 'No endpoint.';
    render(<ServerConnectionGate />);
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'http://remote.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect securely' }));
    expect(screen.getByRole('alert').textContent).toContain('credential-free HTTPS');
  });
});
