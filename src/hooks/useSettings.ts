import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import type { CommandsConfig } from '../config/commands';
import type { ShortcutConfig } from '../config/shortcuts';

/**
 * Mirrors the Rust `SettingsData` struct. All fields arrive as-is from
 * `get_settings` and are sent back verbatim to `update_settings`.
 */
export interface SettingsData {
  api_base_url: string;
  api_key: string;
  model_name: string;
  system_prompt: string;
  reply_prompt: string;
  ocr_prompt: string;
  shortcut_config: ShortcutConfig;
  /** Slash command configuration: overrides, custom commands, disabled list. */
  commands_config: CommandsConfig;
  /** Cap on non-pinned clipboard history entries (pinned items are always kept). */
  clipboard_max_entries: number;
  /**
   * Slash-command triggers (e.g. `/tldr`, `/translate`) rendered as
   * AI Action tiles in the clipboard history panel. Order in the array
   * is the render order.
   */
  clipboard_ai_actions: string[];
}

/** Defaults mirrored from `settings.rs` `DEFAULT_CLIPBOARD_AI_ACTIONS`. */
export const DEFAULT_CLIPBOARD_AI_ACTIONS: string[] = [
  '/tldr',
  '/translate',
  '/rewrite',
];

/** Keep these in sync with `settings.rs` `*_CLIPBOARD_MAX_ENTRIES` constants. */
export const CLIPBOARD_MAX_ENTRIES_DEFAULT = 200;
export const CLIPBOARD_MAX_ENTRIES_MIN = 10;
export const CLIPBOARD_MAX_ENTRIES_MAX = 10000;

export interface ConnectionTestResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/**
 * Hook that manages the lifecycle of reading, editing, and persisting
 * the application settings. Settings are fetched from the Rust backend
 * on mount and written back via `save`.
 */
export function useSettings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
    null,
  );
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    void invoke<SettingsData>('get_settings').then((data) => {
      setSettings(data);
      setIsLoading(false);
    });
  }, []);

  const save = useCallback(async (data: SettingsData) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await invoke('update_settings', { data });
      setSettings(data);
    } catch (e) {
      setSaveError(typeof e === 'string' ? e : String(e));
    } finally {
      setIsSaving(false);
    }
  }, []);

  const testConnection = useCallback(
    async (baseUrl: string, apiKey: string) => {
      setIsTesting(true);
      setTestResult(null);
      try {
        const body = await invoke<{ data?: { id: string }[] }>(
          'test_api_connection',
          { baseUrl, apiKey },
        );
        const models = (body?.data ?? []).map((m) => m.id);
        setTestResult({ ok: true, models });
      } catch (e) {
        setTestResult({
          ok: false,
          models: [],
          error: typeof e === 'string' ? e : String(e),
        });
      } finally {
        setIsTesting(false);
      }
    },
    [],
  );

  return {
    settings,
    isLoading,
    isSaving,
    saveError,
    testResult,
    isTesting,
    save,
    testConnection,
    setTestResult,
  };
}
