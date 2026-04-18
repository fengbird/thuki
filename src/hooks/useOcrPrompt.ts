import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { DEFAULT_OCR_PROMPT } from '../config/prompts';

interface OcrSettingsSnapshot {
  ocr_prompt?: string;
}

export function useOcrPrompt() {
  const [ocrPrompt, setOcrPrompt] = useState(DEFAULT_OCR_PROMPT);

  useEffect(() => {
    let cancelled = false;

    void invoke<OcrSettingsSnapshot | undefined>('get_settings')
      .then((settings) => {
        const next = settings?.ocr_prompt?.trim();
        if (!cancelled && next) {
          setOcrPrompt(next);
        }
      })
      .catch(() => {
        // Settings are optional here; keep the built-in fallback.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return ocrPrompt;
}
