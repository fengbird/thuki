import React from 'react';
import App from './App';
import { EditorView } from './view/EditorView';

/**
 * Routes between the main chat app and the screenshot editor based on a
 * URL flag injected by the Rust `open_editor_window` command. The editor
 * window navigates to `index.html?editor=1&path=…`, so we check for the
 * `editor` query param and mount the corresponding root.
 *
 * Kept in its own module so tests can import it without triggering the
 * `createRoot` side-effect in `main.tsx`.
 */
export function pickRoot(search: string): React.ReactElement {
  const params = new URLSearchParams(search);
  if (params.get('editor') === '1') {
    const imagePath = params.get('path') ?? '';
    return <EditorView imagePath={imagePath} />;
  }
  return <App />;
}
