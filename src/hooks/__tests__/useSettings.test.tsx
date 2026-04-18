import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettings } from '../useSettings';
import { invoke } from '../../testUtils/mocks/tauri';

const MOCK_SETTINGS = {
  api_base_url: 'http://10.0.0.4:1234/v1',
  api_key: 'lm-studio',
  model_name: 'qwen3-vl-8b-thinking',
  system_prompt: 'Be helpful.',
  reply_prompt: 'Reply concisely.',
  ocr_prompt: '请提取图中所有文字，原样输出。',
  commands_config: { overrides: {}, custom: [], disabled: [] },
};

describe('useSettings', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
    });
  });

  it('fetches settings on mount and exposes them', async () => {
    const { result } = renderHook(() => useSettings());
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('get_settings');
    expect(result.current.settings).toEqual(MOCK_SETTINGS);
    expect(result.current.isLoading).toBe(false);
  });

  it('save() invokes update_settings and updates local state', async () => {
    const { result } = renderHook(() => useSettings());
    await act(async () => {});

    const updated = { ...MOCK_SETTINGS, model_name: 'new-model' };
    await act(async () => {
      await result.current.save(updated);
    });
    expect(invoke).toHaveBeenCalledWith('update_settings', { data: updated });
    expect(result.current.settings?.model_name).toBe('new-model');
  });

  it('save() surfaces string error when invoke rejects with string', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'update_settings') throw 'DB write failed';
    });

    const { result } = renderHook(() => useSettings());
    await act(async () => {});

    await act(async () => {
      await result.current.save(MOCK_SETTINGS);
    });
    expect(result.current.saveError).toBe('DB write failed');
  });

  it('save() surfaces non-string error via String()', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'update_settings') throw new Error('boom');
    });

    const { result } = renderHook(() => useSettings());
    await act(async () => {});

    await act(async () => {
      await result.current.save(MOCK_SETTINGS);
    });
    expect(result.current.saveError).toContain('boom');
  });

  it('testConnection() returns models on success', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'test_api_connection')
        return { data: [{ id: 'model-a' }, { id: 'model-b' }] };
    });

    const { result } = renderHook(() => useSettings());
    await act(async () => {});

    await act(async () => {
      await result.current.testConnection('http://x', 'key');
    });
    expect(invoke).toHaveBeenCalledWith('test_api_connection', {
      baseUrl: 'http://x',
      apiKey: 'key',
    });
    expect(result.current.testResult?.ok).toBe(true);
    expect(result.current.testResult?.models).toEqual(['model-a', 'model-b']);
  });

  it('testConnection() surfaces string error on failure', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'test_api_connection') throw 'Connection refused';
    });

    const { result } = renderHook(() => useSettings());
    await act(async () => {});

    await act(async () => {
      await result.current.testConnection('http://x', 'key');
    });
    expect(result.current.testResult?.ok).toBe(false);
    expect(result.current.testResult?.error).toBe('Connection refused');
  });

  it('testConnection() surfaces non-string error via String()', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'test_api_connection') throw { code: 42 };
    });

    const { result } = renderHook(() => useSettings());
    await act(async () => {});

    await act(async () => {
      await result.current.testConnection('http://x', 'key');
    });
    expect(result.current.testResult?.ok).toBe(false);
    expect(result.current.testResult?.error).toContain('object');
  });

  it('testConnection() handles response without data array', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'test_api_connection') return {};
    });

    const { result } = renderHook(() => useSettings());
    await act(async () => {});

    await act(async () => {
      await result.current.testConnection('http://x', 'key');
    });
    expect(result.current.testResult?.ok).toBe(true);
    expect(result.current.testResult?.models).toEqual([]);
  });
});
