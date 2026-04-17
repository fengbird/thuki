import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

type PreviewState = {
  count: number;
  version: number;
  path: string;
  width: number;
  height: number;
};

type ProgressPayload = {
  count: number;
  version: number;
  path: string;
  width: number;
  height: number;
};

/**
 * Floating HUD for the manual long-screenshot flow. Shows a live,
 * scroll-pinned preview of the stitched image as the user scrolls the
 * target app, plus Save / Cancel buttons.
 *
 * The backend polls the selection rect, incrementally appends only the
 * non-overlapping bottom of each new capture onto the stitched image,
 * re-encodes the preview PNG at a stable path, and emits
 * `thuki://long-capture-progress` with `{count, version, path, ...}`.
 * We reload the `<img>` via a `?v=<version>` cache-buster so the webview
 * actually picks up the new bytes.
 */
export function LongShotHudView() {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'cancelling'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void (async () => {
      cleanup = await listen<ProgressPayload>(
        'thuki://long-capture-progress',
        (e) => {
          setErrorMessage('');
          setPreview(e.payload);
        },
      );
    })();
    return () => cleanup?.();
  }, []);

  // Pin scroll to the bottom on each new preview so the user always sees
  // the most recent addition — same UX as a chat log tailing new messages.
  useEffect(() => {
    const el = scrollRef.current;
    /* v8 ignore next -- the scroll container is always rendered, so the
       ref is set by the time this effect runs. */
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [preview?.version]);

  const handleSave = useCallback(async () => {
    setBusy('saving');
    setErrorMessage('');
    try {
      await invoke('finish_manual_long_capture');
      void getCurrentWindow().hide();
    } catch (error) {
      setBusy('idle');
      setErrorMessage(typeof error === 'string' ? error : String(error));
    }
  }, []);

  const handleCancel = useCallback(async () => {
    setBusy('cancelling');
    setErrorMessage('');
    try {
      await invoke('cancel_manual_long_capture');
      void getCurrentWindow().hide();
    } catch (error) {
      setBusy('idle');
      setErrorMessage(typeof error === 'string' ? error : String(error));
    }
  }, []);

  const count = preview?.count ?? 0;
  const previewSrc = preview
    ? `${convertFileSrc(preview.path)}?v=${preview.version}`
    : '';

  return (
    <div
      data-testid="longhud-root"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        borderRadius: 12,
        background: 'rgba(22, 18, 15, 0.96)',
        border: '1px solid rgba(255, 141, 92, 0.25)',
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.55)',
        color: '#f0f0f2',
        fontFamily: 'Inter, -apple-system, sans-serif',
        fontSize: 13,
      }}
    >
      <div
        data-testid="longhud-status"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 12, color: '#ff8d5c' }}>
          Long capture
        </span>
        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>
          Scroll the target window · {count} frame{count === 1 ? '' : 's'}
        </span>
      </div>
      <div
        ref={scrollRef}
        data-testid="longhud-preview-scroll"
        style={{
          flex: 1,
          overflow: 'auto',
          borderRadius: 8,
          background: 'rgba(0, 0, 0, 0.35)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          minHeight: 0,
        }}
      >
        {previewSrc ? (
          <img
            data-testid="longhud-preview-image"
            src={previewSrc}
            alt="Long screenshot preview"
            style={{
              display: 'block',
              width: '100%',
              height: 'auto',
            }}
          />
        ) : (
          <div
            data-testid="longhud-preview-empty"
            style={{
              padding: 16,
              color: 'rgba(255,255,255,0.5)',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            Scroll the target window to start capturing…
          </div>
        )}
      </div>
      <div
        data-testid="longhud-message"
        style={{
          minHeight: 16,
          color: errorMessage ? '#ff9b8b' : 'rgba(255,255,255,0.55)',
          fontSize: 11,
          lineHeight: 1.4,
        }}
      >
        {errorMessage ||
          'Scroll inside the content area. Fixed title bars and input bars are trimmed automatically.'}
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          data-testid="longhud-cancel"
          onClick={() => void handleCancel()}
          disabled={busy !== 'idle'}
          style={{
            padding: '6px 14px',
            height: 30,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 6,
            color: 'rgba(255,255,255,0.8)',
            fontSize: 12,
            cursor: busy !== 'idle' ? 'not-allowed' : 'pointer',
            opacity: busy !== 'idle' ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          Cancel
        </button>
        <button
          data-testid="longhud-save"
          onClick={() => void handleSave()}
          disabled={busy !== 'idle' || !preview}
          style={{
            padding: '6px 16px',
            height: 30,
            background: 'linear-gradient(135deg, #ff8d5c 0%, #d45a1e 100%)',
            border: 'none',
            borderRadius: 6,
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            cursor: busy !== 'idle' || !preview ? 'not-allowed' : 'pointer',
            opacity: busy !== 'idle' || !preview ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
