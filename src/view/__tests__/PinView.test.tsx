import { render, screen, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  invoke,
  emitTauriEvent,
  clearEventHandlers,
} from '../../testUtils/mocks/tauri';
import {
  __mockWindow,
  clearWindowEventHandlers,
  PhysicalPosition,
  PhysicalSize,
} from '../../testUtils/mocks/tauri-window';
import { PIN_SET_OPACITY_EVENT } from '../pin/events';
import { PinView } from '../PinView';

describe('PinView', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
    clearEventHandlers();
    clearWindowEventHandlers();
    __mockWindow.startDragging.mockClear();
    __mockWindow.setSize.mockClear();
    __mockWindow.hide.mockClear();
    __mockWindow.onFocusChanged.mockClear();
    __mockWindow.innerSize.mockReset();
    __mockWindow.innerSize.mockResolvedValue(new PhysicalSize(420, 300));
    __mockWindow.innerPosition.mockReset();
    __mockWindow.innerPosition.mockResolvedValue(new PhysicalPosition(100, 80));
    __mockWindow.scaleFactor.mockReset();
    __mockWindow.scaleFactor.mockResolvedValue(1);
  });

  it('renders the image when path is provided', () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    expect(screen.getByTestId('pin-root')).toBeInTheDocument();
    expect(screen.getByTestId('pin-image')).toBeInTheDocument();
  });

  it('renders empty state when imagePath is blank', () => {
    render(<PinView imagePath="" label="pin-abc" />);
    expect(screen.getByTestId('pin-empty')).toBeInTheDocument();
  });

  it('left mousedown triggers native window drag', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('pin-root'), { button: 0 });
    });
    expect(__mockWindow.startDragging).toHaveBeenCalledOnce();
  });

  it('right mousedown does not trigger window drag', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('pin-root'), { button: 2 });
    });
    expect(__mockWindow.startDragging).not.toHaveBeenCalled();
  });

  it('right-click opens the separate pin context menu window', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'), {
        clientX: 40,
        clientY: 50,
      });
    });
    expect(invoke).toHaveBeenCalledWith('open_pin_context_menu', {
      label: 'pin-abc',
      imagePath: '/tmp/shot.png',
      opacity: 1,
      pinX: 100,
      pinY: 80,
      clickX: 40,
      clickY: 50,
    });
  });

  it('does not open the context menu when imagePath is blank', async () => {
    render(<PinView imagePath="" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'), {
        clientX: 10,
        clientY: 20,
      });
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'open_pin_context_menu',
      expect.anything(),
    );
  });

  it('applies opacity updates emitted for the same pin label', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      emitTauriEvent(PIN_SET_OPACITY_EVENT, {
        label: 'pin-abc',
        opacity: 0.45,
      });
    });
    expect(
      (screen.getByTestId('pin-image') as HTMLImageElement).style.opacity,
    ).toBe('0.45');
  });

  it('ignores opacity updates for other pin labels', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      emitTauriEvent(PIN_SET_OPACITY_EVENT, {
        label: 'pin-other',
        opacity: 0.45,
      });
    });
    expect(
      (screen.getByTestId('pin-image') as HTMLImageElement).style.opacity,
    ).toBe('1');
  });

  it('Esc closes the pin window', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).toHaveBeenCalledWith('close_pin_window', {
      label: 'pin-abc',
    });
    expect(invoke).toHaveBeenCalledWith('remove_image_command', {
      path: '/tmp/shot.png',
    });
  });

  it('scroll up resizes the window larger while preserving aspect', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.wheel(screen.getByTestId('pin-root'), { deltaY: -120 });
    });
    expect(__mockWindow.setSize).toHaveBeenCalledOnce();
    expect(__mockWindow.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 462, height: 330 }),
    );
  });

  it('scroll down resizes the window smaller', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.wheel(screen.getByTestId('pin-root'), { deltaY: 120 });
    });
    expect(__mockWindow.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 382, height: 273 }),
    );
  });

  it('wheel no-ops when innerSize lookup fails', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    __mockWindow.setSize.mockClear();
    __mockWindow.innerSize.mockRejectedValue('window closed');
    await act(async () => {
      fireEvent.wheel(screen.getByTestId('pin-root'), { deltaY: -120 });
    });
    expect(__mockWindow.setSize).not.toHaveBeenCalled();
  });
});
