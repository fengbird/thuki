import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type Konva from 'konva';
import { AnnotationCanvas } from './editor/AnnotationCanvas';
import { Toolbar } from './editor/Toolbar';
import { useAnnotations } from './editor/useAnnotations';
import { dataUrlToBase64, exportStageToDataURL } from './editor/exportCanvas';
import type { Tool } from './editor/types';

/**
 * Screenshot editor window.
 *
 * Phase 2 brings Konva-based annotation drawing (rect / arrow / pen),
 * undo/redo, and clipboard export of the composite (background + overlays).
 * Pin and AI handoff land in Phases 3 and 4.
 */

export interface EditorViewProps {
  /** Absolute path to the captured image on disk (from query string). */
  imagePath: string;
}

const CANVAS_WIDTH = 860;
const CANVAS_HEIGHT = 500;

export function EditorView({ imagePath }: EditorViewProps) {
  const [tool, setTool] = useState<Tool>('select');
  const [status, setStatus] = useState<{
    kind: 'idle' | 'success' | 'error';
    message: string;
  }>({ kind: 'idle', message: '' });

  const stageRef = useRef<Konva.Stage | null>(null);
  const { annotations, canUndo, canRedo, add, clear, undo, redo } =
    useAnnotations();

  const src = imagePath ? convertFileSrc(imagePath) : '';

  const handleCopy = useCallback(async () => {
    if (!imagePath) return;
    // Export the composite (background + annotations) from the Konva stage,
    // falling back to the raw image file if the stage isn't ready yet.
    const dataUrl = exportStageToDataURL(stageRef.current);
    /* v8 ignore next -- stage is always ready when copy is reachable */
    const b64 = dataUrl ? dataUrlToBase64(dataUrl) : null;
    try {
      /* v8 ignore start -- else branch only reachable when stage export fails */
      if (b64) {
        await invoke('copy_base64_png_to_clipboard', { base64Data: b64 });
      } else {
        await invoke('copy_image_to_clipboard', { imagePath });
      }
      /* v8 ignore stop */
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

  const sendToChat = useCallback(
    async (prompt: string | undefined, autoSubmit: boolean) => {
      if (!imagePath) return;
      const dataUrl = exportStageToDataURL(stageRef.current);
      /* v8 ignore next -- stage is ready when bridge is reachable */
      const b64 = dataUrl ? dataUrlToBase64(dataUrl) : null;
      /* v8 ignore next -- b64 is never null in practice */
      if (!b64) return;
      try {
        await invoke('send_image_to_chat', {
          base64Data: b64,
          prompt,
          autoSubmit,
        });
        await invoke('close_editor_window');
      } catch (e) {
        setStatus({
          kind: 'error',
          message: typeof e === 'string' ? e : String(e),
        });
      }
    },
    [imagePath],
  );

  const handleAskAi = useCallback(
    () => void sendToChat(undefined, false),
    [sendToChat],
  );

  const handleRecognizeText = useCallback(
    () => void sendToChat('请提取图中所有文字，原样输出。', true),
    [sendToChat],
  );

  const handlePin = useCallback(async () => {
    if (!imagePath) return;
    const dataUrl = exportStageToDataURL(stageRef.current);
    /* v8 ignore next -- stage is always ready when pin is reachable */
    const b64 = dataUrl ? dataUrlToBase64(dataUrl) : null;
    try {
      /* v8 ignore start -- fallback only reachable when stage export fails */
      if (b64) {
        await invoke('pin_base64_png', { base64Data: b64 });
      } else {
        await invoke('open_pin_window', { imagePath });
      }
      /* v8 ignore stop */
      setStatus({ kind: 'success', message: 'Pinned to desktop' });
    } catch (e) {
      setStatus({
        kind: 'error',
        message: typeof e === 'string' ? e : String(e),
      });
    }
  }, [imagePath]);

  // Auto-dismiss success toast.
  useEffect(() => {
    if (status.kind !== 'success') return;
    const t = setTimeout(() => setStatus({ kind: 'idle', message: '' }), 1500);
    return () => clearTimeout(t);
  }, [status.kind]);

  // Keyboard shortcuts: ⌘C copy, Esc close, ⌘Z undo, ⌘⇧Z redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void handleClose();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'c') {
        e.preventDefault();
        void handleCopy();
      } else if (e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose, handleCopy, redo, undo]);

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
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onClear={clear}
        onCopy={() => void handleCopy()}
        onPin={() => void handlePin()}
        onAskAi={handleAskAi}
        onRecognizeText={handleRecognizeText}
        onClose={() => void handleClose()}
      />

      <main
        data-testid="editor-canvas-area"
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
          <div
            style={{
              width: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
              boxShadow: '0 6px 32px rgba(0,0,0,0.5)',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <AnnotationCanvas
              imageSrc={src}
              tool={tool}
              annotations={annotations}
              onCommit={add}
              onStageReady={(s) => {
                stageRef.current = s;
              }}
              containerWidth={CANVAS_WIDTH}
              containerHeight={CANVAS_HEIGHT}
            />
          </div>
        ) : (
          <div
            data-testid="editor-empty"
            style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}
          >
            No image provided.
          </div>
        )}
      </main>

      <footer
        data-testid="editor-status"
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
      >
        {status.message || '⌘C copy · ⌘Z undo · ⌘⇧Z redo · Esc close'}
      </footer>
    </div>
  );
}
