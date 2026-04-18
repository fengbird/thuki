import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type Konva from 'konva';
import type { Tool } from './editor/types';
import {
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  newAnnotationId,
} from './editor/types';
import { useAnnotations } from './editor/useAnnotations';
import { dataUrlToBase64, exportStageToDataURL } from './editor/exportCanvas';
import { AnnotationStage } from './overlay/AnnotationStage';
import { FloatingToolbar } from './overlay/FloatingToolbar';
import {
  RESIZE_HANDLES,
  computeBadgePosition,
  cursorForHandle,
  imageScaleFor,
  isRectSized,
  moveRect,
  rectFromPoints,
  resizeRect,
  type Point,
  type Rect,
  type ResizeHandle,
} from './overlay/selectionLogic';

/**
 * Xnip-style full-screen overlay.
 *
 * Lifecycle:
 * 1. Opens as a transparent borderless window covering the target display.
 * 2. The user drags to select a region — the backing screenshot is dimmed
 *    outside the selection so the chosen area pops.
 * 3. Once a selection is committed, 8 resize handles + a move zone appear
 *    (in "select" tool mode). The floating toolbar lets the user annotate
 *    or act on the selection.
 * 4. Actions: Copy, Pin, Ask AI, OCR, or Close.
 */

export interface OverlayViewProps {
  /** Absolute path to the captured image on disk (from query string). */
  imagePath: string;
  /**
   * When true, skip the drag-to-select phase and auto-commit the full
   * image as the selection. Used by the "edit pin" flow — the user
   * already chose their region when they pinned, so we go straight into
   * annotation.
   */
  fit?: boolean;
}

interface DragState {
  start: Point;
  current: Point;
}

interface MoveState {
  original: Rect;
  anchor: Point;
}

interface ResizeState {
  original: Rect;
  anchor: Point;
  handle: ResizeHandle;
}

export function OverlayView({ imagePath, fit = false }: OverlayViewProps) {
  const src = imagePath ? convertFileSrc(imagePath) : '';
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT_SIZE);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [moving, setMoving] = useState<MoveState | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);
  const [textEditor, setTextEditor] = useState<{
    x: number;
    y: number;
    value: string;
  } | null>(null);
  const [status, setStatus] = useState<{
    kind: 'idle' | 'success' | 'error';
    message: string;
  }>({ kind: 'idle', message: '' });
  const [longShotBusy, setLongShotBusy] = useState(false);
  const stageRef = useRef<Konva.Stage | null>(null);
  const { annotations, canUndo, canRedo, add, clear, undo, redo } =
    useAnnotations();

  // Load the background screenshot so we know its natural pixel dimensions.
  useEffect(() => {
    if (!src) return;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    const onLoad = () => setImage(img);
    img.addEventListener('load', onLoad);
    return () => img.removeEventListener('load', onLoad);
  }, [src]);

  useEffect(() => {
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Fit mode: auto-commit the full viewport as the selection so the user
  // skips drag-to-select and goes straight to annotation. Used by the
  // "edit pin" flow.
  const fitApplied = useRef(false);
  useEffect(() => {
    if (!fit || !image || fitApplied.current) return;
    fitApplied.current = true;
    setSelection({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
  }, [fit, image, viewport]);

  const handleClose = useCallback(async () => {
    try {
      await invoke('close_overlay_window');
    } catch {
      // Window already closing; ignore.
    }
  }, []);

  const resetSelection = useCallback(() => {
    setSelection(null);
    setMoving(null);
    setResizing(null);
    setTextEditor(null);
    clear();
    setTool('select');
    setStatus({ kind: 'idle', message: '' });
  }, [clear]);

  // Commit the in-progress text, or cancel if empty.
  const commitText = useCallback(() => {
    if (!textEditor) return;
    const trimmed = textEditor.value.trim();
    if (trimmed.length > 0) {
      add({
        id: newAnnotationId(),
        type: 'text',
        x: textEditor.x,
        y: textEditor.y,
        text: trimmed,
        fontSize,
        stroke: color,
      });
    }
    setTextEditor(null);
  }, [textEditor, add, fontSize, color]);

  // Keyboard: Esc cancels selection (first press) or closes overlay (again).
  // When the text editor is open, Esc dismisses the editor first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (textEditor) {
          setTextEditor(null);
          return;
        }
        if (selection) {
          resetSelection();
        } else {
          void handleClose();
        }
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, textEditor, handleClose, resetSelection, redo, undo]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (selection) return;
      const p = { x: e.clientX, y: e.clientY };
      setDragging({ start: p, current: p });
    },
    [selection],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const p = { x: e.clientX, y: e.clientY };
      if (resizing) {
        setSelection(
          resizeRect(
            resizing.original,
            resizing.handle,
            p.x - resizing.anchor.x,
            p.y - resizing.anchor.y,
          ),
        );
        return;
      }
      if (moving) {
        setSelection(
          moveRect(
            moving.original,
            p.x - moving.anchor.x,
            p.y - moving.anchor.y,
          ),
        );
        return;
      }
      if (dragging) {
        setDragging({ start: dragging.start, current: p });
      }
    },
    [dragging, moving, resizing],
  );

  const onMouseUp = useCallback(() => {
    if (resizing) {
      setResizing(null);
      return;
    }
    if (moving) {
      setMoving(null);
      return;
    }
    if (!dragging) return;
    const rect = rectFromPoints(dragging.start, dragging.current);
    setDragging(null);
    if (isRectSized(rect)) {
      setSelection(rect);
    }
  }, [dragging, moving, resizing]);

  const startResize = useCallback(
    (handle: ResizeHandle, e: React.MouseEvent<HTMLDivElement>) => {
      /* v8 ignore next -- handles only render when selection is set */
      if (!selection) return;
      e.stopPropagation();
      e.preventDefault();
      setResizing({
        original: selection,
        anchor: { x: e.clientX, y: e.clientY },
        handle,
      });
    },
    [selection],
  );

  const startMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      /* v8 ignore next -- move zone only renders when selection is set */
      if (!selection) return;
      e.stopPropagation();
      e.preventDefault();
      setMoving({
        original: selection,
        anchor: { x: e.clientX, y: e.clientY },
      });
    },
    [selection],
  );

  // Fit mode (edit-pin flow): the selection is locked to the full viewport,
  // so dragging should move the whole window on the desktop — not resize or
  // translate the selection rect. Mirrors the pin-drag behavior.
  const startWindowDrag = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      try {
        await getCurrentWindow().startDragging();
      } catch {
        // Swallow — drag can fail harmlessly if the user releases mid-flight.
      }
    },
    [],
  );

  const dragRect = dragging
    ? rectFromPoints(dragging.start, dragging.current)
    : null;
  const liveRect = selection ?? dragRect;

  const exportSelection = useCallback((): string | null => {
    const dataUrl = exportStageToDataURL(stageRef.current);
    /* v8 ignore next -- dataUrl is non-null whenever the stage has mounted */
    return dataUrl ? dataUrlToBase64(dataUrl) : null;
  }, []);

  const handleCopy = useCallback(async () => {
    const b64 = exportSelection();
    /* v8 ignore next -- stage is always ready once the toolbar is visible */
    if (!b64) return;
    try {
      await invoke('copy_base64_png_to_clipboard', { base64Data: b64 });
      setStatus({ kind: 'success', message: 'Copied to clipboard' });
      window.setTimeout(() => {
        void handleClose();
      }, 400);
    } catch (e) {
      setStatus({
        kind: 'error',
        message: typeof e === 'string' ? e : String(e),
      });
    }
  }, [exportSelection, handleClose]);

  const handlePin = useCallback(async () => {
    const b64 = exportSelection();
    /* v8 ignore next -- stage is always ready once the toolbar is visible */
    if (!b64 || !selection) return;
    try {
      // Convert window-local selection coords to screen coords. In the
      // normal fullscreen flow the window is at screen (0, 0) so this is a
      // no-op, but in fit mode (edit-pin flow) the window sits at the
      // previous pin's location — and the user may have dragged it — so
      // we have to read the current window position.
      const win = getCurrentWindow();
      const [phys, sf] = await Promise.all([
        win.innerPosition(),
        win.scaleFactor(),
      ]);
      const winX = phys.x / sf;
      const winY = phys.y / sf;
      await invoke('pin_base64_png', {
        base64Data: b64,
        x: winX + selection.x,
        y: winY + selection.y,
        width: selection.width,
        height: selection.height,
      });
      void handleClose();
    } catch (e) {
      setStatus({
        kind: 'error',
        message: typeof e === 'string' ? e : String(e),
      });
    }
  }, [exportSelection, handleClose, selection]);

  const sendToChat = useCallback(
    async (prompt: string | undefined, autoSubmit: boolean) => {
      const b64 = exportSelection();
      /* v8 ignore next -- stage is always ready once the toolbar is visible */
      if (!b64) return;
      try {
        await invoke('send_image_to_chat', {
          base64Data: b64,
          prompt,
          autoSubmit,
        });
        void handleClose();
      } catch (e) {
        setStatus({
          kind: 'error',
          message: typeof e === 'string' ? e : String(e),
        });
      }
    },
    [exportSelection, handleClose],
  );

  const handleAskAi = useCallback(
    () => void sendToChat(undefined, false),
    [sendToChat],
  );
  const handleOcr = useCallback(
    () => void sendToChat('请提取图中所有文字，原样输出。', true),
    [sendToChat],
  );

  // Xnip-style manual long screenshot. Clicking "Long" hides the overlay,
  // opens a small HUD window (Save / Cancel + live frame counter), and
  // starts a backend polling loop. The user scrolls the target app
  // themselves; each time the selection's content changes the backend
  // appends a frame. When the user clicks Save in the HUD, the backend
  // stitches + copies the PNG to the clipboard in the backend, then emits
  // `thuki://long-capture-done` so we can show success and close the overlay.
  const handleLongShot = useCallback(async () => {
    /* v8 ignore next -- button only renders when selection is set and is
       disabled while busy; these guards are defensive. */
    if (!selection || longShotBusy) return;
    setLongShotBusy(true);
    setStatus({ kind: 'success', message: 'Scroll to capture…' });
    try {
      const win = getCurrentWindow();
      const [phys, sf] = await Promise.all([
        win.innerPosition(),
        win.scaleFactor(),
      ]);
      const winX = phys.x / sf;
      const winY = phys.y / sf;
      await invoke('start_manual_long_capture', {
        x: winX + selection.x,
        y: winY + selection.y,
        width: selection.width,
        height: selection.height,
      });
    } catch (e) {
      setStatus({
        kind: 'error',
        message: typeof e === 'string' ? e : String(e),
      });
      setLongShotBusy(false);
    }
  }, [selection, longShotBusy]);

  // Listen for the HUD-driven save / cancel events so the overlay can
  // react: show success on save, reset busy state on cancel. The live
  // preview lives in the HUD window, so
  // we don't need a progress listener here.
  useEffect(() => {
    let unlistenDone: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    void (async () => {
      unlistenDone = await listen<string>(
        'thuki://long-capture-done',
        async () => {
          setStatus({ kind: 'success', message: 'Long screenshot copied' });
          window.setTimeout(() => {
            void handleClose();
          }, 500);
          setLongShotBusy(false);
        },
      );
      unlistenCancelled = await listen('thuki://long-capture-cancelled', () => {
        setLongShotBusy(false);
        setStatus({ kind: 'idle', message: '' });
      });
      unlistenError = await listen<string>(
        'thuki://long-capture-error',
        (e) => {
          setLongShotBusy(false);
          setStatus({ kind: 'error', message: e.payload });
        },
      );
    })();
    return () => {
      unlistenDone?.();
      unlistenCancelled?.();
      unlistenError?.();
    };
  }, [handleClose]);

  const scale = image ? imageScaleFor(image.naturalWidth, viewport.width) : 1;
  const isAdjusting = !!(moving || resizing);

  return (
    <div
      data-testid="overlay-root"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        userSelect: 'none',
        cursor: selection ? 'default' : 'crosshair',
      }}
    >
      {src && (
        <img
          data-testid="overlay-background"
          src={src}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      )}

      <DimMask rect={liveRect} viewport={viewport} />

      {selection && image && (
        <div
          data-testid="overlay-stage-host"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseMove={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            // In text mode the text-zone covers this host and handles its
            // own dblclick (word-select in the textarea), so this branch
            // only fires for non-text tools. Copies the current composite
            // and closes the overlay — matches Xnip's double-click-to-copy
            // behavior.
            e.stopPropagation();
            void handleCopy();
          }}
          style={{
            position: 'absolute',
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        >
          <AnnotationStage
            image={image}
            selection={selection}
            scale={scale}
            tool={tool}
            color={color}
            fontSize={fontSize}
            annotations={annotations}
            onCommit={add}
            onStageReady={(s) => {
              stageRef.current = s;
            }}
            onTextPlace={(p) => {
              commitText();
              setTextEditor({ x: p.x, y: p.y, value: '' });
            }}
          />
        </div>
      )}

      {/* Move zone — only active in select mode; sits above the stage so
          drag-to-move takes precedence over annotation drawing. In fit
          mode (edit-pin flow) the selection is locked to the whole
          viewport, so this zone drags the native window around the
          desktop instead of translating the selection rect. */}
      {selection && tool === 'select' && (
        <div
          data-testid="overlay-move-zone"
          onMouseDown={fit ? (e) => void startWindowDrag(e) : startMove}
          onDoubleClick={(e) => {
            // Shortcut: double-click in select mode copies the composite
            // to the clipboard and closes the overlay. Same behavior as
            // the "Copy" button.
            e.stopPropagation();
            void handleCopy();
          }}
          style={{
            position: 'absolute',
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
            cursor: fit ? 'grab' : moving ? 'grabbing' : 'grab',
            background: 'transparent',
          }}
        />
      )}

      {/* Text placement zone — only active in text mode. Handles clicks at
          the DOM level instead of going through Konva's hit-test, which can
          miss clicks on empty canvas areas inside a transparent WebView
          panel. Mirrors the move-zone pattern used for select. */}
      {selection && tool === 'text' && (
        <div
          data-testid="overlay-text-zone"
          onMouseDown={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            commitText();
            setTextEditor({ x, y, value: '' });
          }}
          style={{
            position: 'absolute',
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
            cursor: 'text',
            background: 'transparent',
          }}
        />
      )}

      {/* Border + 8 resize handles — always above the stage so the border
          stays visible after commit. Handles hide during resize and in
          fit mode (the selection is locked to the whole viewport, resizing
          it would be meaningless). */}
      {liveRect && (
        <SelectionFrame
          rect={liveRect}
          showHandles={!!selection && !isAdjusting && !fit}
          onResizeStart={startResize}
        />
      )}

      {liveRect && <DimensionBadge rect={liveRect} />}

      {selection && (
        <FloatingToolbar
          selection={selection}
          viewport={viewport}
          tool={tool}
          onToolChange={(t) => {
            commitText();
            setTool(t);
          }}
          color={color}
          onColorChange={setColor}
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          onClear={clear}
          onCopy={() => void handleCopy()}
          onPin={() => void handlePin()}
          onAskAi={handleAskAi}
          onOcr={handleOcr}
          onClose={() => void handleClose()}
          onLongShot={() => void handleLongShot()}
          longShotBusy={longShotBusy}
          hideLongShot={fit}
        />
      )}

      {textEditor && selection && (
        <TextEditor
          x={selection.x + textEditor.x}
          y={selection.y + textEditor.y}
          color={color}
          fontSize={fontSize}
          value={textEditor.value}
          onChange={(v) => setTextEditor({ ...textEditor, value: v })}
          onCommit={commitText}
          onCancel={() => setTextEditor(null)}
        />
      )}

      <HintBar selection={selection} status={status} />
    </div>
  );
}

/**
 * Four-div dim mask forming an inverse cutout around the selection rect.
 * When no selection exists, dims the entire viewport.
 */
function DimMask({
  rect,
  viewport,
}: {
  rect: Rect | null;
  viewport: { width: number; height: number };
}) {
  const color = 'rgba(0, 0, 0, 0.55)';
  if (!rect) {
    return (
      <div
        data-testid="overlay-dim-full"
        style={{
          position: 'absolute',
          inset: 0,
          background: color,
          pointerEvents: 'none',
        }}
      />
    );
  }
  const top = rect.y;
  const bottom = viewport.height - (rect.y + rect.height);
  const left = rect.x;
  const right = viewport.width - (rect.x + rect.width);
  const common: React.CSSProperties = {
    position: 'absolute',
    background: color,
    pointerEvents: 'none',
  };
  return (
    <>
      <div
        data-testid="overlay-dim-top"
        style={{ ...common, left: 0, top: 0, width: '100%', height: top }}
      />
      <div
        data-testid="overlay-dim-bottom"
        style={{
          ...common,
          left: 0,
          bottom: 0,
          width: '100%',
          height: bottom,
        }}
      />
      <div
        data-testid="overlay-dim-left"
        style={{
          ...common,
          left: 0,
          top,
          width: left,
          height: rect.height,
        }}
      />
      <div
        data-testid="overlay-dim-right"
        style={{
          ...common,
          right: 0,
          top,
          width: right,
          height: rect.height,
        }}
      />
    </>
  );
}

const HANDLE_SIZE = 10;
const HANDLE_INSET = HANDLE_SIZE / 2;

function SelectionFrame({
  rect,
  showHandles,
  onResizeStart,
}: {
  rect: Rect;
  showHandles: boolean;
  onResizeStart: (
    handle: ResizeHandle,
    e: React.MouseEvent<HTMLDivElement>,
  ) => void;
}) {
  return (
    <>
      <div
        data-testid="overlay-selection-frame"
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          border: '2px solid #3b82f6',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }}
      />
      {showHandles &&
        RESIZE_HANDLES.map((h) => {
          const pos = handleOffset(rect, h);
          return (
            <div
              key={h}
              data-testid={`overlay-handle-${h}`}
              onMouseDown={(e) => onResizeStart(h, e)}
              style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                background: '#3b82f6',
                border: '1px solid white',
                borderRadius: 2,
                cursor: cursorForHandle(h),
                boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
              }}
            />
          );
        })}
    </>
  );
}

function handleOffset(rect: Rect, handle: ResizeHandle): Point {
  const midX = rect.x + rect.width / 2 - HANDLE_INSET;
  const midY = rect.y + rect.height / 2 - HANDLE_INSET;
  const leftX = rect.x - HANDLE_INSET;
  const rightX = rect.x + rect.width - HANDLE_INSET;
  const topY = rect.y - HANDLE_INSET;
  const bottomY = rect.y + rect.height - HANDLE_INSET;
  switch (handle) {
    case 'n':
      return { x: midX, y: topY };
    case 's':
      return { x: midX, y: bottomY };
    case 'e':
      return { x: rightX, y: midY };
    case 'w':
      return { x: leftX, y: midY };
    case 'ne':
      return { x: rightX, y: topY };
    case 'nw':
      return { x: leftX, y: topY };
    case 'se':
      return { x: rightX, y: bottomY };
    case 'sw':
      return { x: leftX, y: bottomY };
  }
}

/**
 * Inline text editor shown when the user clicks the overlay in `text`
 * mode. A bare `<textarea>` positioned at the click point, auto-sized to
 * the content, styled to match the final Konva `Text` render so there's
 * no visual jump at commit time.
 */
function TextEditor({
  x,
  y,
  color,
  fontSize,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  color: string;
  fontSize: number;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // onBlur is only honored AFTER this ref flips to true. Rationale: the
  // NSPanel transitions to its key-window state after the click that spawned
  // the editor, which can temporarily steal focus. That fires a spurious
  // blur event in the same tick, which (with commit-on-blur) would
  // instantly unmount the empty textarea and make it look like typing is
  // broken. Wait one frame + a short grace before allowing blur to commit.
  const blurArmed = useRef(false);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    // Re-focus once more on the next frame in case the panel's activation
    // pulled focus away between mount and paint.
    const raf = requestAnimationFrame(() => el?.focus());
    const t = window.setTimeout(() => {
      blurArmed.current = true;
    }, 150);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, []);
  // Auto-size the textarea to its content so it grows horizontally with
  // each keystroke and only wraps when the user inserts a manual newline
  // via Shift+Enter (white-space: pre keeps each visual line on one line).
  useEffect(() => {
    const el = ref.current;
    /* v8 ignore next -- ref is always attached by the time this effect runs */
    if (!el) return;
    // Reset so shrinks are possible, then measure the scroll dimensions.
    el.style.width = 'auto';
    el.style.height = 'auto';
    el.style.width = `${el.scrollWidth}px`;
    el.style.height = `${el.scrollHeight}px`;
  }, [value, fontSize]);
  return (
    <textarea
      data-testid="overlay-text-editor"
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Enter commits; Shift+Enter inserts a newline.
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        if (blurArmed.current) onCommit();
      }}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        // One-character default width — the useEffect above grows it to
        // fit the actual content on every keystroke.
        minWidth: '1ch',
        minHeight: fontSize * 1.4,
        padding: 2,
        color,
        fontSize,
        fontFamily: 'Inter, -apple-system, sans-serif',
        lineHeight: 1.2,
        // Transparent — let the underlying screenshot show through so the
        // committed Konva Text renders in the same place visually.
        background: 'transparent',
        border: `1px dashed ${color}`,
        borderRadius: 2,
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        // Preserve the user's manual newlines but never auto-wrap on the
        // viewport edge — width grows instead.
        whiteSpace: 'pre',
        caretColor: color,
        zIndex: 100,
      }}
    />
  );
}

function DimensionBadge({ rect }: { rect: Rect }) {
  const { x, y } = computeBadgePosition(rect);
  return (
    <div
      data-testid="overlay-dimension-badge"
      style={{
        position: 'absolute',
        left: x,
        top: y,
        padding: '2px 8px',
        background: '#3b82f6',
        color: 'white',
        fontSize: 12,
        fontWeight: 500,
        borderRadius: 4,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {Math.round(rect.width)} × {Math.round(rect.height)}
    </div>
  );
}

function HintBar({
  selection,
  status,
}: {
  selection: Rect | null;
  status: { kind: 'idle' | 'success' | 'error'; message: string };
}) {
  const isError = status.kind === 'error';
  const isSuccess = status.kind === 'success';
  const text =
    status.message || (selection ? null : 'Drag to select · Esc to exit');
  if (!text) return null;
  return (
    <div
      data-testid="overlay-hint"
      style={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '6px 14px',
        borderRadius: 8,
        background: 'rgba(22, 18, 15, 0.92)',
        border: `1px solid ${
          isError
            ? 'rgba(239, 68, 68, 0.4)'
            : isSuccess
              ? 'rgba(34, 197, 94, 0.4)'
              : 'rgba(255, 141, 92, 0.2)'
        }`,
        color: isError
          ? '#ef4444'
          : isSuccess
            ? '#22c55e'
            : 'rgba(255,255,255,0.75)',
        fontSize: 12,
        pointerEvents: 'none',
      }}
    >
      {text}
    </div>
  );
}
