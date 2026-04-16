import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SettingsView } from '../SettingsView';
import { invoke } from '../../testUtils/mocks/tauri';

const MOCK_SETTINGS = {
  api_base_url: 'http://10.0.0.4:1234/v1',
  api_key: 'lm-studio',
  model_name: 'qwen3-vl-8b-thinking',
  system_prompt: 'Default system prompt',
  reply_prompt: 'Default reply prompt',
  command_prompts: {},
};

describe('SettingsView', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
    });
  });

  it('shows loading state then renders the form', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    expect(screen.getByTestId('settings-loading')).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByTestId('settings-root')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-loading')).toBeNull();
  });

  it('populates fields from loaded settings', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    expect(
      (screen.getByTestId('settings-base-url') as HTMLInputElement).value,
    ).toBe('http://10.0.0.4:1234/v1');
    expect(
      (screen.getByTestId('settings-model') as HTMLInputElement).value,
    ).toBe('qwen3-vl-8b-thinking');
  });

  it('Save invokes update_settings then calls onDismiss', async () => {
    const onDismiss = vi.fn();
    render(<SettingsView onDismiss={onDismiss} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    expect(invoke).toHaveBeenCalledWith(
      'update_settings',
      expect.objectContaining({ data: expect.any(Object) }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Cancel calls onDismiss without saving', async () => {
    const onDismiss = vi.fn();
    render(<SettingsView onDismiss={onDismiss} />);
    await act(async () => {});

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-cancel-btn'));
    });

    const updateCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(updateCalls).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Esc key dismisses settings', async () => {
    const onDismiss = vi.fn();
    render(<SettingsView onDismiss={onDismiss} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Cmd+S saves settings', async () => {
    const onDismiss = vi.fn();
    render(<SettingsView onDismiss={onDismiss} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.keyDown(window, { key: 's', metaKey: true });
    });
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith(
      'update_settings',
      expect.objectContaining({ data: expect.any(Object) }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('editing API base URL and API key updates the draft', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    const urlInput = screen.getByTestId(
      'settings-base-url',
    ) as HTMLInputElement;
    const keyInput = screen.getByTestId('settings-api-key') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'http://new:9000/v1' } });
      fireEvent.change(keyInput, { target: { value: 'sk-new' } });
    });
    expect(urlInput.value).toBe('http://new:9000/v1');
    expect(keyInput.value).toBe('sk-new');
  });

  it('editing a field updates the draft', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    const input = screen.getByTestId('settings-model') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'llama3.1-8b' } });
    });
    expect(input.value).toBe('llama3.1-8b');

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });
    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.model_name).toBe('llama3.1-8b');
  });

  it('Test Connection button triggers test_api_connection', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'test_api_connection') return { data: [{ id: 'model-x' }] };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-test-btn'));
    });
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith('test_api_connection', {
      baseUrl: 'http://10.0.0.4:1234/v1',
      apiKey: 'lm-studio',
    });
    expect(screen.getByTestId('settings-test-result').textContent).toContain(
      'Connected',
    );
  });

  it('Test Connection shows error on failure', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'test_api_connection') throw 'Timeout';
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-test-btn'));
    });
    await act(async () => {});

    expect(screen.getByTestId('settings-test-result').textContent).toContain(
      'Timeout',
    );
  });

  it('shows save error when update_settings rejects', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { ...MOCK_SETTINGS };
      if (cmd === 'update_settings') throw 'DB write failed';
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });
    await act(async () => {});

    expect(screen.getByTestId('settings-save-error').textContent).toContain(
      'DB write failed',
    );
  });

  it('renders slash-command prompt textareas', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    // /translate, /rewrite, /tldr, /refine, /bullets, /todos = 6
    expect(screen.getByTestId('settings-cmd-translate')).toBeInTheDocument();
    expect(screen.getByTestId('settings-cmd-rewrite')).toBeInTheDocument();
    expect(screen.getByTestId('settings-cmd-tldr')).toBeInTheDocument();
    expect(screen.getByTestId('settings-cmd-refine')).toBeInTheDocument();
    expect(screen.getByTestId('settings-cmd-bullets')).toBeInTheDocument();
    expect(screen.getByTestId('settings-cmd-todos')).toBeInTheDocument();
  });

  it('editing a command prompt and saving includes the override', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    const textarea = screen.getByTestId(
      'settings-cmd-translate',
    ) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Custom translate' } });
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });
    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.command_prompts?.['/translate']).toBe(
      'Custom translate',
    );
  });

  it('system prompt and reply prompt textareas are editable', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    const sysTa = screen.getByTestId(
      'settings-system-prompt',
    ) as HTMLTextAreaElement;
    const replyTa = screen.getByTestId(
      'settings-reply-prompt',
    ) as HTMLTextAreaElement;

    expect(sysTa.value).toBe('Default system prompt');
    expect(replyTa.value).toBe('Default reply prompt');

    await act(async () => {
      fireEvent.change(sysTa, { target: { value: 'New sys' } });
      fireEvent.change(replyTa, { target: { value: 'New reply' } });
    });
    expect(sysTa.value).toBe('New sys');
    expect(replyTa.value).toBe('New reply');
  });

  it('unregisters keydown listener on unmount', async () => {
    const { unmount } = render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    unmount();

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', metaKey: true });
    });
    const saveCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCalls).toHaveLength(0);
  });
});
