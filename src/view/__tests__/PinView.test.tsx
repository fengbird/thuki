import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { PinView } from '../PinView';
import { invoke } from '../../testUtils/mocks/tauri';
import { __mockWindow } from '../../testUtils/mocks/tauri-window';

describe('PinView', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
    __mockWindow.startDragging.mockClear();
  });

  it('renders the image when path is provided', () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    expect(screen.getByTestId('pin-root')).toBeInTheDocument();
    expect(screen.getByTestId('pin-image')).toBeInTheDocument();
  });

  it('renders empty state when imagePath is blank', () => {
    render(<PinView imagePath="" label="pin-abc" />);
    expect(screen.getByTestId('pin-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('pin-image')).toBeNull();
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

  it('startDragging failure is swallowed', async () => {
    __mockWindow.startDragging.mockRejectedValueOnce('drag failed');
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('pin-root'), { button: 0 });
    });
    // No assertion needed — test passes by not throwing.
  });

  it('right-click opens context menu', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'), {
        clientX: 100,
        clientY: 150,
      });
    });
    expect(screen.getByTestId('pin-context-menu')).toBeInTheDocument();
    expect(screen.getByTestId('pin-menu-copy')).toBeInTheDocument();
    expect(screen.getByTestId('pin-menu-close')).toBeInTheDocument();
  });

  it('Copy menu item invokes copy_image_to_clipboard and closes menu', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-copy'));
    });
    expect(invoke).toHaveBeenCalledWith('copy_image_to_clipboard', {
      imagePath: '/tmp/shot.png',
    });
    expect(screen.queryByTestId('pin-context-menu')).toBeNull();
  });

  it('Copy menu is a no-op when imagePath is blank', async () => {
    render(<PinView imagePath="" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-copy'));
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'copy_image_to_clipboard',
      expect.anything(),
    );
  });

  it('Copy swallows errors', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'copy_image_to_clipboard') throw 'clipboard err';
    });
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-copy'));
    });
    // No rethrow — passes by reaching this line.
  });

  it('Close menu item invokes close_pin_window with label', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-close'));
    });
    expect(invoke).toHaveBeenCalledWith('close_pin_window', {
      label: 'pin-abc',
    });
  });

  it('Close swallows errors', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'close_pin_window') throw 'window gone';
    });
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-close'));
    });
    // No rethrow.
  });

  it('Cancel menu item just closes the menu', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-menu-dismiss'));
    });
    expect(screen.queryByTestId('pin-context-menu')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('opacity slider updates the image opacity', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    const slider = screen.getByTestId('pin-menu-opacity') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '0.5' } });
    });
    const img = screen.getByTestId('pin-image') as HTMLImageElement;
    expect(img.style.opacity).toBe('0.5');
  });

  it('Esc with menu closed triggers close_pin_window', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).toHaveBeenCalledWith('close_pin_window', {
      label: 'pin-abc',
    });
  });

  it('Esc with menu open closes only the menu, not the window', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('pin-context-menu')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      'close_pin_window',
      expect.anything(),
    );
  });

  it('non-Escape keys do nothing', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' });
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('mousedown on the menu does not trigger window drag', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    __mockWindow.startDragging.mockClear();
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('pin-context-menu'), {
        button: 0,
      });
    });
    expect(__mockWindow.startDragging).not.toHaveBeenCalled();
  });

  it('clicking outside menu dismisses it', async () => {
    render(<PinView imagePath="/tmp/shot.png" label="pin-abc" />);
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('pin-root'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pin-root'));
    });
    expect(screen.queryByTestId('pin-context-menu')).toBeNull();
  });

  it('unregisters keydown listener on unmount', async () => {
    const { unmount } = render(
      <PinView imagePath="/tmp/shot.png" label="pin-abc" />,
    );
    unmount();
    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
