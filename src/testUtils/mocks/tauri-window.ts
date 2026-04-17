import { vi } from 'vitest';

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
  innerSize: vi.fn(async () => new PhysicalSize(420, 300)),
  innerPosition: vi.fn(async () => new PhysicalPosition(0, 0)),
  scaleFactor: vi.fn(async () => 1),
};

export function getCurrentWindow() {
  return mockWindow;
}

export { mockWindow as __mockWindow };
