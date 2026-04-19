import React from 'react';
import App from './App';
import { ClipboardHistoryView } from './view/ClipboardHistoryView';
import { LongImageEditorView } from './view/LongImageEditorView';
import { LongShotHudView } from './view/LongShotHudView';
import { OverlayView } from './view/OverlayView';
import { PinContextMenuView } from './view/PinContextMenuView';
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
    const editor = params.get('editor');
    if (editor === 'long') {
      return <LongImageEditorView imagePath={imagePath} />;
    }
    return <OverlayView imagePath={imagePath} fit={fit} editorKind={editor} />;
  }
  if (params.get('longhud') === '1') {
    return <LongShotHudView />;
  }
  if (params.get('pin') === '1') {
    const imagePath = params.get('path') ?? '';
    const label = params.get('label') ?? '';
    return <PinView imagePath={imagePath} label={label} />;
  }
  if (params.get('pinmenu') === '1') {
    const imagePath = params.get('path') ?? '';
    const label = params.get('label') ?? '';
    const opacity = Number(params.get('opacity') ?? '1');
    return (
      <PinContextMenuView
        imagePath={imagePath}
        label={label}
        opacity={Number.isFinite(opacity) ? opacity : 1}
      />
    );
  }
  if (params.get('clipboard') === '1') {
    return <ClipboardHistoryView />;
  }
  return <App />;
}
