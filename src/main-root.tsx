import React from 'react';
import App from './App';
import { LongImageEditorView } from './view/LongImageEditorView';
import { LongShotHudView } from './view/LongShotHudView';
import { OverlayView } from './view/OverlayView';
import { PinView } from './view/PinView';

/**
 * Routes between the main chat app, the screenshot overlay, and pin windows
 * based on URL flags injected by the Rust window-builder commands. Each
 * window loads `index.html?<flag>=1&…` and is routed to the matching
 * React root by this helper.
 *
 * Kept in its own module so tests can import it without triggering the
 * `createRoot` side-effect in `main.tsx`.
 */
export function pickRoot(search: string): React.ReactElement {
  const params = new URLSearchParams(search);
  if (params.get('overlay') === '1') {
    const imagePath = params.get('path') ?? '';
    const fit = params.get('fit') === '1';
    if (params.get('editor') === 'long') {
      return <LongImageEditorView imagePath={imagePath} />;
    }
    return <OverlayView imagePath={imagePath} fit={fit} />;
  }
  if (params.get('longhud') === '1') {
    return <LongShotHudView />;
  }
  if (params.get('pin') === '1') {
    const imagePath = params.get('path') ?? '';
    const label = params.get('label') ?? '';
    return <PinView imagePath={imagePath} label={label} />;
  }
  return <App />;
}
