import { useCallback, useEffect, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Pin window — a floating always-on-top screenshot sticker.
 *
 * Mounted by main-root when `?pin=1&path=…&label=…` is present. The window
 * is frameless and transparent; this component renders the image flush with
 * the window edges and forwards left-button drags to the native window
 * drag start API. Esc or right-click menu closes the pin.
 */

export interface PinViewProps {
  imagePath: string;
  label: string;
}

export function PinView({ imagePath, label }: PinViewProps) {
  const [menuOpen, setMenuOpen] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [opacity, setOpacity] = useState(1);

  const src = imagePath ? convertFileSrc(imagePath) : '';

  const handleClose = useCallback(async () => {
    try {
      await invoke('close_pin_window', { label });
    } catch {
      // Window may already be closing.
    }
  }, [label]);

  const handleCopy = useCallback(async () => {
    if (!imagePath) return;
    try {
      await invoke('copy_image_to_clipboard', { imagePath });
    } catch {
      // Swallow — pin shouldn't crash on clipboard failure.
    }
  }, [imagePath]);

  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    try {
      await getCurrentWindow().startDragging();
    } catch {
      // Ignore: drag can fail harmlessly if the user releases mid-flight.
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen({ x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenuOpen(null), []);

  // Close context menu on outside click or Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (menuOpen) closeMenu();
        else void handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, closeMenu, handleClose]);

  return (
    <div
      data-testid="pin-root"
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onClick={() => menuOpen && closeMenu()}
      style={{
        position: 'fixed',
        inset: 0,
        cursor: 'move',
        background: 'transparent',
        overflow: 'hidden',
        borderRadius: 6,
      }}
    >
      {imagePath ? (
        <img
          data-testid="pin-image"
          src={src}
          alt="Pinned screenshot"
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            opacity,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div
          data-testid="pin-empty"
          style={{ color: '#999', padding: 20, textAlign: 'center' }}
        >
          No image.
        </div>
      )}

      {menuOpen && (
        <PinContextMenu
          x={menuOpen.x}
          y={menuOpen.y}
          opacity={opacity}
          onOpacity={setOpacity}
          onCopy={() => {
            void handleCopy();
            closeMenu();
          }}
          onClose={() => {
            void handleClose();
          }}
          onDismiss={closeMenu}
        />
      )}
    </div>
  );
}

interface PinContextMenuProps {
  x: number;
  y: number;
  opacity: number;
  onOpacity: (v: number) => void;
  onCopy: () => void;
  onClose: () => void;
  onDismiss: () => void;
}

function PinContextMenu({
  x,
  y,
  opacity,
  onOpacity,
  onCopy,
  onClose,
  onDismiss,
}: PinContextMenuProps) {
  return (
    <div
      data-testid="pin-context-menu"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        background: 'rgba(28, 24, 20, 0.98)',
        border: '1px solid rgba(255, 141, 92, 0.2)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        padding: 4,
        minWidth: 160,
        color: '#eae1da',
        fontFamily: 'Inter, -apple-system, sans-serif',
        fontSize: 12,
      }}
    >
      <MenuItem testId="pin-menu-copy" onClick={onCopy}>
        Copy image
      </MenuItem>
      <div style={{ padding: '6px 10px' }}>
        <div style={{ marginBottom: 4, color: 'rgba(255,255,255,0.5)' }}>
          Opacity: {Math.round(opacity * 100)}%
        </div>
        <input
          data-testid="pin-menu-opacity"
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
          style={{ width: '100%' }}
        />
      </div>
      <div
        style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: 2 }}
      />
      <MenuItem testId="pin-menu-close" onClick={onClose}>
        Close pin
      </MenuItem>
      <MenuItem testId="pin-menu-dismiss" onClick={onDismiss}>
        Cancel
      </MenuItem>
    </div>
  );
}

function MenuItem({
  testId,
  onClick,
  children,
}: {
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        borderRadius: 4,
      }}
    >
      {children}
    </button>
  );
}
