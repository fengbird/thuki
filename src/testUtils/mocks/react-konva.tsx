/**
 * Test mock for `react-konva` — happy-dom/jsdom have no canvas, so real
 * Konva cannot instantiate. Each component is replaced by a lightweight
 * presentational div/span that forwards props via data-* attributes so
 * assertions can still observe structural changes.
 *
 * Mouse handlers on the Stage are wrapped so they receive a
 * Konva-shaped event (with `target.getStage()` returning a stage-like
 * stub) rather than a raw React SyntheticEvent — otherwise production
 * code calling `e.target.getStage()` would throw in tests.
 */

import type React from 'react';
import { forwardRef, useImperativeHandle, useRef } from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

interface FakeStage {
  toDataURL: () => string;
  getPointerPosition: () => { x: number; y: number };
}

/**
 * Per-stage pointer queue — tests can push coordinates via
 * `__mockKonvaSetPointerQueue` to simulate a drag sequence. If the queue is
 * empty, the stage returns a fixed {42, 42} (zero-size draft — no commit).
 */
const pointerQueue: Array<{ x: number; y: number }> = [];

export function __mockKonvaSetPointerQueue(
  positions: Array<{ x: number; y: number }>,
): void {
  pointerQueue.length = 0;
  pointerQueue.push(...positions);
}

function makeStage(): FakeStage {
  return {
    toDataURL: () => 'data:image/png;base64,TEST',
    getPointerPosition: () => pointerQueue.shift() ?? { x: 42, y: 42 },
  };
}

export const Stage = forwardRef<unknown, AnyProps>(function Stage(
  props: AnyProps,
  ref,
) {
  const stageRef = useRef<FakeStage>(makeStage());

  useImperativeHandle(ref, () => stageRef.current, []);

  const wrap = (
    handler:
      | ((e: { target: { getStage: () => FakeStage } }) => void)
      | undefined,
  ) =>
    handler
      ? () => {
          handler({ target: { getStage: () => stageRef.current } });
        }
      : undefined;

  return (
    <div
      data-testid="mock-stage"
      data-tool-cursor={
        (props.style as { cursor?: string } | undefined)?.cursor
      }
      onMouseDown={wrap(
        props.onMouseDown as
          | ((e: { target: { getStage: () => FakeStage } }) => void)
          | undefined,
      )}
      onMouseMove={wrap(
        props.onMouseMove as
          | ((e: { target: { getStage: () => FakeStage } }) => void)
          | undefined,
      )}
      onMouseUp={wrap(
        props.onMouseUp as
          | ((e: { target: { getStage: () => FakeStage } }) => void)
          | undefined,
      )}
    >
      {props.children as React.ReactNode}
    </div>
  );
});

export function Layer(props: AnyProps) {
  return (
    <div data-testid="mock-layer">{props.children as React.ReactNode}</div>
  );
}

export function Image() {
  return <div data-testid="mock-konva-image" />;
}

export function Rect(props: AnyProps) {
  return (
    <div
      data-testid="mock-rect"
      data-x={props.x as number}
      data-y={props.y as number}
      data-width={props.width as number}
      data-height={props.height as number}
    />
  );
}

export function Arrow(props: AnyProps) {
  return (
    <div data-testid="mock-arrow" data-points={JSON.stringify(props.points)} />
  );
}

export function Line(props: AnyProps) {
  return (
    <div data-testid="mock-line" data-points={JSON.stringify(props.points)} />
  );
}

export function Text(props: AnyProps) {
  return (
    <div
      data-testid="mock-text"
      data-text={props.text as string}
      data-x={props.x as number}
      data-y={props.y as number}
      data-font-size={props.fontSize as number}
      data-fill={props.fill as string}
    />
  );
}

export function Group(props: AnyProps) {
  return (
    <div data-testid="mock-group">{props.children as React.ReactNode}</div>
  );
}
