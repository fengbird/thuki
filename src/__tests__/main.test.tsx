import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { pickRoot } from '../main-root';

describe('main.tsx', () => {
  afterEach(() => {
    const root = document.getElementById('root');
    if (root) document.body.removeChild(root);
  });

  it('mounts React app without throwing', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    await act(async () => {
      await expect(import('../main')).resolves.toBeDefined();
    });
    expect(root.childNodes.length).toBeGreaterThan(0);
  });
});

describe('pickRoot', () => {
  it('mounts App when no overlay flag is set', () => {
    render(pickRoot(''));
    expect(screen.queryByTestId('overlay-root')).toBeNull();
  });

  it('mounts App when overlay flag is absent', () => {
    render(pickRoot('?foo=bar'));
    expect(screen.queryByTestId('overlay-root')).toBeNull();
  });

  it('mounts OverlayView when overlay=1 is set', () => {
    render(pickRoot('?overlay=1&path=/tmp/shot.png'));
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-background')).toBeInTheDocument();
  });

  it('mounts OverlayView with empty image path when path param missing', () => {
    render(pickRoot('?overlay=1'));
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
    // No background image when imagePath is empty.
    expect(screen.queryByTestId('overlay-background')).toBeNull();
  });

  it('does not match overlay=0 or other values', () => {
    render(pickRoot('?overlay=0'));
    expect(screen.queryByTestId('overlay-root')).toBeNull();
  });

  it('passes fit=1 through to OverlayView', () => {
    render(pickRoot('?overlay=1&path=/tmp/shot.png&fit=1'));
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
    // Fit mode is just a prop pass-through — we can't inspect props
    // directly; presence of the root is enough for the routing branch.
  });

  it('mounts LongImageEditorView when overlay editor=long is set', () => {
    render(pickRoot('?overlay=1&path=/tmp/long.png&editor=long'));
    expect(screen.getByTestId('long-editor-root')).toBeInTheDocument();
  });

  it('mounts LongShotHudView when longhud=1 is set', () => {
    render(pickRoot('?longhud=1'));
    expect(screen.getByTestId('longhud-root')).toBeInTheDocument();
  });

  it('mounts PinView when pin=1 is set', () => {
    render(pickRoot('?pin=1&path=/tmp/shot.png&label=pin-abc'));
    expect(screen.getByTestId('pin-root')).toBeInTheDocument();
    expect(screen.getByTestId('pin-image')).toBeInTheDocument();
  });

  it('mounts PinView with defaults when path/label missing', () => {
    render(pickRoot('?pin=1'));
    expect(screen.getByTestId('pin-root')).toBeInTheDocument();
    expect(screen.getByTestId('pin-empty')).toBeInTheDocument();
  });

  it('mounts ClipboardHistoryView when clipboard=1 is set', () => {
    render(pickRoot('?clipboard=1'));
    expect(screen.getByTestId('clipboard-root')).toBeInTheDocument();
  });
});
