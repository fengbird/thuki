import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Toolbar } from '../Toolbar';

const defaultProps = {
  tool: 'select' as const,
  onToolChange: vi.fn(),
  canUndo: false,
  canRedo: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onClear: vi.fn(),
  onCopy: vi.fn(),
  onClose: vi.fn(),
};

describe('Toolbar', () => {
  it('renders all tool buttons and actions', () => {
    render(<Toolbar {...defaultProps} />);
    expect(screen.getByTestId('tool-select')).toBeInTheDocument();
    expect(screen.getByTestId('tool-rect')).toBeInTheDocument();
    expect(screen.getByTestId('tool-arrow')).toBeInTheDocument();
    expect(screen.getByTestId('tool-pen')).toBeInTheDocument();
    expect(screen.getByTestId('editor-undo')).toBeInTheDocument();
    expect(screen.getByTestId('editor-redo')).toBeInTheDocument();
    expect(screen.getByTestId('editor-clear')).toBeInTheDocument();
    expect(screen.getByTestId('editor-copy')).toBeInTheDocument();
    expect(screen.getByTestId('editor-close')).toBeInTheDocument();
  });

  it('clicking a tool button calls onToolChange', () => {
    const onToolChange = vi.fn();
    render(<Toolbar {...defaultProps} onToolChange={onToolChange} />);
    fireEvent.click(screen.getByTestId('tool-rect'));
    expect(onToolChange).toHaveBeenCalledWith('rect');
  });

  it('undo button is disabled when canUndo is false', () => {
    render(<Toolbar {...defaultProps} canUndo={false} />);
    const btn = screen.getByTestId('editor-undo') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('undo button is enabled when canUndo is true', () => {
    const onUndo = vi.fn();
    render(<Toolbar {...defaultProps} canUndo={true} onUndo={onUndo} />);
    const btn = screen.getByTestId('editor-undo') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onUndo).toHaveBeenCalled();
  });

  it('redo button mirrors canRedo', () => {
    const onRedo = vi.fn();
    const { rerender } = render(
      <Toolbar {...defaultProps} canRedo={false} onRedo={onRedo} />,
    );
    expect(
      (screen.getByTestId('editor-redo') as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<Toolbar {...defaultProps} canRedo={true} onRedo={onRedo} />);
    fireEvent.click(screen.getByTestId('editor-redo'));
    expect(onRedo).toHaveBeenCalled();
  });

  it('clear/copy/close trigger their callbacks', () => {
    const onClear = vi.fn();
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(
      <Toolbar
        {...defaultProps}
        onClear={onClear}
        onCopy={onCopy}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-clear'));
    fireEvent.click(screen.getByTestId('editor-copy'));
    fireEvent.click(screen.getByTestId('editor-close'));
    expect(onClear).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('active tool has highlighted styling', () => {
    render(<Toolbar {...defaultProps} tool="rect" />);
    const active = screen.getByTestId('tool-rect');
    const inactive = screen.getByTestId('tool-pen');
    expect(active.style.color).toMatch(/rgb\(255,\s*141,\s*92\)|#ff8d5c/i);
    expect(inactive.style.color).not.toMatch(
      /rgb\(255,\s*141,\s*92\)|#ff8d5c/i,
    );
  });
});
