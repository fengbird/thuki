import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearEventHandlers,
  emitTauriEvent,
  invoke,
} from '../../testUtils/mocks/tauri';
import {
  __mockWindow,
  clearWindowEventHandlers,
  emitWindowFocusChanged,
} from '../../testUtils/mocks/tauri-window';
import { PIN_CONTEXT_MENU_UPDATE_EVENT } from '../pin/events';
import { PinContextMenuView } from '../PinContextMenuView';

describe('PinContextMenuView', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
    clearEventHandlers();
    clearWindowEventHandlers();
    __mockWindow.hide.mockClear();
    __mockWindow.onFocusChanged.mockClear();
  });

  it('renders the menu actions', () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    expect(screen.getByTestId('pin-menu-root')).toBeInTheDocument();
    expect(screen.getByTestId('pin-menu-edit')).toBeInTheDocument();
    expect(screen.getByTestId('pin-menu-copy')).toBeInTheDocument();
    expect(screen.getByTestId('pin-menu-close')).toBeInTheDocument();
  });

  it('copy invokes copy_image_to_clipboard and hides the menu', async () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-copy'));
    });
    expect(invoke).toHaveBeenCalledWith('copy_image_to_clipboard', {
      imagePath: '/tmp/shot.png',
    });
    expect(__mockWindow.hide).toHaveBeenCalled();
  });

  it('edit invokes edit_pin_window_from_menu', async () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-edit'));
    });
    expect(invoke).toHaveBeenCalledWith('edit_pin_window_from_menu', {
      label: 'pin-abc',
      imagePath: '/tmp/shot.png',
    });
    expect(__mockWindow.hide).toHaveBeenCalled();
  });

  it('close invokes close_pin_window', async () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-close'));
    });
    expect(invoke).toHaveBeenCalledWith('close_pin_window', {
      label: 'pin-abc',
    });
    expect(__mockWindow.hide).toHaveBeenCalled();
  });

  it('opacity slider updates and sends set_pin_opacity', async () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    await act(async () => {
      fireEvent.change(screen.getByTestId('pin-menu-opacity'), {
        target: { value: '0.55' },
      });
    });
    expect(invoke).toHaveBeenCalledWith('set_pin_opacity', {
      label: 'pin-abc',
      opacity: 0.55,
    });
    expect(screen.getByText('Opacity: 55%')).toBeInTheDocument();
  });

  it('Escape hides the menu window', async () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(__mockWindow.hide).toHaveBeenCalled();
  });

  it('window blur hides the menu window', async () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      emitWindowFocusChanged(false);
    });
    expect(__mockWindow.hide).toHaveBeenCalled();
  });

  it('update event swaps the target pin payload', async () => {
    render(
      <PinContextMenuView
        imagePath="/tmp/shot.png"
        label="pin-abc"
        opacity={0.8}
      />,
    );
    await act(async () => {
      emitTauriEvent(PIN_CONTEXT_MENU_UPDATE_EVENT, {
        imagePath: '/tmp/next.png',
        label: 'pin-next',
        opacity: 0.65,
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-copy'));
    });
    expect(invoke).toHaveBeenCalledWith('copy_image_to_clipboard', {
      imagePath: '/tmp/next.png',
    });
    expect(screen.getByText('Opacity: 65%')).toBeInTheDocument();
  });
});
