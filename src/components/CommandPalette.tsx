/**
 * CommandPalette: numbered quick-access list of slash commands.
 *
 * Shown below the ask bar when the overlay first opens (non-chat mode).
 * Each command is assigned a digit 1–9; the user can click a row or press
 * the corresponding number key to insert the command into the input.
 */

import type { Command } from '../config/commands';

/** Maximum commands shown — limited to single-digit shortcuts. */
const MAX_PALETTE_ITEMS = 9;

interface CommandPaletteProps {
  /** Active command list (from mergeCommands). Only the first 9 are shown. */
  commands: readonly Command[];
  /** Called with the trigger string when a row is clicked. */
  onSelect: (trigger: string) => void;
}

export function CommandPalette({ commands, onSelect }: CommandPaletteProps) {
  const items = commands.slice(0, MAX_PALETTE_ITEMS);

  return (
    <div
      data-testid="command-palette"
      className="mt-1 rounded-xl border border-surface-border bg-surface-base backdrop-blur-2xl shadow-bar overflow-hidden"
      role="listbox"
      aria-label="Quick commands"
    >
      {/* Header */}
      <div className="px-3 pt-2 pb-1">
        <span className="text-[10px] font-semibold tracking-widest text-text-secondary uppercase">
          Quick Commands
        </span>
      </div>

      <ul className="pb-1 max-h-[280px] overflow-y-auto" role="presentation">
        {items.map((cmd, index) => (
          <li
            key={cmd.trigger}
            role="option"
            aria-selected={false}
            data-testid={`palette-item-${index}`}
            className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer select-none transition-colors duration-100 text-text-secondary hover:bg-white/5 hover:text-text-primary"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd.trigger);
            }}
          >
            {/* Shortcut badge */}
            <span className="shrink-0 h-5 px-1 flex items-center justify-center rounded text-[10px] font-semibold text-text-secondary border border-surface-border leading-none">
              ⌃{index + 1}
            </span>

            {/* Trigger label */}
            <span className="text-sm font-medium text-primary shrink-0 font-mono">
              {cmd.trigger}
            </span>

            {/* Description */}
            <span className="text-xs text-text-secondary min-w-0 truncate flex-1">
              {cmd.description}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
