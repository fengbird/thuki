import { vi } from 'vitest';

type FocusChangedHandler = (event: { payload: boolean }) => void;
const focusChangedHandlers = new Set<FocusChangedHandler>();

export class LogicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

export class LogicalPosition {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export class PhysicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

export class PhysicalPosition {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const mockWindow = {
  setSize: vi.fn(async () => {}),
  setPosition: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  setFocus: vi.fn(async () => {}),
  startDragging: vi.fn(async () => {}),
  onFocusChanged: vi.fn(async (handler: FocusChangedHandler) => {
    focusChangedHandlers.add(handler);
    return () => {
      focusChangedHandlers.delete(handler);
    };
  }),
  innerSize: vi.fn(async () => new PhysicalSize(420, 300)),
  innerPosition: vi.fn(async () => new PhysicalPosition(0, 0)),
  scaleFactor: vi.fn(async () => 1),
};

export function getCurrentWindow() {
  return mockWindow;
}

export function emitWindowFocusChanged(focused: boolean) {
  for (const handler of focusChangedHandlers) {
    handler({ payload: focused });
  }
}

export function clearWindowEventHandlers() {
  focusChangedHandlers.clear();
}

export { mockWindow as __mockWindow };
