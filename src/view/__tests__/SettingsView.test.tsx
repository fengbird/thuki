import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SettingsView } from '../SettingsView';
import type { SettingsData } from '../../hooks/useSettings';
import { invoke } from '../../testUtils/mocks/tauri';

const MOCK_SETTINGS: SettingsData = {
  api_base_url: 'http://10.0.0.4:1234/v1',
  api_key: 'lm-studio',
  model_name: 'qwen3-vl-8b-thinking',
  system_prompt: 'Default system prompt',
  reply_prompt: 'Default reply prompt',
  ocr_prompt: '请提取图中所有文字，原样输出。',
  shortcut_config: {
    overlay_activation: { kind: 'double_tap_modifier', modifier: 'ctrl' },
    screenshot_capture: {
      kind: 'key_combo',
      key_code: 0x07,
      modifiers: ['cmd', 'shift'],
    },
  },
  commands_config: { overrides: {}, custom: [], disabled: [] },
};

/** Navigate to a sidebar tab after settings has loaded. */
async function switchTab(tab: 'model' | 'prompts' | 'shortcuts' | 'commands') {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`settings-tab-${tab}`));
  });
}

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

  it('Save invokes update_settings then calls onDismiss(true)', async () => {
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
    expect(onDismiss).toHaveBeenCalledWith(true);
  });

  it('Cancel calls onDismiss(false) without saving', async () => {
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
    expect(onDismiss).toHaveBeenCalledWith(false);
  });

  it('Esc key dismisses settings with false', async () => {
    const onDismiss = vi.fn();
    render(<SettingsView onDismiss={onDismiss} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onDismiss).toHaveBeenCalledWith(false);
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
    expect(onDismiss).toHaveBeenCalledWith(true);
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

  it('system, reply, and OCR prompt textareas are editable', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('prompts');

    const sysTa = screen.getByTestId(
      'settings-system-prompt',
    ) as HTMLTextAreaElement;
    const replyTa = screen.getByTestId(
      'settings-reply-prompt',
    ) as HTMLTextAreaElement;
    const ocrTa = screen.getByTestId(
      'settings-ocr-prompt',
    ) as HTMLTextAreaElement;

    expect(sysTa.value).toBe('Default system prompt');
    expect(replyTa.value).toBe('Default reply prompt');
    expect(ocrTa.value).toBe('请提取图中所有文字，原样输出。');

    await act(async () => {
      fireEvent.change(sysTa, { target: { value: 'New sys' } });
      fireEvent.change(replyTa, { target: { value: 'New reply' } });
      fireEvent.change(ocrTa, { target: { value: '只输出图片里的文本' } });
    });
    expect(sysTa.value).toBe('New sys');
    expect(replyTa.value).toBe('New reply');
    expect(ocrTa.value).toBe('只输出图片里的文本');
  });

  it('saving persists the OCR prompt field', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('prompts');

    await act(async () => {
      fireEvent.change(screen.getByTestId('settings-ocr-prompt'), {
        target: { value: '请按段落提取图片中的文字，不要解释。' },
      });
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.ocr_prompt).toBe(
      '请按段落提取图片中的文字，不要解释。',
    );
  });

  it('shows configurable shortcut defaults', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('shortcuts');

    expect(
      screen.getByTestId('settings-shortcut-activation-value').textContent,
    ).toBe('Double Control');
    expect(
      screen.getByTestId('settings-shortcut-screenshot-value').textContent,
    ).toBe('⌘⇧X');
  });

  it('records a new screenshot shortcut and saves it', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('shortcuts');

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('settings-shortcut-screenshot-record'),
      );
    });

    expect(
      screen.getByTestId('settings-shortcut-screenshot-hint').textContent,
    ).toContain('Press the full shortcut');

    await act(async () => {
      fireEvent.keyDown(window, {
        key: 'Z',
        code: 'KeyZ',
        metaKey: true,
        shiftKey: true,
      });
    });

    expect(
      screen.getByTestId('settings-shortcut-screenshot-value').textContent,
    ).toBe('⌘⇧Z');

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.shortcut_config?.screenshot_capture).toEqual({
      kind: 'key_combo',
      key_code: 0x06,
      modifiers: ['cmd', 'shift'],
    });
  });

  it('records a double-shift activation shortcut and can reset defaults', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('shortcuts');

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('settings-shortcut-activation-record'),
      );
    });

    await act(async () => {
      fireEvent.keyUp(window, { key: 'Shift' });
      fireEvent.keyUp(window, { key: 'Shift' });
    });

    expect(
      screen.getByTestId('settings-shortcut-activation-value').textContent,
    ).toBe('Double Shift');

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-shortcuts-reset-all'));
    });

    expect(
      screen.getByTestId('settings-shortcut-activation-value').textContent,
    ).toBe('Double Control');
    expect(
      screen.getByTestId('settings-shortcut-screenshot-value').textContent,
    ).toBe('⌘⇧X');
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

  // ─── Slash commands management tests ─────────────────────────────────

  it('renders sidebar with tabs', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});

    expect(screen.getByTestId('settings-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-model')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-prompts')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-commands')).toBeInTheDocument();
  });

  it('renders all commands in a unified list with edit and delete', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // /screen has been removed, so only the remaining commands appear here.
    expect(screen.queryByTestId('cmd-row-screen')).toBeNull();
    expect(screen.getByTestId('cmd-row-think')).toBeInTheDocument();
    expect(screen.getByTestId('cmd-row-translate')).toBeInTheDocument();

    // Each has toggle, edit, and delete
    expect(screen.getByTestId('cmd-row-think-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('cmd-row-think-edit')).toBeInTheDocument();
    expect(screen.getByTestId('cmd-row-think-delete')).toBeInTheDocument();
    expect(screen.getByTestId('cmd-row-translate-edit')).toBeInTheDocument();
    expect(screen.getByTestId('cmd-row-translate-delete')).toBeInTheDocument();
  });

  it('deleting a built-in command removes it from the list', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    expect(screen.getByTestId('cmd-row-think')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-think-delete'));
    });

    // Should be gone from the list
    expect(screen.queryByTestId('cmd-row-think')).toBeNull();

    // Save and verify it's in the disabled list
    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });
    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.commands_config.disabled).toContain('/think');
  });

  it('toggling a command removes it from the visible list', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    expect(screen.getByTestId('cmd-row-refine')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-refine-toggle'));
    });

    // Command should disappear (added to disabled list)
    expect(screen.queryByTestId('cmd-row-refine')).toBeNull();
  });

  it('clicking edit opens the edit panel for a built-in command', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // Panel not visible initially
    expect(screen.queryByTestId('cmd-edit-translate')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-translate-edit'));
    });

    expect(screen.getByTestId('cmd-edit-translate')).toBeInTheDocument();
    expect(
      screen.getByTestId('cmd-edit-translate-trigger'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('cmd-edit-translate-desc')).toBeInTheDocument();
    expect(
      screen.getByTestId('cmd-edit-translate-template'),
    ).toBeInTheDocument();
  });

  it('editing trigger/description/template creates an override', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // Open edit panel
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-translate-edit'));
    });

    const triggerInput = screen.getByTestId(
      'cmd-edit-translate-trigger',
    ) as HTMLInputElement;
    const descInput = screen.getByTestId(
      'cmd-edit-translate-desc',
    ) as HTMLInputElement;
    const templateTa = screen.getByTestId(
      'cmd-edit-translate-template',
    ) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(triggerInput, { target: { value: '/trans' } });
      fireEvent.change(descInput, { target: { value: 'Quick translate' } });
      fireEvent.change(templateTa, { target: { value: 'Translate: $INPUT' } });
    });

    expect(triggerInput.value).toBe('/trans');
    expect(descInput.value).toBe('Quick translate');
    expect(templateTa.value).toBe('Translate: $INPUT');

    // Save and verify the override is included
    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    const savedConfig = saveCall?.[1]?.data?.commands_config;
    expect(savedConfig.overrides['/translate'].trigger).toBe('/trans');
    expect(savedConfig.overrides['/translate'].description).toBe(
      'Quick translate',
    );
    expect(savedConfig.overrides['/translate'].prompt_template).toBe(
      'Translate: $INPUT',
    );
  });

  it('Reset Default removes override and closes edit panel', async () => {
    // Start with an existing override
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: {
            overrides: {
              '/translate': {
                trigger: '/trans',
                description: 'Modified',
                prompt_template: 'Custom',
              },
            },
            custom: [],
            disabled: [],
          },
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // Open edit panel
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-translate-edit'));
    });

    expect(screen.getByTestId('cmd-edit-translate-reset')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-edit-translate-reset'));
    });

    // Panel should be closed
    expect(screen.queryByTestId('cmd-edit-translate')).toBeNull();

    // Save and verify override is removed
    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    const savedConfig = saveCall?.[1]?.data?.commands_config;
    expect(savedConfig.overrides['/translate']).toBeUndefined();
  });

  it('Apply Changes on built-in saves settings and closes panel', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // Open edit panel
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-translate-edit'));
    });
    expect(screen.getByTestId('cmd-edit-translate-apply')).toBeInTheDocument();

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-edit-translate-apply'));
    });

    // Should save
    expect(invoke).toHaveBeenCalledWith(
      'update_settings',
      expect.objectContaining({ data: expect.any(Object) }),
    );
    // Panel should close
    expect(screen.queryByTestId('cmd-edit-translate')).toBeNull();
  });

  it('Apply Changes on custom command saves and closes panel', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: {
            overrides: {},
            custom: [
              {
                trigger: '/mycmd',
                description: 'My command',
                prompt_template: 'Do $INPUT',
              },
            ],
            disabled: [],
          },
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-custom-0-edit'));
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-custom-edit-0-apply'));
    });

    expect(invoke).toHaveBeenCalledWith(
      'update_settings',
      expect.objectContaining({ data: expect.any(Object) }),
    );
    expect(screen.queryByTestId('cmd-custom-edit-0')).toBeNull();
  });

  it('+ New Command adds a custom command', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // No custom commands initially
    expect(screen.queryByTestId('cmd-custom-0')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-add-btn'));
    });

    expect(screen.getByTestId('cmd-custom-0')).toBeInTheDocument();
    // Edit panel should open automatically
    expect(screen.getByTestId('cmd-custom-edit-0')).toBeInTheDocument();
  });

  it('custom command can be edited', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: {
            overrides: {},
            custom: [
              {
                trigger: '/mycmd',
                description: 'My command',
                prompt_template: 'Do $INPUT',
              },
            ],
            disabled: [],
          },
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    expect(screen.getByTestId('cmd-custom-0')).toBeInTheDocument();

    // Open edit
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-custom-0-edit'));
    });

    const triggerInput = screen.getByTestId(
      'cmd-custom-edit-0-trigger',
    ) as HTMLInputElement;
    expect(triggerInput.value).toBe('/mycmd');

    await act(async () => {
      fireEvent.change(triggerInput, { target: { value: '/mycommand' } });
    });
    expect(triggerInput.value).toBe('/mycommand');

    // Also edit description and template
    const descInput = screen.getByTestId(
      'cmd-custom-edit-0-desc',
    ) as HTMLInputElement;
    const templateTa = screen.getByTestId(
      'cmd-custom-edit-0-template',
    ) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(descInput, { target: { value: 'Updated desc' } });
      fireEvent.change(templateTa, { target: { value: 'Updated: $INPUT' } });
    });
    expect(descInput.value).toBe('Updated desc');
    expect(templateTa.value).toBe('Updated: $INPUT');

    // Close the edit panel by clicking edit again
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-custom-0-edit'));
    });
    expect(screen.queryByTestId('cmd-custom-edit-0')).toBeNull();
  });

  it('custom command can be deleted', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: {
            overrides: {},
            custom: [
              {
                trigger: '/mycmd',
                description: 'My command',
                prompt_template: 'Do $INPUT',
              },
            ],
            disabled: [],
          },
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    expect(screen.getByTestId('cmd-custom-0')).toBeInTheDocument();
    expect(screen.getByTestId('cmd-custom-0-delete')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-custom-0-delete'));
    });

    expect(screen.queryByTestId('cmd-custom-0')).toBeNull();
  });

  it('custom command can be toggled disabled', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: {
            overrides: {},
            custom: [
              {
                trigger: '/mycmd',
                description: 'My command',
                prompt_template: 'Do $INPUT',
              },
            ],
            disabled: [],
          },
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    const toggle = screen.getByTestId('cmd-custom-0-toggle');
    expect(toggle.style.background).toMatch(/22c55e|rgb\(34,\s*197,\s*94\)/);

    await act(async () => {
      fireEvent.click(toggle);
    });

    // Should now be disabled
    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.commands_config.disabled).toContain('/mycmd');
  });

  it('closing an edit panel by clicking edit again works', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // Open
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-rewrite-edit'));
    });
    expect(screen.getByTestId('cmd-edit-rewrite')).toBeInTheDocument();

    // Close
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-rewrite-edit'));
    });
    expect(screen.queryByTestId('cmd-edit-rewrite')).toBeNull();
  });

  it('disabled built-in saved to config includes the trigger', async () => {
    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // Disable /refine
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-refine-toggle'));
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.commands_config.disabled).toContain('/refine');
  });

  it('handles null commands_config gracefully', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: null,
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    // Should still render without errors
    expect(screen.getByTestId('settings-root')).toBeInTheDocument();
    expect(screen.getByTestId('cmd-row-translate')).toBeInTheDocument();
  });

  it('deleting a disabled custom command also removes it from disabled list', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: {
            overrides: {},
            custom: [
              {
                trigger: '/mycmd',
                description: 'My command',
                prompt_template: 'Do $INPUT',
              },
            ],
            disabled: ['/mycmd'],
          },
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-custom-0-delete'));
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(saveCall?.[1]?.data?.commands_config.disabled).not.toContain(
      '/mycmd',
    );
    expect(saveCall?.[1]?.data?.commands_config.custom).toHaveLength(0);
  });

  it('Reset Default on an overridden command clears the override', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings')
        return {
          ...MOCK_SETTINGS,
          commands_config: {
            overrides: {
              '/translate': { trigger: '/trans', description: 'Custom' },
            },
            custom: [],
            disabled: [],
          },
        };
    });

    render(<SettingsView onDismiss={vi.fn()} />);
    await act(async () => {});
    await switchTab('commands');

    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-row-translate-edit'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cmd-edit-translate-reset'));
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-save-btn'));
    });

    const saveCall = invoke.mock.calls.find(
      ([cmd]) => cmd === 'update_settings',
    );
    expect(
      saveCall?.[1]?.data?.commands_config.overrides['/translate'],
    ).toBeUndefined();
  });
});
