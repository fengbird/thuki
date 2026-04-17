import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Tool } from '../editor/types';
import { COLOR_PRESETS, FONT_SIZE_PRESETS } from '../editor/types';
import type { Rect } from './selectionLogic';
import { computeToolbarPosition } from './selectionLogic';

/**
 * Xnip-style floating toolbar that sits below (or above) the selection.
 * Stateless — the parent owns tool state, color, font size, and history.
 *
 * Color and font-size live inside click-to-open dropdowns so the toolbar
 * stays compact regardless of how many presets are available.
 */

interface FloatingToolbarProps {
  selection: Rect;
  viewport: { width: number; height: number };
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  color: string;
  onColorChange: (color: string) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPin: () => void;
  onAskAi: () => void;
  onOcr: () => void;
  onClose: () => void;
  onLongShot: () => void;
  longShotBusy?: boolean;
  /** Hide the "Long" button in edit-pin flow — scroll-capture on an
   *  already-stitched image makes no sense. */
  hideLongShot?: boolean;
}

const TOOLS: { key: Tool; label: string; hint: string }[] = [
  { key: 'select', label: '↖', hint: 'Select' },
  { key: 'rect', label: '▭', hint: 'Rectangle' },
  { key: 'arrow', label: '→', hint: 'Arrow' },
  { key: 'pen', label: '✎', hint: 'Pen' },
  { key: 'mosaic', label: '▦', hint: 'Mosaic' },
  { key: 'text', label: 'T', hint: 'Text' },
];

const TOOLBAR_WIDTH = 720;
const TOOLBAR_ROW_HEIGHT = 44;
const TOOLBAR_SECOND_ROW_HEIGHT = 40;

export function FloatingToolbar({
  selection,
  viewport,
  tool,
  onToolChange,
  color,
  onColorChange,
  fontSize,
  onFontSizeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onCopy,
  onPin,
  onAskAi,
  onOcr,
  onClose,
  onLongShot,
  longShotBusy = false,
  hideLongShot = false,
}: FloatingToolbarProps) {
  const showColor = tool !== 'select' && tool !== 'mosaic';
  const showFontSize = tool === 'text';
  // Text tool adds both color + font-size pickers → moves them to a
  // dedicated second row so row 1 stays compact and consistent. Other
  // color-using tools (rect / arrow / pen) keep the single-dropdown color
  // inline on row 1.
  const useSecondRow = showFontSize;
  const toolbarHeight = useSecondRow
    ? TOOLBAR_ROW_HEIGHT + TOOLBAR_SECOND_ROW_HEIGHT
    : TOOLBAR_ROW_HEIGHT;

  const pos = computeToolbarPosition(
    selection,
    { width: TOOLBAR_WIDTH, height: toolbarHeight },
    viewport,
  );

  return (
    <div
      data-testid="overlay-toolbar"
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        width: TOOLBAR_WIDTH,
        height: toolbarHeight,
        display: 'flex',
        flexDirection: 'column',
        padding: '0 10px',
        borderRadius: 10,
        background: 'rgba(22, 18, 15, 0.96)',
        border: '1px solid rgba(255, 141, 92, 0.2)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
        color: '#f0f0f2',
        fontSize: 13,
      }}
    >
      <div
        data-testid="overlay-toolbar-row-1"
        style={{
          height: TOOLBAR_ROW_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {TOOLS.map((t) => (
          <button
            key={t.key}
            data-testid={`overlay-tool-${t.key}`}
            aria-label={t.hint}
            title={t.hint}
            onClick={() => onToolChange(t.key)}
            style={toolButtonStyle(tool === t.key)}
          >
            {t.label}
          </button>
        ))}

        {/* Inline color picker only when we don't need a second row (rect /
          arrow / pen). Text mode shows color alongside font-size on row 2. */}
        {showColor && !useSecondRow && (
          <ColorDropdown value={color} onChange={onColorChange} />
        )}

        <div style={dividerStyle} />
        <button
          data-testid="overlay-undo"
          aria-label="Undo"
          title="Undo"
          disabled={!canUndo}
          onClick={onUndo}
          style={iconButtonStyle(canUndo)}
        >
          ⟲
        </button>
        <button
          data-testid="overlay-redo"
          aria-label="Redo"
          title="Redo"
          disabled={!canRedo}
          onClick={onRedo}
          style={iconButtonStyle(canRedo)}
        >
          ⟳
        </button>
        <button
          data-testid="overlay-clear"
          aria-label="Clear annotations"
          title="Clear annotations"
          onClick={onClear}
          style={iconButtonStyle(true)}
        >
          ✕
        </button>
        <div style={dividerStyle} />
        <button
          data-testid="overlay-ocr"
          onClick={onOcr}
          style={actionButtonStyle()}
          title="Extract text from image"
        >
          OCR
        </button>
        <button
          data-testid="overlay-ask-ai"
          onClick={onAskAi}
          style={actionButtonStyle()}
          title="Send to AI chat"
        >
          Ask AI
        </button>
        {!hideLongShot && (
          <button
            data-testid="overlay-long"
            onClick={onLongShot}
            disabled={longShotBusy}
            style={{
              ...actionButtonStyle(),
              opacity: longShotBusy ? 0.5 : 1,
              cursor: longShotBusy ? 'not-allowed' : 'pointer',
            }}
            title="Scroll-capture the area beneath the selection and stitch"
          >
            {longShotBusy ? 'Capturing…' : 'Long'}
          </button>
        )}
        <button
          data-testid="overlay-pin"
          onClick={onPin}
          style={actionButtonStyle()}
          title="Pin to desktop"
        >
          Pin
        </button>
        <button
          data-testid="overlay-copy"
          onClick={onCopy}
          style={primaryButtonStyle}
          title="Copy to clipboard"
        >
          Copy
        </button>
        <button
          data-testid="overlay-close"
          onClick={onClose}
          style={iconButtonStyle(true)}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {useSecondRow && (
        <div
          data-testid="overlay-toolbar-row-2"
          style={{
            height: TOOLBAR_SECOND_ROW_HEIGHT,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <span
            style={{
              color: 'rgba(255,255,255,0.45)',
              fontSize: 11,
              marginRight: 2,
            }}
          >
            Color
          </span>
          <ColorDropdown value={color} onChange={onColorChange} />
          <div style={dividerStyle} />
          <span
            style={{
              color: 'rgba(255,255,255,0.45)',
              fontSize: 11,
              marginRight: 2,
            }}
          >
            Size
          </span>
          <FontSizeDropdown value={fontSize} onChange={onFontSizeChange} />
        </div>
      )}
    </div>
  );
}

/**
 * Compact color trigger + popover. Click the swatch to open the palette;
 * click a preset to select + close; click outside to dismiss.
 */
function ColorDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <Dropdown
      testId="overlay-color"
      trigger={(open, toggle) => (
        <button
          data-testid="overlay-color-trigger"
          aria-label="Stroke color"
          title="Stroke color"
          onClick={toggle}
          style={colorTriggerStyle(value, open)}
        />
      )}
    >
      {(close) => (
        <div
          data-testid="overlay-color-popover"
          style={popoverStyle({ minWidth: 168 })}
        >
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              data-testid={`overlay-color-${c}`}
              aria-label={`color ${c}`}
              title={c}
              onClick={() => {
                onChange(c);
                close();
              }}
              style={colorSwatchStyle(c, value === c)}
            />
          ))}
        </div>
      )}
    </Dropdown>
  );
}

/** Compact font-size trigger + popover, same pattern as ColorDropdown. */
function FontSizeDropdown({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <Dropdown
      testId="overlay-font-size"
      trigger={(open, toggle) => (
        <button
          data-testid="overlay-font-size-trigger"
          aria-label="Font size"
          title="Font size"
          onClick={toggle}
          style={fontTriggerStyle(open)}
        >
          A {value}
        </button>
      )}
    >
      {(close) => (
        <div
          data-testid="overlay-font-size-popover"
          style={popoverStyle({ minWidth: 72 })}
        >
          {FONT_SIZE_PRESETS.map((s) => (
            <button
              key={s}
              data-testid={`overlay-font-size-${s}`}
              aria-label={`font size ${s}`}
              onClick={() => {
                onChange(s);
                close();
              }}
              style={fontSizeItemStyle(value === s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </Dropdown>
  );
}

/**
 * Reusable click-to-open dropdown. Closes on outside mousedown (captured on
 * the document so popover dismissal works even when the trigger sits inside
 * another stop-propagation zone like the toolbar wrapper).
 */
function Dropdown({
  testId,
  trigger,
  children,
}: {
  testId: string;
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () =>
      document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open]);

  return (
    <div
      ref={ref}
      data-testid={`${testId}-dropdown`}
      style={{ position: 'relative', display: 'inline-flex' }}
    >
      {trigger(open, () => setOpen((o) => !o))}
      {open && children(() => setOpen(false))}
    </div>
  );
}

const toolButtonStyle = (active: boolean): React.CSSProperties => ({
  width: 30,
  height: 28,
  fontSize: 14,
  lineHeight: 1,
  border: active
    ? '1px solid rgba(255,141,92,0.7)'
    : '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: active ? 'rgba(255,141,92,0.18)' : 'rgba(255,255,255,0.04)',
  color: active ? '#ff8d5c' : 'rgba(255,255,255,0.75)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

const iconButtonStyle = (enabled: boolean): React.CSSProperties => ({
  width: 30,
  height: 28,
  fontSize: 14,
  lineHeight: 1,
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.04)',
  color: enabled ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.25)',
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.5,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

const actionButtonStyle = (): React.CSSProperties => ({
  padding: '4px 10px',
  height: 28,
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  color: 'rgba(255,255,255,0.8)',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});

const primaryButtonStyle: React.CSSProperties = {
  padding: '4px 14px',
  height: 28,
  background: 'linear-gradient(135deg, #ff8d5c 0%, #d45a1e 100%)',
  border: 'none',
  borderRadius: 6,
  color: 'white',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 20,
  background: 'rgba(255,255,255,0.12)',
  margin: '0 4px',
};

const colorTriggerStyle = (
  color: string,
  open: boolean,
): React.CSSProperties => ({
  width: 26,
  height: 22,
  border: open ? '2px solid #ff8d5c' : '1px solid rgba(255,255,255,0.2)',
  borderRadius: 6,
  background: color,
  padding: 0,
  cursor: 'pointer',
  boxSizing: 'border-box',
});

const fontTriggerStyle = (open: boolean): React.CSSProperties => ({
  padding: '0 10px',
  height: 22,
  border: open
    ? '1px solid rgba(255,141,92,0.7)'
    : '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: open ? 'rgba(255,141,92,0.18)' : 'rgba(255,255,255,0.04)',
  color: open ? '#ff8d5c' : 'rgba(255,255,255,0.75)',
  fontSize: 12,
  cursor: 'pointer',
});

const popoverStyle = (
  opts: { minWidth?: number } = {},
): React.CSSProperties => ({
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 6,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  padding: 8,
  borderRadius: 8,
  background: 'rgba(22, 18, 15, 0.98)',
  border: '1px solid rgba(255, 141, 92, 0.2)',
  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
  minWidth: opts.minWidth,
  zIndex: 20,
});

const colorSwatchStyle = (
  color: string,
  active: boolean,
): React.CSSProperties => ({
  width: 20,
  height: 20,
  border: active ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)',
  borderRadius: '50%',
  background: color,
  cursor: 'pointer',
  padding: 0,
  boxSizing: 'border-box',
});

const fontSizeItemStyle = (active: boolean): React.CSSProperties => ({
  padding: '4px 8px',
  height: 24,
  minWidth: 32,
  border: active
    ? '1px solid rgba(255,141,92,0.7)'
    : '1px solid rgba(255,255,255,0.1)',
  borderRadius: 4,
  background: active ? 'rgba(255,141,92,0.18)' : 'rgba(255,255,255,0.04)',
  color: active ? '#ff8d5c' : 'rgba(255,255,255,0.75)',
  fontSize: 12,
  cursor: 'pointer',
});
