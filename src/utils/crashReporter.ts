import { invoke } from '@tauri-apps/api/core';

/**
 * Payload contract mirrored on the Rust side (`crash_reporter.rs`
 * `FrontendErrorPayload`). Field names use snake_case so serde picks
 * them up without rename directives.
 */
export interface FrontendErrorPayload {
  kind: 'error' | 'unhandledrejection' | 'manual';
  message: string;
  stack?: string | null;
  source?: string | null;
  line?: number;
  column?: number;
  url?: string | null;
  user_agent?: string | null;
}

/**
 * Extracts a readable message + stack from anything the browser hands
 * us as an "error reason" — could be `Error`, a string, a plain object,
 * or something weirder. Pure helper (no I/O), exported for testing.
 */
export function extractErrorPayload(reason: unknown): {
  message: string;
  stack?: string;
} {
  if (reason instanceof Error) {
    return { message: reason.message || String(reason), stack: reason.stack };
  }
  if (typeof reason === 'string') return { message: reason };
  if (reason && typeof reason === 'object') {
    try {
      return { message: JSON.stringify(reason) };
    } catch {
      return { message: Object.prototype.toString.call(reason) };
    }
  }
  return { message: String(reason) };
}

/**
 * Installs `window` error / promise-rejection handlers that forward
 * everything to the Rust `report_frontend_error` command. Idempotent —
 * repeat calls replace the previous handlers. Returns a disposer.
 */
export function installGlobalErrorReporter(): () => void {
  const onError = (event: ErrorEvent) => {
    const { message, stack } = extractErrorPayload(
      event.error ?? event.message,
    );
    void invoke('report_frontend_error', {
      payload: {
        kind: 'error',
        message,
        stack: stack ?? null,
        source: event.filename || null,
        line: event.lineno || 0,
        column: event.colno || 0,
        url: typeof window !== 'undefined' ? window.location?.href : null,
        user_agent:
          typeof navigator !== 'undefined' ? navigator.userAgent : null,
      } satisfies FrontendErrorPayload,
    }).catch(() => {
      // Crash reporting is best-effort — swallow silently so we don't
      // trigger a feedback loop of errors about errors.
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const { message, stack } = extractErrorPayload(event.reason);
    void invoke('report_frontend_error', {
      payload: {
        kind: 'unhandledrejection',
        message,
        stack: stack ?? null,
        source: null,
        line: 0,
        column: 0,
        url: typeof window !== 'undefined' ? window.location?.href : null,
        user_agent:
          typeof navigator !== 'undefined' ? navigator.userAgent : null,
      } satisfies FrontendErrorPayload,
    }).catch(() => {
      // Best-effort, see onError.
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
