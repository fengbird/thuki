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
  it('mounts App when no editor flag is set', () => {
    render(pickRoot(''));
    // App does not render the editor root.
    expect(screen.queryByTestId('editor-root')).toBeNull();
  });

  it('mounts App when editor flag is absent', () => {
    render(pickRoot('?foo=bar'));
    expect(screen.queryByTestId('editor-root')).toBeNull();
  });

  it('mounts EditorView when editor=1 is set', () => {
    render(pickRoot('?editor=1&path=/tmp/shot.png'));
    expect(screen.getByTestId('editor-root')).toBeInTheDocument();
    // Phase 2: canvas stage replaces the old img tag.
    expect(screen.getByTestId('mock-stage')).toBeInTheDocument();
  });

  it('mounts EditorView with empty image path when path param missing', () => {
    render(pickRoot('?editor=1'));
    expect(screen.getByTestId('editor-root')).toBeInTheDocument();
    expect(screen.getByTestId('editor-empty')).toBeInTheDocument();
  });

  it('does not match editor=0 or other values', () => {
    render(pickRoot('?editor=0'));
    expect(screen.queryByTestId('editor-root')).toBeNull();
  });
});
