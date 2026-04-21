import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../../testUtils/mocks/tauri';
import {
  extractErrorPayload,
  installGlobalErrorReporter,
} from '../crashReporter';

describe('extractErrorPayload', () => {
  it('unwraps Error instances with stack', () => {
    const err = new Error('boom');
    const got = extractErrorPayload(err);
    expect(got.message).toBe('boom');
    expect(got.stack).toBeDefined();
  });

  it('passes plain strings through', () => {
    expect(extractErrorPayload('kaboom')).toEqual({ message: 'kaboom' });
  });

  it('serialises plain objects via JSON', () => {
    const got = extractErrorPayload({ foo: 1, bar: 'x' });
    expect(got.message).toBe('{"foo":1,"bar":"x"}');
  });

  it('handles primitives that are not strings', () => {
    expect(extractErrorPayload(42).message).toBe('42');
    expect(extractErrorPayload(null).message).toBe('null');
    expect(extractErrorPayload(undefined).message).toBe('undefined');
  });

  it('falls back to Object.prototype.toString for non-serialisable objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const got = extractErrorPayload(circular);
    expect(got.message).toContain('[object');
  });
});

describe('installGlobalErrorReporter', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards window.onerror events to the Rust command', async () => {
    const dispose = installGlobalErrorReporter();
    const event = new ErrorEvent('error', {
      message: 'boom',
      error: new Error('boom'),
      filename: 'app.js',
      lineno: 7,
      colno: 3,
    });
    window.dispatchEvent(event);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith(
      'report_frontend_error',
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'error',
          message: 'boom',
          source: 'app.js',
          line: 7,
          column: 3,
        }),
      }),
    );
    dispose();
  });

  it('forwards unhandled promise rejections', async () => {
    const dispose = installGlobalErrorReporter();
    const rejection = new Error('async boom');
    // Not all happy-dom builds construct PromiseRejectionEvent from
    // scratch, so we fall back to dispatching a plain Event with the
    // reason attached manually.
    const event: Event & { reason?: unknown } =
      typeof PromiseRejectionEvent !== 'undefined'
        ? new PromiseRejectionEvent('unhandledrejection', {
            promise: Promise.reject(rejection).catch(
              () => undefined,
            ) as Promise<unknown>,
            reason: rejection,
          })
        : Object.assign(new Event('unhandledrejection'), { reason: rejection });
    window.dispatchEvent(event);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith(
      'report_frontend_error',
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'unhandledrejection',
          message: 'async boom',
        }),
      }),
    );
    dispose();
  });

  it('swallows invoke errors without rethrowing', async () => {
    invoke.mockImplementation(async () => {
      throw 'bridge-is-down';
    });
    const dispose = installGlobalErrorReporter();
    const event = new ErrorEvent('error', { message: 'x' });
    // Must not throw synchronously OR asynchronously.
    window.dispatchEvent(event);
    await Promise.resolve();
    dispose();
  });

  it('disposer removes both listeners', () => {
    const dispose = installGlobalErrorReporter();
    dispose();
    invoke.mockClear();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after-dispose' }));
    expect(invoke).not.toHaveBeenCalled();
  });
});
