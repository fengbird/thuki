import type { Tool } from './types';

/**
 * Editor toolbar: tool picker + undo/redo/clear actions.
 *
 * Stateless and presentational — the parent owns tool state and history.
 */

interface ToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPin: () => void;
  onClose: () => void;
}

const TOOLS: { key: Tool; label: string; hint: string }[] = [
  { key: 'select', label: '↖', hint: 'Select' },
  { key: 'rect', label: '▭', hint: 'Rectangle' },
  { key: 'arrow', label: '→', hint: 'Arrow' },
  { key: 'pen', label: '✎', hint: 'Pen' },
];

export function Toolbar({
  tool,
  onToolChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onCopy,
  onPin,
  onClose,
}: ToolbarProps) {
  return (
    <header
      data-testid="editor-toolbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        gap: 8,
        borderBottom: '1px solid rgba(255, 141, 92, 0.15)',
        background: 'rgba(22, 18, 15, 0.98)',
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        {TOOLS.map((t) => (
          <button
            key={t.key}
            data-testid={`tool-${t.key}`}
            aria-label={t.hint}
            title={t.hint}
            onClick={() => onToolChange(t.key)}
            style={toolButtonStyle(tool === t.key)}
          >
            {t.label}
          </button>
        ))}
        <div style={divStyle} />
        <button
          data-testid="editor-undo"
          aria-label="Undo"
          title="Undo"
          disabled={!canUndo}
          onClick={onUndo}
          style={iconButtonStyle(canUndo)}
        >
          ⟲
        </button>
        <button
          data-testid="editor-redo"
          aria-label="Redo"
          title="Redo"
          disabled={!canRedo}
          onClick={onRedo}
          style={iconButtonStyle(canRedo)}
        >
          ⟳
        </button>
        <button
          data-testid="editor-clear"
          aria-label="Clear all"
          title="Clear all"
          onClick={onClear}
          style={iconButtonStyle(true)}
        >
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          data-testid="editor-pin"
          onClick={onPin}
          style={secondaryButtonStyle}
          title="Pin to desktop"
        >
          Pin
        </button>
        <button
          data-testid="editor-copy"
          onClick={onCopy}
          style={primaryButtonStyle}
        >
          Copy
        </button>
        <button
          data-testid="editor-close"
          onClick={onClose}
          style={secondaryButtonStyle}
        >
          Close
        </button>
      </div>
    </header>
  );
}

const toolButtonStyle = (active: boolean): React.CSSProperties => ({
  width: 30,
  height: 26,
  fontSize: 14,
  lineHeight: 1,
  border: active
    ? '1px solid rgba(255,141,92,0.7)'
    : '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: active ? 'rgba(255,141,92,0.18)' : 'rgba(255,255,255,0.04)',
  color: active ? '#ff8d5c' : 'rgba(255,255,255,0.7)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

const iconButtonStyle = (enabled: boolean): React.CSSProperties => ({
  width: 30,
  height: 26,
  fontSize: 14,
  lineHeight: 1,
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.04)',
  color: enabled ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)',
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.5,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

const divStyle: React.CSSProperties = {
  width: 1,
  height: 18,
  background: 'rgba(255,255,255,0.12)',
  margin: '0 4px',
  alignSelf: 'center',
};

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
