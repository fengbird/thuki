import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { useReplyDraft } from '../hooks/useReplyDraft';
import { ErrorCard } from '../components/ErrorCard';

/**
 * Props for `ReplyDraftView`.
 *
 * `imagePath` is `null` while the window screenshot is still being
 * captured — the view then renders a "capturing…" placeholder so the
 * user sees feedback the moment ⌃⇧R is pressed, before the (slower)
 * CoreGraphics capture finishes. `captureError` is populated when the
 * capture failed outright (e.g. target app has no on-screen window).
 */
export interface ReplyDraftViewProps {
  bundleId: string;
  appName: string;
  imagePath: string | null;
  captureError: string | null;
  onDismiss: () => void;
}

/**
 * Renders the reply-draft UI: a thumbnail of the captured window, the
 * app the reply is destined for, the streaming draft text (plus thinking
 * stream when the model emits one), and inline error callouts for
 * capture / generation / paste failures.
 *
 * Keyboard shortcuts (registered as long as the view is mounted):
 * - `Enter`          → paste the draft into the target app
 * - `Escape`         → dismiss without pasting (cancels generation first)
 * - `⌘R` / `Ctrl+R`  → regenerate from the same screenshot
 */
export function ReplyDraftView({
  bundleId,
  appName,
  imagePath,
  captureError,
  onDismiss,
}: ReplyDraftViewProps) {
  const { state, generate, cancel, reset } = useReplyDraft();
  const [isPasting, setIsPasting] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const thinkingRef = useRef<HTMLDivElement | null>(null);

  // Keep the thinking block pinned to its latest token as it streams. The
  // container is `max-h-20` with overflow scroll, so without this the user
  // would only see the first few lines of a long reasoning trace.
  useEffect(() => {
    const el = thinkingRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.thinking]);

  // Only kick off generation once the image has arrived. While the
  // screenshot is pending, `imagePath` stays null and this effect is a
  // no-op — the "Capturing…" placeholder is shown instead.
  useEffect(() => {
    if (!imagePath) return;
    void generate(imagePath, appName);
  }, [imagePath, appName, generate]);

  const isCapturing = imagePath === null && captureError === null;
  const pasteDisabled =
    state.isGenerating ||
    !state.text.trim() ||
    isPasting ||
    state.error !== null ||
    isCapturing ||
    captureError !== null;
  const regenerateDisabled = isPasting || imagePath === null;

  const handlePaste = useCallback(async () => {
    if (pasteDisabled) return;
    setIsPasting(true);
    setPasteError(null);
    try {
      await invoke('paste_reply_and_hide', { bundleId, text: state.text });
      onDismiss();
    } catch (e) {
      setIsPasting(false);
      setPasteError(
        typeof e === 'string' ? e : ((e as Error)?.message ?? String(e)),
      );
    }
  }, [pasteDisabled, bundleId, state.text, onDismiss]);

  const handleRegenerate = useCallback(async () => {
    // `regenerateDisabled` already rejects the null-imagePath case, so
    // by this point the screenshot is definitely ready.
    if (regenerateDisabled || imagePath === null) return;
    if (state.isGenerating) {
      await cancel();
    }
    reset();
    setPasteError(null);
    void generate(imagePath, appName);
  }, [
    regenerateDisabled,
    state.isGenerating,
    cancel,
    reset,
    generate,
    imagePath,
    appName,
  ]);

  const handleDismiss = useCallback(async () => {
    if (state.isGenerating) {
      await cancel();
    }
    onDismiss();
  }, [state.isGenerating, cancel, onDismiss]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void handlePaste();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void handleDismiss();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        void handleRegenerate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePaste, handleDismiss, handleRegenerate]);

  return (
    <div
      data-testid="reply-draft-root"
      className="flex flex-col gap-3 p-4 rounded-xl backdrop-blur-xl bg-black/30 border border-white/10 max-w-[560px]"
    >
      <div className="flex items-center gap-3">
        {imagePath ? (
          <img
            src={convertFileSrc(imagePath)}
            alt={`Screenshot of ${appName}`}
            className="w-10 h-10 rounded-md object-cover border border-white/10"
            data-testid="reply-thumbnail"
          />
        ) : (
          <div
            data-testid="reply-thumbnail-pending"
            className="w-10 h-10 rounded-md border border-white/10 bg-white/5 flex items-center justify-center"
            aria-hidden
          >
            <div className="w-3 h-3 border-2 border-white/40 border-t-white/80 rounded-full animate-spin" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.08em] text-white/40">
            {isCapturing ? 'Capturing…' : 'Draft reply'}
          </div>
          <div
            data-testid="reply-target-app"
            className="text-[13px] font-[590] text-white/90 truncate"
          >
            {appName}
          </div>
        </div>
      </div>

      {state.thinking && (
        <div
          ref={thinkingRef}
          data-testid="reply-thinking"
          className="text-[11.5px] text-white/40 italic leading-snug max-h-20 overflow-y-auto whitespace-pre-wrap"
        >
          {state.thinking}
        </div>
      )}

      <div
        data-testid="reply-body"
        className="text-[14px] text-white/95 leading-relaxed whitespace-pre-wrap min-h-[48px]"
      >
        {state.text ? (
          state.text
        ) : captureError ? (
          <span className="text-white/40">Window capture failed.</span>
        ) : isCapturing ? (
          <span className="text-white/40">
            Capturing the focused window of {appName}…
          </span>
        ) : state.isGenerating ? (
          <span className="text-white/40">Generating a reply…</span>
        ) : (
          <span className="text-white/40">No reply yet.</span>
        )}
      </div>

      {captureError && (
        <ErrorCard kind="Other" message={`Capture failed\n${captureError}`} />
      )}
      {state.error && (
        <ErrorCard kind={state.error.kind} message={state.error.message} />
      )}
      {pasteError && (
        <ErrorCard kind="Other" message={`Paste failed\n${pasteError}`} />
      )}

      <div
        data-testid="reply-hints"
        className="flex flex-wrap gap-4 text-[11px] text-white/45 pt-1 border-t border-white/5"
      >
        <ShortcutHint
          keys={['↵']}
          label={isPasting ? 'pasting…' : 'paste'}
          disabled={pasteDisabled}
        />
        <ShortcutHint keys={['esc']} label="cancel" />
        <ShortcutHint
          keys={['⌘', 'R']}
          label="regenerate"
          disabled={regenerateDisabled}
        />
      </div>
    </div>
  );
}

interface ShortcutHintProps {
  keys: string[];
  label: string;
  disabled?: boolean;
}

/** Keybinding hint rendered at the bottom of the reply-draft card. */
function ShortcutHint({ keys, label, disabled }: ShortcutHintProps) {
  return (
    <div
      data-testid={`reply-hint-${label.replace(/\s+/g, '-')}`}
      className={`flex items-center gap-1.5 ${disabled ? 'opacity-40' : ''}`}
    >
      {keys.map((k) => (
        <kbd
          key={k}
          className="font-mono text-[10px] bg-white/10 text-white/70 px-1.5 rounded min-w-[18px] text-center"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </div>
  );
}
