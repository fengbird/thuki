import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';
import { computeZoomedSize } from './pin/zoomLogic';
import { PIN_SET_OPACITY_EVENT } from './pin/events';

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
  const [opacity, setOpacity] = useState(1);

  const src = imagePath ? convertFileSrc(imagePath) : '';

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const bind = async () => {
      unlisten = await listen<{ label: string; opacity: number }>(
        PIN_SET_OPACITY_EVENT,
        ({ payload }) => {
          if (payload.label === label) {
            setOpacity(payload.opacity);
          }
        },
      );
    };
    void bind();
    return () => {
      unlisten?.();
    };
  }, [label]);

  const handleClose = useCallback(async () => {
    if (imagePath) {
      try {
        await invoke('remove_image_command', { path: imagePath });
      } catch {
        // Best-effort cleanup only — close should still proceed.
      }
    }
    try {
      await invoke('close_pin_window', { label });
    } catch {
      // Window may already be closing.
    }
  }, [imagePath, label]);

  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    try {
      await getCurrentWindow().startDragging();
    } catch {
      // Ignore: drag can fail harmlessly if the user releases mid-flight.
    }
  }, []);

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      if (!imagePath) {
        return;
      }
      try {
        const win = getCurrentWindow();
        const [position, sf] = await Promise.all([
          win.innerPosition(),
          win.scaleFactor(),
        ]);
        await invoke('open_pin_context_menu', {
          label,
          imagePath,
          opacity,
          pinX: position.x / sf,
          pinY: position.y / sf,
          clickX: e.clientX,
          clickY: e.clientY,
        });
      } catch {
        // Ignore — the menu is auxiliary, not critical.
      }
    },
    [imagePath, label, opacity],
  );

  // Scroll to zoom: resize the native window proportionally, so the pin
  // image scales up/down in place. Aspect ratio is preserved by
  // `computeZoomedSize`.
  const handleWheel = useCallback(async (e: React.WheelEvent) => {
    if (e.deltaY === 0) return;
    const win = getCurrentWindow();
    try {
      const [phys, sf] = await Promise.all([
        win.innerSize(),
        win.scaleFactor(),
      ]);
      const logical = {
        width: phys.width / sf,
        height: phys.height / sf,
      };
      const next = computeZoomedSize(logical, e.deltaY);
      if (next.width === logical.width && next.height === logical.height) {
        return;
      }
      await win.setSize(new LogicalSize(next.width, next.height));
    } catch {
      // Ignore — window may be closing.
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  return (
    <div
      data-testid="pin-root"
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onWheel={(e) => void handleWheel(e)}
      style={{
        position: 'fixed',
        inset: 0,
        cursor: 'move',
        background: 'transparent',
        overflow: 'hidden',
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
            borderRadius: 6,
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
    </div>
  );
}
