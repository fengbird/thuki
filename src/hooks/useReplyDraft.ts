import { useCallback, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { StreamChunk, OllamaErrorKind } from './useOllama';

/**
 * Immutable snapshot of a single in-flight or completed reply draft.
 *
 * `text` accumulates the visible assistant tokens as they stream in;
 * `thinking` accumulates the separate reasoning stream (when the model
 * emits one). `isGenerating` flips back to false on Done, Cancelled, or
 * Error. `error` is populated only on Error chunks or on invoke failure.
 */
export interface ReplyDraftState {
  text: string;
  thinking: string;
  isGenerating: boolean;
  error: { kind: OllamaErrorKind; message: string } | null;
}

const INITIAL_STATE: ReplyDraftState = {
  text: '',
  thinking: '',
  isGenerating: false,
  error: null,
};

/**
 * Stateless helper around the `generate_reply` Tauri command. Kicks off a
 * streaming reply generation for a captured screenshot and surfaces the
 * accumulating text + thinking + error state.
 *
 * Separated from `useOllama` because the reply flow is completely independent
 * of the chat conversation history — firing a reply should not persist into
 * the main chat, and generating a reply while the normal chat is streaming
 * should not interleave tokens between the two flows.
 */
export function useReplyDraft() {
  const [state, setState] = useState<ReplyDraftState>(INITIAL_STATE);
  const generationIdRef = useRef(0);

  /**
   * Invokes `generate_reply` with the given screenshot + frontmost-app name.
   * Each call increments an internal generation counter so stale chunks from
   * an earlier (cancelled or regenerated) invocation are dropped if they
   * arrive after a newer one has started.
   */
  const generate = useCallback(async (imagePath: string, appName: string) => {
    const id = ++generationIdRef.current;
    setState({ ...INITIAL_STATE, isGenerating: true });

    const channel = new Channel<StreamChunk>();
    let text = '';
    let thinking = '';

    channel.onmessage = (chunk) => {
      // Drop chunks from a stale generation (user regenerated or cancelled).
      if (generationIdRef.current !== id) return;

      if (chunk.type === 'Token') {
        // Strip any leading whitespace the model emits between its
        // reasoning output and the reply body. Once the leading edge is
        // past whitespace, `trimStart` is a no-op on further ticks.
        text = (text + chunk.data).trimStart();
        setState((s) => ({ ...s, text }));
      } else if (chunk.type === 'ThinkingToken') {
        thinking = (thinking + chunk.data).trimStart();
        setState((s) => ({ ...s, thinking }));
      } else if (chunk.type === 'Done') {
        setState((s) => ({ ...s, isGenerating: false }));
      } else if (chunk.type === 'Cancelled') {
        setState((s) => ({ ...s, isGenerating: false }));
      } else {
        setState((s) => ({ ...s, isGenerating: false, error: chunk.data }));
      }
    };

    try {
      await invoke('generate_reply', {
        imagePath,
        appName,
        onEvent: channel,
      });
    } catch {
      if (generationIdRef.current !== id) return;
      setState((s) => ({
        ...s,
        isGenerating: false,
        error: {
          kind: 'Other' as const,
          message: 'Something went wrong\nCould not reach the LLM server.',
        },
      }));
    }
  }, []);

  /** Cancels the currently streaming reply, if any. */
  const cancel = useCallback(async () => {
    await invoke('cancel_generation');
  }, []);

  /** Resets the draft state to its initial (empty) shape. */
  const reset = useCallback(() => {
    generationIdRef.current++;
    setState(INITIAL_STATE);
  }, []);

  return { state, generate, cancel, reset };
}
