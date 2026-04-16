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
 * Warm-ambient theme tokens — shared visual language with the onboarding
 * `IntroStep`. Centralised here so if the design evolves we can tune one
 * spot rather than chase literals through the markup.
 */
const THEME = {
  cardBg:
    'radial-gradient(ellipse 80% 55% at 50% 0%, rgba(255,141,92,0.14) 0%, rgba(28,24,20,0.97) 60%), rgba(28,24,20,0.97)',
  cardBorder: '1px solid rgba(255, 141, 92, 0.2)',
  cardShadow: '0 0 40px rgba(255,100,40,0.07)',
  cardRadius: 24,
  divider: 'rgba(255,255,255,0.05)',
  textPrimary: '#f0f0f2',
  textSecondary: 'rgba(240,240,242,0.9)',
  textMuted: 'rgba(255,255,255,0.3)',
  textDim: 'rgba(255,255,255,0.28)',
  accent: 'rgba(255,141,92,0.65)',
  accentStrong: '#ff8d5c',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
};

/**
 * Renders the reply-draft UI in the warm-ambient theme shared with the
 * onboarding screen: dark card with a subtle orange radial glow, an
 * orange-tinted thumbnail/header, streaming draft + reasoning, inline
 * error callouts, and keyboard hint chips styled like IntroStep.
 *
 * Keyboard shortcuts (registered while mounted):
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

  // Keep the thinking block pinned to its latest token as it streams.
  useEffect(() => {
    const el = thinkingRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.thinking]);

  // Only kick off generation once the image has arrived.
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
      // Trim trailing whitespace on the way out — the hook already strips
      // leading whitespace during streaming, but the model occasionally
      // tacks a final newline on after the reply.
      await invoke('paste_reply_and_hide', {
        bundleId,
        text: state.text.trim(),
      });
      onDismiss();
    } catch (e) {
      setIsPasting(false);
      setPasteError(
        typeof e === 'string' ? e : ((e as Error)?.message ?? String(e)),
      );
    }
  }, [pasteDisabled, bundleId, state.text, onDismiss]);

  const handleRegenerate = useCallback(async () => {
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
      style={{
        width: 440,
        background: THEME.cardBg,
        border: THEME.cardBorder,
        borderRadius: THEME.cardRadius,
        boxShadow: THEME.cardShadow,
        padding: '22px 22px 18px',
        fontFamily: THEME.fontFamily,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {/* Header: thumbnail + label + app name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {imagePath ? (
          <img
            src={convertFileSrc(imagePath)}
            alt={`Screenshot of ${appName}`}
            data-testid="reply-thumbnail"
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              objectFit: 'cover',
              border: '1px solid rgba(255,141,92,0.18)',
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            data-testid="reply-thumbnail-pending"
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              border: '1px solid rgba(255,141,92,0.18)',
              background: 'rgba(255,141,92,0.06)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Spinner />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              color: 'rgba(255,141,92,0.7)',
              fontWeight: 600,
              marginBottom: 2,
            }}
          >
            {isCapturing ? 'Capturing…' : 'Draft reply'}
          </div>
          <div
            data-testid="reply-target-app"
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: THEME.textPrimary,
              letterSpacing: '-0.2px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {appName}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: THEME.divider }} />

      {/* Thinking stream (auto-scroll to bottom) */}
      {state.thinking && (
        <div
          ref={thinkingRef}
          data-testid="reply-thinking"
          style={{
            fontSize: 11.5,
            fontStyle: 'italic',
            color: 'rgba(255,255,255,0.38)',
            lineHeight: 1.55,
            maxHeight: 80,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            paddingRight: 4,
          }}
        >
          {state.thinking}
        </div>
      )}

      {/* Draft body */}
      <div
        data-testid="reply-body"
        style={{
          fontSize: 14,
          color: THEME.textPrimary,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          minHeight: 48,
          letterSpacing: '-0.1px',
        }}
      >
        {state.text ? (
          state.text
        ) : captureError ? (
          <span style={{ color: THEME.textMuted }}>Window capture failed.</span>
        ) : isCapturing ? (
          <span style={{ color: THEME.textMuted }}>
            Capturing the focused window of {appName}…
          </span>
        ) : state.isGenerating ? (
          <span style={{ color: THEME.textMuted }}>Generating a reply…</span>
        ) : (
          <span style={{ color: THEME.textMuted }}>No reply yet.</span>
        )}
      </div>

      {/* Error cards */}
      {captureError && (
        <ErrorCard kind="Other" message={`Capture failed\n${captureError}`} />
      )}
      {state.error && (
        <ErrorCard kind={state.error.kind} message={state.error.message} />
      )}
      {pasteError && (
        <ErrorCard kind="Other" message={`Paste failed\n${pasteError}`} />
      )}

      {/* Divider */}
      <div style={{ height: 1, background: THEME.divider }} />

      {/* Keyboard hints */}
      <div
        data-testid="reply-hints"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          fontSize: 11,
          color: 'rgba(255,255,255,0.4)',
          fontFamily: THEME.fontFamily,
        }}
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

/**
 * Keybinding hint rendered at the bottom of the card. Chip styling matches
 * `IntroStep.KeyChip` so the two screens feel like the same family.
 */
function ShortcutHint({ keys, label, disabled }: ShortcutHintProps) {
  return (
    <div
      data-testid={`reply-hint-${label.replace(/\s+/g, '-')}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {keys.map((k) => (
        <kbd
          key={k}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 18,
            padding: '1px 6px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderBottom: '2px solid rgba(255,255,255,0.08)',
            borderRadius: 4,
            fontSize: 10.5,
            fontFamily: "'SF Mono', 'Fira Mono', monospace",
            color: 'rgba(255,255,255,0.6)',
            lineHeight: 1.5,
          }}
        >
          {k}
        </kbd>
      ))}
      <span style={{ letterSpacing: '-0.1px' }}>{label}</span>
    </div>
  );
}

/** Small orange-tinted spinner for the capturing-phase thumbnail slot. */
function Spinner() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <g style={{ transformOrigin: 'center', animation: 'spin 0.9s linear infinite' }}>
        <circle
          cx="9"
          cy="9"
          r="6.5"
          fill="none"
          stroke="rgba(255,141,92,0.22)"
          strokeWidth="2"
        />
        <path
          d="M9 2.5a6.5 6.5 0 0 1 6.5 6.5"
          fill="none"
          stroke="rgba(255,141,92,0.85)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
