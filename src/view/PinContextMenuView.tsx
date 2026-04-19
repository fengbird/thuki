import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PIN_CONTEXT_MENU_UPDATE_EVENT } from './pin/events';

interface PinContextMenuViewProps {
  label: string;
  imagePath: string;
  opacity: number;
}

interface PinContextMenuState {
  label: string;
  imagePath: string;
  opacity: number;
}

export function PinContextMenuView({
  label,
  imagePath,
  opacity,
}: PinContextMenuViewProps) {
  const [menu, setMenu] = useState<PinContextMenuState>({
    label,
    imagePath,
    opacity,
  });

  const hideMenu = useCallback(async () => {
    try {
      await getCurrentWindow().hide();
    } catch {
      // Ignore — the menu may already be hidden.
    }
  }, []);

  useEffect(() => {
    setMenu({ label, imagePath, opacity });
  }, [imagePath, label, opacity]);

  useEffect(() => {
    let disposed = false;
    let unlistenUpdate: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    const bind = async () => {
      unlistenUpdate = await listen<PinContextMenuState>(
        PIN_CONTEXT_MENU_UPDATE_EVENT,
        ({ payload }) => {
          if (!disposed) {
            setMenu(payload);
          }
        },
      );
      unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload }) => {
        if (!payload) {
          void hideMenu();
        }
      });
    };

    void bind();
    return () => {
      disposed = true;
      unlistenUpdate?.();
      unlistenFocus?.();
    };
  }, [hideMenu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void hideMenu();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hideMenu]);

  const handleCopy = useCallback(async () => {
    if (!menu.imagePath) return;
    try {
      await invoke('copy_image_to_clipboard', { imagePath: menu.imagePath });
    } finally {
      void hideMenu();
    }
  }, [hideMenu, menu.imagePath]);

  const handleEdit = useCallback(async () => {
    if (!menu.imagePath || !menu.label) return;
    try {
      await invoke('edit_pin_window_from_menu', {
        label: menu.label,
        imagePath: menu.imagePath,
      });
    } finally {
      void hideMenu();
    }
  }, [hideMenu, menu.imagePath, menu.label]);

  const handleClosePin = useCallback(async () => {
    if (!menu.label) return;
    try {
      await invoke('close_pin_window', { label: menu.label });
    } finally {
      void hideMenu();
    }
  }, [hideMenu, menu.label]);

  const handleOpacity = useCallback(
    async (nextOpacity: number) => {
      setMenu((current) => ({ ...current, opacity: nextOpacity }));
      if (!menu.label) return;
      try {
        await invoke('set_pin_opacity', {
          label: menu.label,
          opacity: nextOpacity,
        });
      } catch {
        // Ignore — pin may already be gone.
      }
    },
    [menu.label],
  );

  return (
    <div
      data-testid="pin-menu-root"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'transparent',
        padding: 4,
      }}
    >
      <div
        data-testid="pin-context-menu"
        style={{
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
        <MenuItem testId="pin-menu-edit" onClick={() => void handleEdit()}>
          Edit…
        </MenuItem>
        <MenuItem testId="pin-menu-copy" onClick={() => void handleCopy()}>
          Copy image
        </MenuItem>
        <div style={{ padding: '6px 10px' }}>
          <div style={{ marginBottom: 4, color: 'rgba(255,255,255,0.5)' }}>
            Opacity: {Math.round(menu.opacity * 100)}%
          </div>
          <input
            data-testid="pin-menu-opacity"
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={menu.opacity}
            onChange={(e) => void handleOpacity(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
        <div
          style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: 2 }}
        />
        <MenuItem testId="pin-menu-close" onClick={() => void handleClosePin()}>
          Close pin
        </MenuItem>
        <MenuItem testId="pin-menu-dismiss" onClick={() => void hideMenu()}>
          Cancel
        </MenuItem>
      </div>
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
