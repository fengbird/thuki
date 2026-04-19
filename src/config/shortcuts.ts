export type ShortcutModifier = 'cmd' | 'ctrl' | 'shift' | 'alt';

export interface KeyComboShortcut {
  kind: 'key_combo';
  key_code: number;
  modifiers: ShortcutModifier[];
}

export interface DoubleTapModifierShortcut {
  kind: 'double_tap_modifier';
  modifier: ShortcutModifier;
}

export type OverlayActivationShortcut =
  | DoubleTapModifierShortcut
  | KeyComboShortcut;

export interface ShortcutConfig {
  overlay_activation: OverlayActivationShortcut;
  screenshot_capture: KeyComboShortcut;
}

export const DEFAULT_SHORTCUT_CONFIG: ShortcutConfig = {
  overlay_activation: {
    kind: 'double_tap_modifier',
    modifier: 'ctrl',
  },
  screenshot_capture: {
    kind: 'key_combo',
    key_code: 0x07,
    modifiers: ['cmd', 'shift'],
  },
};

const MODIFIER_ORDER: ShortcutModifier[] = ['cmd', 'ctrl', 'alt', 'shift'];

const MODIFIER_SYMBOLS: Record<ShortcutModifier, string> = {
  cmd: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
};

const DOM_CODE_TO_MAC_KEYCODE: Record<string, number> = {
  KeyA: 0x00,
  KeyS: 0x01,
  KeyD: 0x02,
  KeyF: 0x03,
  KeyH: 0x04,
  KeyG: 0x05,
  KeyZ: 0x06,
  KeyX: 0x07,
  KeyC: 0x08,
  KeyV: 0x09,
  KeyB: 0x0b,
  KeyQ: 0x0c,
  KeyW: 0x0d,
  KeyE: 0x0e,
  KeyR: 0x0f,
  KeyY: 0x10,
  KeyT: 0x11,
  Digit1: 0x12,
  Digit2: 0x13,
  Digit3: 0x14,
  Digit4: 0x15,
  Digit6: 0x16,
  Digit5: 0x17,
  Equal: 0x18,
  Digit9: 0x19,
  Digit7: 0x1a,
  Minus: 0x1b,
  Digit8: 0x1c,
  Digit0: 0x1d,
  BracketRight: 0x1e,
  KeyO: 0x1f,
  KeyU: 0x20,
  BracketLeft: 0x21,
  KeyI: 0x22,
  KeyP: 0x23,
  Enter: 0x24,
  KeyL: 0x25,
  KeyJ: 0x26,
  Quote: 0x27,
  KeyK: 0x28,
  Semicolon: 0x29,
  Backslash: 0x2a,
  Comma: 0x2b,
  Slash: 0x2c,
  KeyN: 0x2d,
  KeyM: 0x2e,
  Period: 0x2f,
  Tab: 0x30,
  Space: 0x31,
  Backquote: 0x32,
  Backspace: 0x33,
  Escape: 0x35,
  ArrowLeft: 0x7b,
  ArrowRight: 0x7c,
  ArrowDown: 0x7d,
  ArrowUp: 0x7e,
  F1: 0x7a,
  F2: 0x78,
  F3: 0x63,
  F4: 0x76,
  F5: 0x60,
  F6: 0x61,
  F7: 0x62,
  F8: 0x64,
  F9: 0x65,
  F10: 0x6d,
  F11: 0x67,
  F12: 0x6f,
};

const KEYCODE_LABELS: Record<number, string> = {
  0x00: 'A',
  0x01: 'S',
  0x02: 'D',
  0x03: 'F',
  0x04: 'H',
  0x05: 'G',
  0x06: 'Z',
  0x07: 'X',
  0x08: 'C',
  0x09: 'V',
  0x0b: 'B',
  0x0c: 'Q',
  0x0d: 'W',
  0x0e: 'E',
  0x0f: 'R',
  0x10: 'Y',
  0x11: 'T',
  0x12: '1',
  0x13: '2',
  0x14: '3',
  0x15: '4',
  0x16: '6',
  0x17: '5',
  0x18: '=',
  0x19: '9',
  0x1a: '7',
  0x1b: '-',
  0x1c: '8',
  0x1d: '0',
  0x1e: ']',
  0x1f: 'O',
  0x20: 'U',
  0x21: '[',
  0x22: 'I',
  0x23: 'P',
  0x24: 'Return',
  0x25: 'L',
  0x26: 'J',
  0x27: "'",
  0x28: 'K',
  0x29: ';',
  0x2a: '\\',
  0x2b: ',',
  0x2c: '/',
  0x2d: 'N',
  0x2e: 'M',
  0x2f: '.',
  0x30: 'Tab',
  0x31: 'Space',
  0x32: '`',
  0x33: 'Delete',
  0x35: 'Esc',
  0x60: 'F5',
  0x61: 'F6',
  0x62: 'F7',
  0x63: 'F3',
  0x64: 'F8',
  0x65: 'F9',
  0x67: 'F11',
  0x6d: 'F10',
  0x6f: 'F12',
  0x76: 'F4',
  0x78: 'F2',
  0x7a: 'F1',
  0x7b: '←',
  0x7c: '→',
  0x7d: '↓',
  0x7e: '↑',
};

function normalizeModifiers(modifiers: ShortcutModifier[]): ShortcutModifier[] {
  return [...new Set(modifiers)].sort(
    (left, right) =>
      MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right),
  );
}

export function normalizeShortcutConfig(
  raw: Partial<ShortcutConfig> | null | undefined,
): ShortcutConfig {
  const overlay = raw?.overlay_activation;
  const screenshot = raw?.screenshot_capture;

  return {
    overlay_activation:
      overlay?.kind === 'key_combo'
        ? {
            kind: 'key_combo',
            key_code:
              typeof overlay.key_code === 'number'
                ? overlay.key_code
                : DEFAULT_SHORTCUT_CONFIG.screenshot_capture.key_code,
            modifiers: normalizeModifiers(overlay.modifiers ?? []),
          }
        : overlay?.kind === 'double_tap_modifier'
          ? {
              kind: 'double_tap_modifier',
              modifier: overlay.modifier ?? 'ctrl',
            }
          : DEFAULT_SHORTCUT_CONFIG.overlay_activation,
    screenshot_capture: {
      kind: 'key_combo',
      key_code:
        typeof screenshot?.key_code === 'number'
          ? screenshot.key_code
          : DEFAULT_SHORTCUT_CONFIG.screenshot_capture.key_code,
      modifiers: normalizeModifiers(
        screenshot?.modifiers ??
          DEFAULT_SHORTCUT_CONFIG.screenshot_capture.modifiers,
      ),
    },
  };
}

export function formatShortcut(shortcut: OverlayActivationShortcut): string {
  if (shortcut.kind === 'double_tap_modifier') {
    return `Double ${modifierLabel(shortcut.modifier)}`;
  }

  const modifiers = normalizeModifiers(shortcut.modifiers)
    .map((modifier) => MODIFIER_SYMBOLS[modifier])
    .join('');
  const keyLabel =
    KEYCODE_LABELS[shortcut.key_code] ?? `Key ${shortcut.key_code}`;
  return `${modifiers}${keyLabel}`;
}

export function modifierLabel(modifier: ShortcutModifier): string {
  switch (modifier) {
    case 'cmd':
      return 'Command';
    case 'ctrl':
      return 'Control';
    case 'shift':
      return 'Shift';
    case 'alt':
      return 'Option';
  }
}

export function modifierFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'key'>,
): ShortcutModifier | null {
  switch (event.key) {
    case 'Meta':
      return 'cmd';
    case 'Control':
      return 'ctrl';
    case 'Shift':
      return 'shift';
    case 'Alt':
      return 'alt';
    default:
      return null;
  }
}

export function captureKeyComboFromEvent(
  event: Pick<
    KeyboardEvent,
    'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key'
  >,
): KeyComboShortcut | null {
  const keyCode = DOM_CODE_TO_MAC_KEYCODE[event.code];
  if (typeof keyCode !== 'number') {
    return null;
  }

  if (modifierFromKeyboardEvent(event)) {
    return null;
  }

  const modifiers: ShortcutModifier[] = [];
  if (event.metaKey) modifiers.push('cmd');
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');

  if (modifiers.length === 0) {
    return null;
  }

  return {
    kind: 'key_combo',
    key_code: keyCode,
    modifiers: normalizeModifiers(modifiers),
  };
}
