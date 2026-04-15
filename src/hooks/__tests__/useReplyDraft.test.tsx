import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useReplyDraft } from '../useReplyDraft';
import {
  invoke,
  enableChannelCapture,
  getLastChannel,
  resetChannelCapture,
} from '../../testUtils/mocks/tauri';

describe('useReplyDraft', () => {
  beforeEach(() => {
    invoke.mockClear();
    resetChannelCapture();
    enableChannelCapture();
  });

  it('starts with empty state', () => {
    const { result } = renderHook(() => useReplyDraft());
    expect(result.current.state).toEqual({
      text: '',
      thinking: '',
      isGenerating: false,
      error: null,
    });
  });

  it('invokes generate_reply with imagePath, appName, onEvent channel', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/shot.png', 'WeChat');
    });

    expect(invoke).toHaveBeenCalledWith('generate_reply', {
      imagePath: '/tmp/shot.png',
      appName: 'WeChat',
      onEvent: expect.anything(),
    });
    expect(result.current.state.isGenerating).toBe(true);
  });

  it('accumulates Token chunks into text', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/shot.png', 'WeChat');
    });

    const channel = getLastChannel();
    expect(channel).not.toBeNull();

    act(() => {
      channel!.simulateMessage({ type: 'Token', data: 'Hello ' });
      channel!.simulateMessage({ type: 'Token', data: 'there' });
    });

    expect(result.current.state.text).toBe('Hello there');
    expect(result.current.state.isGenerating).toBe(true);
  });

  it('accumulates ThinkingToken chunks into thinking', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/shot.png', 'WeChat');
    });

    const channel = getLastChannel();
    act(() => {
      channel!.simulateMessage({ type: 'ThinkingToken', data: 'Reading…' });
      channel!.simulateMessage({ type: 'ThinkingToken', data: ' thinking.' });
    });

    expect(result.current.state.thinking).toBe('Reading… thinking.');
  });

  it('Done chunk flips isGenerating to false', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/shot.png', 'WeChat');
    });

    const channel = getLastChannel();
    act(() => {
      channel!.simulateMessage({ type: 'Token', data: 'Hi!' });
      channel!.simulateMessage({ type: 'Done' });
    });

    expect(result.current.state.isGenerating).toBe(false);
    expect(result.current.state.text).toBe('Hi!');
  });

  it('Cancelled chunk flips isGenerating to false', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/shot.png', 'WeChat');
    });

    const channel = getLastChannel();
    act(() => {
      channel!.simulateMessage({ type: 'Cancelled' });
    });

    expect(result.current.state.isGenerating).toBe(false);
  });

  it('Error chunk stores the error payload', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/shot.png', 'WeChat');
    });

    const channel = getLastChannel();
    act(() => {
      channel!.simulateMessage({
        type: 'Error',
        data: {
          kind: 'NotRunning',
          message: "LLM server isn't running\nStart your server and try again.",
        },
      });
    });

    expect(result.current.state.isGenerating).toBe(false);
    expect(result.current.state.error?.kind).toBe('NotRunning');
  });

  it('captures Other-kind error when invoke rejects', async () => {
    invoke.mockImplementationOnce(async () => {
      throw new Error('IPC transport failure');
    });

    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/shot.png', 'WeChat');
    });

    expect(result.current.state.isGenerating).toBe(false);
    expect(result.current.state.error?.kind).toBe('Other');
    expect(result.current.state.error?.message).toContain('LLM server');
  });

  it('cancel() invokes cancel_generation', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.cancel();
    });

    expect(invoke).toHaveBeenCalledWith('cancel_generation');
  });

  it('reset() clears state and suppresses stale chunks from a prior generation', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/a.png', 'App');
    });
    const firstChannel = getLastChannel();
    act(() => {
      firstChannel!.simulateMessage({ type: 'Token', data: 'old' });
    });
    expect(result.current.state.text).toBe('old');

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toEqual({
      text: '',
      thinking: '',
      isGenerating: false,
      error: null,
    });

    // Stale chunks from the first invocation must be ignored now that the
    // generation id has advanced.
    act(() => {
      firstChannel!.simulateMessage({ type: 'Token', data: 'stale' });
    });
    expect(result.current.state.text).toBe('');
  });

  it('suppresses stale chunks after a new generate() supersedes the previous one', async () => {
    const { result } = renderHook(() => useReplyDraft());

    await act(async () => {
      await result.current.generate('/tmp/a.png', 'AppA');
    });
    const firstChannel = getLastChannel();

    await act(async () => {
      await result.current.generate('/tmp/b.png', 'AppB');
    });
    const secondChannel = getLastChannel();

    // First-generation tokens arriving late are dropped.
    act(() => {
      firstChannel!.simulateMessage({ type: 'Token', data: 'first' });
    });
    expect(result.current.state.text).toBe('');

    act(() => {
      secondChannel!.simulateMessage({ type: 'Token', data: 'second' });
    });
    expect(result.current.state.text).toBe('second');
  });

  it('invoke rejection from a superseded generate() does not overwrite newer state', async () => {
    // First call will reject, second call will succeed.
    invoke
      .mockImplementationOnce(async (_cmd, args) => {
        // Capture its channel first so its id gets registered.
        if (args && 'onEvent' in args) {
          // noop — channel already captured by enableChannelCapture
        }
        throw new Error('stale failure');
      })
      .mockImplementationOnce(async (_cmd, args) => {
        if (args && 'onEvent' in args) {
          // noop
        }
      });

    const { result } = renderHook(() => useReplyDraft());

    // Kick off two generations back-to-back. The first's thrown error should
    // be suppressed because generation id has already advanced.
    await act(async () => {
      const a = result.current.generate('/tmp/a.png', 'AppA');
      const b = result.current.generate('/tmp/b.png', 'AppB');
      await Promise.all([a, b]);
    });

    // No stale error should remain on state.
    expect(result.current.state.error).toBeNull();
  });
});
