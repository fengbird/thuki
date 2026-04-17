import { useCallback, useEffect, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';

/**
 * Screenshot editor window.
 *
 * Phase 1: displays the captured image and offers two actions — copy to
 * clipboard, or close the window. Annotation tools (Phase 2), pin
 * (Phase 3), and AI handoff (Phase 4) land here in later iterations.
 */

export interface EditorViewProps {
  /** Absolute path to the captured image on disk (from query string). */
  imagePath: string;
}

export function EditorView({ imagePath }: EditorViewProps) {
  const [status, setStatus] = useState<{
    kind: 'idle' | 'success' | 'error';
    message: string;
  }>({ kind: 'idle', message: '' });

  const src = imagePath ? convertFileSrc(imagePath) : '';

  const handleCopy = useCallback(async () => {
    if (!imagePath) return;
    try {
      await invoke('copy_image_to_clipboard', { imagePath });
      setStatus({ kind: 'success', message: 'Copied to clipboard' });
    } catch (e) {
      setStatus({
        kind: 'error',
        message: typeof e === 'string' ? e : String(e),
      });
    }
  }, [imagePath]);

  const handleClose = useCallback(async () => {
    try {
      await invoke('close_editor_window');
    } catch {
      // Window may already be closing; ignore.
    }
  }, []);

  // Auto-dismiss success toast after 1.5s.
  useEffect(() => {
    if (status.kind !== 'success') return;
    const timer = setTimeout(
      () => setStatus({ kind: 'idle', message: '' }),
      1500,
    );
    return () => clearTimeout(timer);
  }, [status.kind]);

  // ⌘C shortcut → copy, Esc → close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void handleClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        void handleCopy();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose, handleCopy]);

  return (
    <div
      data-testid="editor-root"
      style={{
        position: 'fixed',
        inset: 0,
        background: '#1c1814',
        color: '#f0f0f2',
        fontFamily: 'Inter, -apple-system, sans-serif',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Toolbar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid rgba(255, 141, 92, 0.15)',
          background: 'rgba(22, 18, 15, 0.98)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: '#ff8d5c' }}>
          Screenshot Editor
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            data-testid="editor-copy"
            onClick={() => void handleCopy()}
            disabled={!imagePath}
            style={primaryButtonStyle}
          >
            Copy
          </button>
          <button
            data-testid="editor-close"
            onClick={() => void handleClose()}
            style={secondaryButtonStyle}
          >
            Close
          </button>
        </div>
      </header>

      {/* Canvas area */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
          background:
            'repeating-conic-gradient(#1a1a1c 0% 25%, #222 0% 50%) 50% / 20px 20px',
        }}
      >
        {imagePath ? (
          <img
            data-testid="editor-image"
            src={src}
            alt="Screenshot"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              boxShadow: '0 6px 32px rgba(0,0,0,0.5)',
              borderRadius: 4,
              objectFit: 'contain',
            }}
          />
        ) : (
          <div
            data-testid="editor-empty"
            style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}
          >
            No image provided.
          </div>
        )}
      </main>

      {/* Status bar */}
      <footer
        style={{
          padding: '6px 16px',
          fontSize: 11,
          color:
            status.kind === 'error'
              ? '#ef4444'
              : status.kind === 'success'
                ? '#22c55e'
                : 'rgba(255,255,255,0.35)',
          borderTop: '1px solid rgba(255, 141, 92, 0.1)',
          background: 'rgba(22, 18, 15, 0.98)',
          textAlign: 'center',
          minHeight: 20,
        }}
        data-testid="editor-status"
      >
        {status.message || '⌘C to copy · Esc to close'}
      </footer>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '5px 14px',
  background: 'linear-gradient(135deg, #ff8d5c 0%, #d45a1e 100%)',
  border: 'none',
  borderRadius: 8,
  color: 'white',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '5px 14px',
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  color: 'rgba(255,255,255,0.6)',
  fontSize: 12,
  cursor: 'pointer',
};
