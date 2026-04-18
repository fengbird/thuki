import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
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
import type { Rect } from './overlay/selectionLogic';

const CANVAS_SIDE_LIMIT = 8192;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.12;
const SCROLL_TOP = 84;
const SCROLL_BOTTOM = 30;
const SCROLL_SIDE = 24;

function clampZoom(zoom: number, maxZoom: number): number {
  const floor = Math.min(MIN_ZOOM, maxZoom);
  return Math.max(floor, Math.min(maxZoom, Number(zoom.toFixed(3))));
}

function nextZoom(zoom: number, direction: 'in' | 'out', maxZoom: number) {
  const factor = direction === 'in' ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP);
  return clampZoom(zoom * factor, maxZoom);
}

export interface LongImageEditorViewProps {
  imagePath: string;
}

export function LongImageEditorView({ imagePath }: LongImageEditorViewProps) {
  const src = imagePath ? convertFileSrc(imagePath) : '';
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [status, setStatus] = useState<{
    kind: 'idle' | 'success' | 'error';
    message: string;
  }>({ kind: 'idle', message: '' });
  const [textEditor, setTextEditor] = useState<{
    x: number;
    y: number;
    value: string;
  } | null>(null);
  const [zoomMode, setZoomMode] = useState<'fit' | 'manual'>('fit');
  const [manualZoom, setManualZoom] = useState(1);
  const stageRef = useRef<Konva.Stage | null>(null);
  const { annotations, canUndo, canRedo, add, clear, undo, redo } =
    useAnnotations();

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

  const scrollWidth = Math.max(320, viewport.width - SCROLL_SIDE * 2);
  const maxZoom = image
    ? Math.min(
        MAX_ZOOM,
        CANVAS_SIDE_LIMIT / Math.max(image.naturalWidth, image.naturalHeight),
      )
    : MAX_ZOOM;
  const fitZoom = image
    ? clampZoom(Math.min(1, scrollWidth / image.naturalWidth), maxZoom)
    : 1;
  const zoom = zoomMode === 'fit' ? fitZoom : clampZoom(manualZoom, maxZoom);
  const displayWidth = image
    ? Math.max(1, Math.round(image.naturalWidth * zoom))
    : 0;
  const displayHeight = image
    ? Math.max(1, Math.round(image.naturalHeight * zoom))
    : 0;
  const stageSelection: Rect = {
    x: 0,
    y: 0,
    width: displayWidth,
    height: displayHeight,
  };
  const imageScale =
    image && displayWidth > 0 ? image.naturalWidth / displayWidth : 1;
  const exportPixelRatio =
    image && displayWidth > 0 ? image.naturalWidth / displayWidth : 1;

  const handleClose = useCallback(async () => {
    try {
      await invoke('close_overlay_window');
    } catch {
      // Window may already be closing.
    }
  }, []);

  const handleWindowDrag = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      await getCurrentWindow().startDragging();
    } catch {
      // Ignore — drag can fail harmlessly if the user releases mid-flight.
    }
  }, []);

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
  }, [add, color, fontSize, textEditor]);

  const exportImage = useCallback((): string | null => {
    const dataUrl = exportStageToDataURL(stageRef.current, exportPixelRatio);
    return dataUrl ? dataUrlToBase64(dataUrl) : null;
  }, [exportPixelRatio]);

  const handleCopy = useCallback(async () => {
    const base64Data = exportImage();
    if (!base64Data) return;
    try {
      await invoke('copy_base64_png_to_clipboard', { base64Data });
      setStatus({ kind: 'success', message: 'Copied to clipboard' });
      window.setTimeout(() => {
        void handleClose();
      }, 400);
    } catch (error) {
      setStatus({
        kind: 'error',
        message: typeof error === 'string' ? error : String(error),
      });
    }
  }, [exportImage, handleClose]);

  const handlePin = useCallback(async () => {
    const base64Data = exportImage();
    if (!base64Data || !image) return;
    try {
      const win = getCurrentWindow();
      const [phys, sf] = await Promise.all([
        win.innerPosition(),
        win.scaleFactor(),
      ]);
      const maxPinWidth = Math.max(360, Math.min(displayWidth, scrollWidth));
      const maxPinHeight = Math.round(
        maxPinWidth * (image.naturalHeight / image.naturalWidth),
      );
      await invoke('pin_base64_png', {
        base64Data,
        x: phys.x / sf + 28,
        y: phys.y / sf + 80,
        width: maxPinWidth,
        height: maxPinHeight,
      });
      void handleClose();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: typeof error === 'string' ? error : String(error),
      });
    }
  }, [displayWidth, exportImage, handleClose, image, scrollWidth]);

  const sendToChat = useCallback(
    async (prompt: string | undefined, autoSubmit: boolean) => {
      const base64Data = exportImage();
      if (!base64Data) return;
      try {
        await invoke('send_image_to_chat', {
          base64Data,
          prompt,
          autoSubmit,
        });
        void handleClose();
      } catch (error) {
        setStatus({
          kind: 'error',
          message: typeof error === 'string' ? error : String(error),
        });
      }
    },
    [exportImage, handleClose],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (textEditor) {
          setTextEditor(null);
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
        return;
      }
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoomMode('manual');
        setManualZoom((prev) =>
          nextZoom(zoomMode === 'fit' ? fitZoom : prev, 'in', maxZoom),
        );
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        setZoomMode('manual');
        setManualZoom((prev) =>
          nextZoom(zoomMode === 'fit' ? fitZoom : prev, 'out', maxZoom),
        );
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        setZoomMode('fit');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitZoom, handleClose, maxZoom, redo, textEditor, undo, zoomMode]);

  const toolbarAnchor: Rect = {
    x: viewport.width / 2,
    y: 0,
    width: 0,
    height: 0,
  };

  const defaultMessage = image
    ? 'Long image editor. Scroll to inspect detail, use Cmd/Ctrl + scroll or the zoom controls to adjust scale.'
    : 'Loading long screenshot…';
  const zoomLabel = `${Math.round(zoom * 100)}%`;

  return (
    <div
      data-testid="long-editor-root"
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        userSelect: 'none',
        background:
          'radial-gradient(circle at top, rgba(255,141,92,0.18), transparent 24%), #100d0b',
        color: '#f7f4f1',
        fontFamily: 'Inter, -apple-system, sans-serif',
      }}
    >
      <div
        data-testid="long-editor-drag-region"
        data-tauri-drag-region
        onMouseDown={(e) => void handleWindowDrag(e)}
        style={{
          position: 'absolute',
          left: 18,
          top: 14,
          width: 244,
          minHeight: 54,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          justifyContent: 'center',
          padding: '10px 14px',
          borderRadius: 14,
          border: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.035)',
          backdropFilter: 'blur(10px)',
          cursor: 'grab',
          zIndex: 12,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: '#ff8d5c' }}>
          Long screenshot editor
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>
          {image
            ? `${image.naturalWidth} × ${image.naturalHeight}`
            : 'Preparing image'}
        </span>
      </div>

      <div
        data-testid="long-editor-zoom-controls"
        style={{
          position: 'absolute',
          right: 24,
          top: 18,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          zIndex: 12,
        }}
      >
        <button
          data-testid="long-editor-zoom-out"
          onClick={() => {
            setZoomMode('manual');
            setManualZoom((prev) =>
              nextZoom(zoomMode === 'fit' ? fitZoom : prev, 'out', maxZoom),
            );
          }}
          style={zoomButtonStyle}
        >
          -
        </button>
        <button
          data-testid="long-editor-zoom-fit"
          onClick={() => setZoomMode('fit')}
          style={zoomMode === 'fit' ? activeZoomButtonStyle : zoomButtonStyle}
        >
          Fit
        </button>
        <button
          data-testid="long-editor-zoom-100"
          onClick={() => {
            setZoomMode('manual');
            setManualZoom(clampZoom(1, maxZoom));
          }}
          style={zoomButtonStyle}
        >
          100%
        </button>
        <button
          data-testid="long-editor-zoom-in"
          onClick={() => {
            setZoomMode('manual');
            setManualZoom((prev) =>
              nextZoom(zoomMode === 'fit' ? fitZoom : prev, 'in', maxZoom),
            );
          }}
          style={zoomButtonStyle}
        >
          +
        </button>
        <span
          data-testid="long-editor-zoom-label"
          style={{
            minWidth: 52,
            textAlign: 'right',
            fontSize: 12,
            color: 'rgba(255,255,255,0.72)',
          }}
        >
          {zoomLabel}
        </span>
      </div>

      <div
        data-testid="long-editor-scroll"
        onWheel={(e) => {
          if (!(e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          setZoomMode('manual');
          setManualZoom((prev) =>
            nextZoom(
              zoomMode === 'fit' ? fitZoom : prev,
              e.deltaY < 0 ? 'in' : 'out',
              maxZoom,
            ),
          );
        }}
        style={{
          position: 'absolute',
          left: SCROLL_SIDE,
          right: SCROLL_SIDE,
          top: SCROLL_TOP,
          bottom: SCROLL_BOTTOM,
          overflow: 'auto',
          borderRadius: 18,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(12, 10, 9, 0.88)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
          zIndex: 1,
        }}
      >
        {image ? (
          <div
            style={{
              minWidth: '100%',
              minHeight: '100%',
              display: 'flex',
              justifyContent:
                displayWidth < scrollWidth ? 'center' : 'flex-start',
              padding: 28,
              boxSizing: 'border-box',
            }}
          >
            <div
              data-testid="long-editor-stage-wrap"
              style={{
                position: 'relative',
                width: displayWidth,
                height: displayHeight,
                flex: '0 0 auto',
                background: '#171310',
                boxShadow: '0 16px 48px rgba(0, 0, 0, 0.42)',
              }}
            >
              <div
                data-testid="long-editor-stage-host"
                onMouseDown={(e) => e.stopPropagation()}
                onMouseMove={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  inset: 0,
                }}
              >
                <AnnotationStage
                  image={image}
                  selection={stageSelection}
                  scale={imageScale}
                  tool={tool}
                  color={color}
                  fontSize={fontSize}
                  annotations={annotations}
                  onCommit={add}
                  onStageReady={(stage) => {
                    stageRef.current = stage;
                  }}
                />
              </div>

              {tool === 'text' && (
                <div
                  data-testid="long-editor-text-zone"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    commitText();
                    setTextEditor({
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                      value: '',
                    });
                  }}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    cursor: 'text',
                    background: 'transparent',
                  }}
                />
              )}

              {textEditor && (
                <LongTextEditor
                  x={textEditor.x}
                  y={textEditor.y}
                  color={color}
                  fontSize={fontSize}
                  value={textEditor.value}
                  onChange={(value) => setTextEditor({ ...textEditor, value })}
                  onCommit={commitText}
                  onCancel={() => setTextEditor(null)}
                />
              )}
            </div>
          </div>
        ) : (
          <div
            data-testid="long-editor-empty"
            style={{
              minHeight: '100%',
              display: 'grid',
              placeItems: 'center',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 13,
            }}
          >
            Preparing long screenshot…
          </div>
        )}
      </div>

      <FloatingToolbar
        selection={toolbarAnchor}
        viewport={viewport}
        tool={tool}
        onToolChange={(nextTool) => {
          commitText();
          setTool(nextTool);
        }}
        color={color}
        onColorChange={setColor}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onClear={() => {
          commitText();
          clear();
        }}
        onCopy={() => void handleCopy()}
        onPin={() => void handlePin()}
        onAskAi={() => void sendToChat(undefined, false)}
        onOcr={() => void sendToChat('请提取图中所有文字，原样输出。', true)}
        onClose={() => void handleClose()}
        onLongShot={() => {}}
        hideLongShot
      />

      <div
        data-testid="long-editor-hint"
        style={{
          position: 'absolute',
          left: 24,
          right: 24,
          bottom: 8,
          zIndex: 12,
          fontSize: 11,
          lineHeight: 1.4,
          color:
            status.kind === 'error'
              ? '#ff9b8b'
              : status.kind === 'success'
                ? '#ffcfba'
                : 'rgba(255,255,255,0.58)',
        }}
      >
        {status.message || defaultMessage}
      </div>
    </div>
  );
}

function LongTextEditor({
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
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const blurArmed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    el?.focus();
    const raf = requestAnimationFrame(() => el?.focus());
    const t = window.setTimeout(() => {
      blurArmed.current = true;
    }, 150);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = 'auto';
    el.style.height = 'auto';
    el.style.width = `${el.scrollWidth}px`;
    el.style.height = `${el.scrollHeight}px`;
  }, [value, fontSize]);

  return (
    <textarea
      data-testid="long-editor-text-editor"
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
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
        minWidth: '1ch',
        minHeight: fontSize * 1.4,
        padding: 2,
        color,
        fontSize,
        fontFamily: 'Inter, -apple-system, sans-serif',
        lineHeight: 1.2,
        background: 'transparent',
        border: `1px dashed ${color}`,
        borderRadius: 2,
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre',
        caretColor: color,
        zIndex: 20,
      }}
    />
  );
}

const zoomButtonStyle: CSSProperties = {
  height: 28,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.06)',
  color: 'rgba(255,255,255,0.84)',
  fontSize: 12,
  cursor: 'pointer',
};

const activeZoomButtonStyle: CSSProperties = {
  ...zoomButtonStyle,
  border: '1px solid rgba(255,141,92,0.4)',
  background: 'rgba(255,141,92,0.16)',
  color: '#ffd4c1',
};
