import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CommandPalette } from '../CommandPalette';
import type { Command } from '../../config/commands';

const SAMPLE_COMMANDS: Command[] = [
  { trigger: '/screen', label: '/screen', description: 'Capture screen' },
  { trigger: '/think', label: '/think', description: 'Think deeply' },
  {
    trigger: '/translate',
    label: '/translate',
    description: 'Translate text',
    promptTemplate: 'Translate $INPUT to $LANG',
  },
  {
    trigger: '/rewrite',
    label: '/rewrite',
    description: 'Rewrite text',
    promptTemplate: 'Rewrite: $INPUT',
  },
];

describe('CommandPalette', () => {
  it('renders a numbered list of commands', () => {
    render(<CommandPalette commands={SAMPLE_COMMANDS} onSelect={vi.fn()} />);

    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-0')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-1')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-2')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-3')).toBeInTheDocument();
  });

  it('shows number badges 1-4 for four commands', () => {
    render(<CommandPalette commands={SAMPLE_COMMANDS} onSelect={vi.fn()} />);

    const items = screen.getAllByRole('option');
    expect(items[0].textContent).toContain('1');
    expect(items[1].textContent).toContain('2');
    expect(items[2].textContent).toContain('3');
    expect(items[3].textContent).toContain('4');
  });

  it('shows trigger and description for each command', () => {
    render(<CommandPalette commands={SAMPLE_COMMANDS} onSelect={vi.fn()} />);

    expect(screen.getByTestId('palette-item-0').textContent).toContain(
      '/screen',
    );
    expect(screen.getByTestId('palette-item-0').textContent).toContain(
      'Capture screen',
    );
  });

  it('calls onSelect with the trigger when a row is clicked', () => {
    const onSelect = vi.fn();
    render(<CommandPalette commands={SAMPLE_COMMANDS} onSelect={onSelect} />);

    fireEvent.mouseDown(screen.getByTestId('palette-item-2'));
    expect(onSelect).toHaveBeenCalledWith('/translate');
  });

  it('limits display to 9 items max', () => {
    const manyCommands: Command[] = Array.from({ length: 12 }, (_, i) => ({
      trigger: `/cmd${i + 1}`,
      label: `/cmd${i + 1}`,
      description: `Command ${i + 1}`,
    }));

    render(<CommandPalette commands={manyCommands} onSelect={vi.fn()} />);

    expect(screen.getByTestId('palette-item-8')).toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-9')).toBeNull();
  });

  it('renders the Quick Commands header', () => {
    render(<CommandPalette commands={SAMPLE_COMMANDS} onSelect={vi.fn()} />);

    expect(screen.getByText('Quick Commands')).toBeInTheDocument();
  });

  it('shows screenshot shortcut row when onScreenshot is provided', () => {
    render(
      <CommandPalette
        commands={SAMPLE_COMMANDS}
        onSelect={vi.fn()}
        onScreenshot={vi.fn()}
      />,
    );

    expect(screen.getByTestId('palette-screenshot')).toBeInTheDocument();
    expect(screen.getByText('⌃R')).toBeInTheDocument();
    expect(screen.getByText('Free-form screenshot')).toBeInTheDocument();
  });

  it('does not show screenshot row when onScreenshot is omitted', () => {
    render(<CommandPalette commands={SAMPLE_COMMANDS} onSelect={vi.fn()} />);

    expect(screen.queryByTestId('palette-screenshot')).toBeNull();
  });

  it('calls onScreenshot when the screenshot row is clicked', () => {
    const onScreenshot = vi.fn();
    render(
      <CommandPalette
        commands={SAMPLE_COMMANDS}
        onSelect={vi.fn()}
        onScreenshot={onScreenshot}
      />,
    );

    fireEvent.mouseDown(screen.getByTestId('palette-screenshot'));
    expect(onScreenshot).toHaveBeenCalledTimes(1);
  });
});
