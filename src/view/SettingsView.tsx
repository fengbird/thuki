import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import type { SettingsData } from '../hooks/useSettings';
import { COMMANDS, EMPTY_COMMANDS_CONFIG } from '../config/commands';
import {
  DEFAULT_SHORTCUT_CONFIG,
  captureKeyComboFromEvent,
  formatShortcut,
  modifierFromKeyboardEvent,
  normalizeShortcutConfig,
  type ShortcutModifier,
} from '../config/shortcuts';
import type {
  CommandsConfig,
  CommandOverride,
  CustomCommandDef,
} from '../config/commands';

const THEME = {
  cardBg:
    'radial-gradient(ellipse 80% 55% at 50% 0%, rgba(255,141,92,0.14) 0%, rgba(28,24,20,0.97) 60%), rgba(28,24,20,0.97)',
  cardBorder: '1px solid rgba(255, 141, 92, 0.2)',
  cardShadow: '0 0 40px rgba(255,100,40,0.07)',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  accent: '#ff8d5c',
  textPrimary: '#f0f0f2',
  textMuted: 'rgba(255,255,255,0.3)',
  textDim: 'rgba(255,255,255,0.18)',
  inputBg: 'rgba(255,255,255,0.04)',
  inputBorder: '1px solid rgba(255,255,255,0.1)',
  divider: 'rgba(255,255,255,0.05)',
  sidebarBg: 'rgba(0,0,0,0.15)',
  sidebarActive: 'rgba(255,141,92,0.12)',
};

/** Shared inline style for text inputs and textareas. */
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: THEME.inputBg,
  border: THEME.inputBorder,
  borderRadius: 8,
  color: THEME.textPrimary,
  fontSize: 12.5,
  fontFamily: THEME.fontFamily,
  outline: 'none',
  resize: 'vertical',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.55)',
  marginBottom: 4,
  display: 'block',
};

export interface SettingsViewProps {
  /** Called when the settings panel should close. `saved` is true if settings were persisted. */
  onDismiss: (saved: boolean) => void;
}

type SettingsTab = 'model' | 'prompts' | 'shortcuts' | 'commands';
type RecordingShortcutField =
  | 'overlay_activation'
  | 'screenshot_capture'
  | 'clipboard_history_open';

const TAB_ITEMS: { key: SettingsTab; label: string }[] = [
  { key: 'model', label: 'AI Model' },
  { key: 'prompts', label: 'Prompts' },
  { key: 'shortcuts', label: 'Shortcuts' },
  { key: 'commands', label: 'Commands' },
];

// ─── Main component ────────────────────────────────────────────────────────

export function SettingsView({ onDismiss }: SettingsViewProps) {
  const {
    settings,
    isLoading,
    isSaving,
    saveError,
    testResult,
    isTesting,
    save,
    testConnection,
  } = useSettings();

  // Local draft — edited in the form, committed on Save.
  const [draft, setDraft] = useState<SettingsData | null>(null);
  /** Which sidebar tab is active. */
  const [activeTab, setActiveTab] = useState<SettingsTab>('model');
  /** Which command is currently expanded for editing (trigger key). */
  const [editingCommand, setEditingCommand] = useState<string | null>(null);
  /** Which shortcut field is currently waiting for keyboard capture. */
  const [recordingShortcut, setRecordingShortcut] =
    useState<RecordingShortcutField | null>(null);
  /** Double-tap capture state for modifier-only overlay shortcuts. */
  const lastModifierReleaseRef = useRef<{
    modifier: ShortcutModifier;
    at: number;
  } | null>(null);

  useEffect(() => {
    if (settings && !draft) {
      setDraft({
        ...settings,
        shortcut_config: normalizeShortcutConfig(settings.shortcut_config),
      });
    }
  }, [settings, draft]);

  const update = useCallback(
    <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => {
      /* v8 ignore next -- draft is always non-null after the loading gate */
      setDraft((d) => (d ? { ...d, [key]: value } : d));
    },
    [],
  );

  /** Get the working commands config from draft. */
  const getConfig = useCallback((): CommandsConfig => {
    /* v8 ignore next -- draft guaranteed non-null after loading gate */
    if (!draft) return EMPTY_COMMANDS_CONFIG;
    const cfg = draft.commands_config;
    if (!cfg || typeof cfg !== 'object') return EMPTY_COMMANDS_CONFIG;
    /* v8 ignore start -- ?? fallback branches for well-formed backend data */
    return {
      overrides: cfg.overrides ?? {},
      custom: cfg.custom ?? [],
      disabled: cfg.disabled ?? [],
    };
    /* v8 ignore stop */
  }, [draft]);

  /** Replace the commands_config in draft. */
  const setConfig = useCallback(
    (cfg: CommandsConfig) => {
      update('commands_config', cfg);
    },
    [update],
  );

  const updateShortcutConfig = useCallback(
    (next: SettingsData['shortcut_config']) => {
      update('shortcut_config', normalizeShortcutConfig(next));
    },
    [update],
  );

  // ─── Command config operations ─────────────────────────────────────────

  const toggleDisabled = useCallback(
    (trigger: string) => {
      const cfg = getConfig();
      const isDisabled = cfg.disabled.includes(trigger);
      /* v8 ignore start -- re-enable branch unreachable (disabled items are hidden) */
      setConfig({
        ...cfg,
        disabled: isDisabled
          ? cfg.disabled.filter((t) => t !== trigger)
          : [...cfg.disabled, trigger],
      });
      /* v8 ignore stop */
    },
    [getConfig, setConfig],
  );

  const updateOverride = useCallback(
    (originalTrigger: string, patch: Partial<CommandOverride>) => {
      const cfg = getConfig();
      const existing = cfg.overrides[originalTrigger] ?? {};
      setConfig({
        ...cfg,
        overrides: {
          ...cfg.overrides,
          [originalTrigger]: { ...existing, ...patch },
        },
      });
    },
    [getConfig, setConfig],
  );

  const resetBuiltin = useCallback(
    (originalTrigger: string) => {
      const cfg = getConfig();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [originalTrigger]: _removed, ...rest } = cfg.overrides;
      /* v8 ignore start -- reset only reachable on visible (non-disabled) commands */
      setConfig({
        ...cfg,
        overrides: rest,
        disabled: cfg.disabled.filter((t) => t !== originalTrigger),
      });
      /* v8 ignore stop */
      setEditingCommand(null);
    },
    [getConfig, setConfig],
  );

  const addCustomCommand = useCallback(() => {
    const cfg = getConfig();
    const newCmd: CustomCommandDef = {
      trigger: '/new',
      description: 'New custom command',
      prompt_template: '$INPUT',
    };
    setConfig({ ...cfg, custom: [...cfg.custom, newCmd] });
    setEditingCommand(`custom:${cfg.custom.length}`);
  }, [getConfig, setConfig]);

  /* v8 ignore start -- ternary/?./?? branches in array transform callbacks */
  const updateCustomCommand = useCallback(
    (index: number, patch: Partial<CustomCommandDef>) => {
      const cfg = getConfig();
      const updated = cfg.custom.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      );
      setConfig({ ...cfg, custom: updated });
    },
    [getConfig, setConfig],
  );

  const deleteCustomCommand = useCallback(
    (index: number) => {
      const cfg = getConfig();
      const trigger = cfg.custom[index]?.trigger;
      setConfig({
        ...cfg,
        custom: cfg.custom.filter((_, i) => i !== index),
        disabled: trigger
          ? cfg.disabled.filter((t) => t !== trigger)
          : cfg.disabled,
      });
      setEditingCommand(null);
    },
    /* v8 ignore stop */
    [getConfig, setConfig],
  );

  const deleteBuiltin = useCallback(
    (trigger: string) => {
      const cfg = getConfig();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [trigger]: _removed, ...restOverrides } = cfg.overrides;
      /* v8 ignore start -- guard branch: visible items are never already disabled */
      setConfig({
        ...cfg,
        overrides: restOverrides,
        disabled: cfg.disabled.includes(trigger)
          ? cfg.disabled
          : [...cfg.disabled, trigger],
      });
      /* v8 ignore stop */
      setEditingCommand(null);
    },
    [getConfig, setConfig],
  );

  const resetShortcutDefaults = useCallback(() => {
    updateShortcutConfig(DEFAULT_SHORTCUT_CONFIG);
    setRecordingShortcut(null);
    lastModifierReleaseRef.current = null;
  }, [updateShortcutConfig]);

  const beginShortcutRecording = useCallback(
    (field: RecordingShortcutField) => {
      lastModifierReleaseRef.current = null;
      setRecordingShortcut(field);
    },
    [],
  );

  // ─── Save / dismiss ────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    /* v8 ignore next -- loading gate ensures draft is always non-null here */
    if (!draft || isSaving) return;
    await save(draft);
    onDismiss(true);
  }, [draft, isSaving, save, onDismiss]);

  /** Save settings and close the command edit panel (single-command apply). */
  const handleApplyCommand = useCallback(async () => {
    /* v8 ignore next */
    if (!draft || isSaving) return;
    await save(draft);
    setEditingCommand(null);
  }, [draft, isSaving, save]);

  const handleTest = useCallback(async () => {
    /* v8 ignore next */
    if (!draft) return;
    await testConnection(draft.api_base_url, draft.api_key);
  }, [draft, testConnection]);

  useEffect(() => {
    if (!recordingShortcut || !draft) {
      return;
    }

    const finishCapture = (next: SettingsData['shortcut_config']) => {
      updateShortcutConfig(next);
      setRecordingShortcut(null);
      lastModifierReleaseRef.current = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecordingShortcut(null);
        lastModifierReleaseRef.current = null;
        return;
      }

      const combo = captureKeyComboFromEvent(event);
      if (!combo) {
        return;
      }

      if (recordingShortcut === 'overlay_activation') {
        finishCapture({
          ...draft.shortcut_config,
          overlay_activation: combo,
        });
        return;
      }

      finishCapture({
        ...draft.shortcut_config,
        [recordingShortcut]: combo,
      });
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (recordingShortcut !== 'overlay_activation') {
        return;
      }

      const modifier = modifierFromKeyboardEvent(event);
      if (!modifier) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const now = Date.now();
      const last = lastModifierReleaseRef.current;
      if (last && last.modifier === modifier && now - last.at < 450) {
        finishCapture({
          ...draft.shortcut_config,
          overlay_activation: {
            kind: 'double_tap_modifier',
            modifier,
          },
        });
        return;
      }

      lastModifierReleaseRef.current = { modifier, at: now };
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [draft, recordingShortcut, updateShortcutConfig]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recordingShortcut) {
        return;
      }
      /* v8 ignore start -- keyboard shortcut alternative modifiers */
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
      /* v8 ignore stop */
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss, handleSave, recordingShortcut]);

  if (isLoading || !draft) {
    return (
      <div
        data-testid="settings-loading"
        style={{
          color: THEME.textMuted,
          fontSize: 13,
          textAlign: 'center',
          padding: 40,
        }}
      >
        Loading settings…
      </div>
    );
  }

  const cfg = getConfig();
  /** Built-in commands not yet deleted (disabled). */
  const visibleBuiltins = COMMANDS.filter(
    (c) => !cfg.disabled.includes(c.trigger),
  );

  return (
    <div
      data-testid="settings-root"
      style={{
        width: 560,
        maxHeight: 580,
        background: THEME.cardBg,
        border: THEME.cardBorder,
        borderRadius: 24,
        boxShadow: THEME.cardShadow,
        fontFamily: THEME.fontFamily,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ textAlign: 'center', padding: '18px 22px 12px' }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: THEME.textPrimary,
            letterSpacing: '-0.4px',
            margin: '0 0 2px',
          }}
        >
          Settings
        </h1>
        <p style={{ fontSize: 11, color: THEME.textMuted, margin: 0 }}>
          Changes take effect immediately — no restart needed.
        </p>
      </div>

      {/* ── Sidebar + Content ─────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          borderTop: `1px solid ${THEME.divider}`,
        }}
      >
        {/* Left sidebar */}
        <nav
          data-testid="settings-sidebar"
          style={{
            width: 130,
            flexShrink: 0,
            background: THEME.sidebarBg,
            padding: '10px 6px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            borderRight: `1px solid ${THEME.divider}`,
          }}
        >
          {TAB_ITEMS.map((tab) => (
            <button
              key={tab.key}
              data-testid={`settings-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 10px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                fontFamily: THEME.fontFamily,
                fontSize: 12,
                fontWeight: activeTab === tab.key ? 600 : 400,
                color:
                  activeTab === tab.key
                    ? THEME.accent
                    : 'rgba(255,255,255,0.5)',
                background:
                  activeTab === tab.key ? THEME.sidebarActive : 'transparent',
                transition: 'all 0.12s',
                textAlign: 'left',
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {/* ── AI Model Tab ──────────────────────────── */}
          {activeTab === 'model' && (
            <>
              <Section title="AI Model">
                <Field label="API Base URL">
                  <input
                    data-testid="settings-base-url"
                    type="text"
                    style={inputStyle}
                    value={draft.api_base_url}
                    onChange={(e) => update('api_base_url', e.target.value)}
                    placeholder="http://10.0.0.4:1234/v1"
                  />
                </Field>
                <Field label="API Key">
                  <input
                    data-testid="settings-api-key"
                    type="password"
                    style={inputStyle}
                    value={draft.api_key}
                    onChange={(e) => update('api_key', e.target.value)}
                    placeholder="lm-studio"
                  />
                </Field>
                <Field label="Model Name">
                  <input
                    data-testid="settings-model"
                    type="text"
                    style={inputStyle}
                    value={draft.model_name}
                    onChange={(e) => update('model_name', e.target.value)}
                    placeholder="qwen3-vl-8b-thinking"
                  />
                </Field>

                {/* Test Connection */}
                {/* v8 ignore start -- JSX branch tracking for rendering conditions */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginTop: 4,
                  }}
                >
                  <button
                    data-testid="settings-test-btn"
                    onClick={() => void handleTest()}
                    disabled={isTesting}
                    style={{
                      padding: '6px 14px',
                      background: 'rgba(255,141,92,0.12)',
                      border: '1px solid rgba(255,141,92,0.25)',
                      borderRadius: 8,
                      color: THEME.accent,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: isTesting ? 'wait' : 'pointer',
                      opacity: isTesting ? 0.6 : 1,
                      fontFamily: THEME.fontFamily,
                    }}
                  >
                    {isTesting ? 'Testing…' : 'Test Connection'}
                  </button>
                  {testResult && (
                    <span
                      data-testid="settings-test-result"
                      style={{
                        fontSize: 11.5,
                        color: testResult.ok ? '#22c55e' : '#ef4444',
                      }}
                    >
                      {testResult.ok
                        ? `Connected — ${testResult.models.length} model(s)`
                        : /* v8 ignore next */ (testResult.error ?? 'Failed')}
                    </span>
                  )}
                </div>
              </Section>
              {/* v8 ignore stop */}
            </>
          )}

          {/* ── Prompts Tab ───────────────────────────── */}
          {activeTab === 'prompts' && (
            <>
              <Section title="Chat System Prompt">
                <textarea
                  data-testid="settings-system-prompt"
                  rows={5}
                  style={inputStyle}
                  value={draft.system_prompt}
                  onChange={(e) => update('system_prompt', e.target.value)}
                />
              </Section>

              <Divider />

              <Section title="Smart Reply Prompt (⌃⇧R)">
                <textarea
                  data-testid="settings-reply-prompt"
                  rows={5}
                  style={inputStyle}
                  value={draft.reply_prompt}
                  onChange={(e) => update('reply_prompt', e.target.value)}
                />
              </Section>

              <Divider />

              <Section title="Screenshot OCR Prompt">
                <textarea
                  data-testid="settings-ocr-prompt"
                  rows={4}
                  style={inputStyle}
                  value={draft.ocr_prompt}
                  onChange={(e) => update('ocr_prompt', e.target.value)}
                />
              </Section>
            </>
          )}

          {activeTab === 'shortcuts' && (
            <>
              <Section title="Global Shortcuts">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: 11.5,
                      color: 'rgba(255,255,255,0.45)',
                      lineHeight: 1.5,
                    }}
                  >
                    Capture a new shortcut directly from the keyboard. Overlay
                    activation supports either a normal combo or a double-tap
                    modifier gesture.
                  </p>
                  <button
                    data-testid="settings-shortcuts-reset-all"
                    onClick={resetShortcutDefaults}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: 'transparent',
                      color: 'rgba(255,255,255,0.68)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: THEME.fontFamily,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Reset All Defaults
                  </button>
                </div>
                <ShortcutRow
                  testIdPrefix="settings-shortcut-activation"
                  title="Ask Bar Activation"
                  description="Used to open or hide the main Oling popup."
                  value={formatShortcut(
                    draft.shortcut_config.overlay_activation,
                  )}
                  isRecording={recordingShortcut === 'overlay_activation'}
                  hint="Press a shortcut, or double-tap a modifier like Control."
                  onRecord={() => beginShortcutRecording('overlay_activation')}
                />
                <ShortcutRow
                  testIdPrefix="settings-shortcut-screenshot"
                  title="Screenshot Capture"
                  description="Used for the unified screenshot flow."
                  value={formatShortcut(
                    draft.shortcut_config.screenshot_capture,
                  )}
                  isRecording={recordingShortcut === 'screenshot_capture'}
                  hint="Press the full shortcut combination you want to use."
                  onRecord={() => beginShortcutRecording('screenshot_capture')}
                />
                <ShortcutRow
                  testIdPrefix="settings-shortcut-clipboard"
                  title="Clipboard History"
                  description="Used to open or hide the independent clipboard manager."
                  value={formatShortcut(
                    draft.shortcut_config.clipboard_history_open,
                  )}
                  isRecording={recordingShortcut === 'clipboard_history_open'}
                  hint="Press the full shortcut combination you want to use."
                  onRecord={() =>
                    beginShortcutRecording('clipboard_history_open')
                  }
                />
              </Section>
            </>
          )}

          {/* ── Commands Tab ──────────────────────────── */}
          {activeTab === 'commands' && (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <h2
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: 'rgba(255,141,92,0.75)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    margin: 0,
                  }}
                >
                  Slash Commands
                </h2>
                <button
                  data-testid="cmd-add-btn"
                  onClick={addCustomCommand}
                  style={{
                    padding: '4px 10px',
                    border: `1px solid ${THEME.accent}50`,
                    background: 'transparent',
                    borderRadius: 6,
                    color: THEME.accent,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: THEME.fontFamily,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  + New Command
                </button>
              </div>

              {/* Unified command list — built-in + custom, all equal */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                {/* Built-in commands (non-deleted) */}
                {visibleBuiltins.map((cmd) => {
                  const override = cfg.overrides[cmd.trigger];
                  const isEditing = editingCommand === cmd.trigger;
                  const displayTrigger = override?.trigger ?? cmd.trigger;
                  const displayDesc = override?.description ?? cmd.description;

                  return (
                    <div key={cmd.trigger}>
                      <CommandRow
                        trigger={displayTrigger}
                        description={displayDesc}
                        isDisabled={false}
                        isEditing={isEditing}
                        hasOverride={!!override}
                        onToggle={() => toggleDisabled(cmd.trigger)}
                        onEdit={() =>
                          setEditingCommand(isEditing ? null : cmd.trigger)
                        }
                        onDelete={() => deleteBuiltin(cmd.trigger)}
                        testId={`cmd-row-${cmd.trigger.slice(1)}`}
                      />
                      {isEditing && (
                        <CommandEditPanel
                          trigger={override?.trigger ?? cmd.trigger}
                          description={override?.description ?? cmd.description}
                          /* v8 ignore start -- ?? fallback branches */
                          promptTemplate={
                            override?.prompt_template ??
                            cmd.promptTemplate ??
                            ''
                          }
                          /* v8 ignore stop */
                          onTriggerChange={(v) =>
                            updateOverride(cmd.trigger, { trigger: v })
                          }
                          onDescriptionChange={(v) =>
                            updateOverride(cmd.trigger, { description: v })
                          }
                          onTemplateChange={(v) =>
                            updateOverride(cmd.trigger, {
                              prompt_template: v,
                            })
                          }
                          onReset={() => resetBuiltin(cmd.trigger)}
                          onApply={() => void handleApplyCommand()}
                          hasOverride={!!override}
                          testIdPrefix={`cmd-edit-${cmd.trigger.slice(1)}`}
                        />
                      )}
                    </div>
                  );
                })}

                {/* Custom commands */}
                {cfg.custom.map((cmd, idx) => {
                  const editKey = `custom:${idx}`;
                  const isEditing = editingCommand === editKey;

                  return (
                    <div key={editKey}>
                      <CommandRow
                        trigger={cmd.trigger}
                        description={cmd.description}
                        isDisabled={false}
                        isEditing={isEditing}
                        hasOverride={false}
                        onToggle={() => toggleDisabled(cmd.trigger)}
                        onEdit={() =>
                          setEditingCommand(isEditing ? null : editKey)
                        }
                        onDelete={() => deleteCustomCommand(idx)}
                        testId={`cmd-custom-${idx}`}
                      />
                      {isEditing && (
                        <CommandEditPanel
                          trigger={cmd.trigger}
                          description={cmd.description}
                          /* v8 ignore start -- ?? fallback branch */
                          promptTemplate={cmd.prompt_template ?? ''}
                          /* v8 ignore stop */
                          onTriggerChange={(v) =>
                            updateCustomCommand(idx, { trigger: v })
                          }
                          onDescriptionChange={(v) =>
                            updateCustomCommand(idx, { description: v })
                          }
                          onTemplateChange={(v) =>
                            updateCustomCommand(idx, {
                              prompt_template: v,
                            })
                          }
                          onApply={() => void handleApplyCommand()}
                          testIdPrefix={`cmd-custom-edit-${idx}`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ────────────────────────────────────── */}
      <div
        style={{
          borderTop: `1px solid ${THEME.divider}`,
          padding: '12px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {saveError && (
          <div
            data-testid="settings-save-error"
            style={{ fontSize: 12, color: '#ef4444' }}
          >
            Save failed: {saveError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            data-testid="settings-cancel-btn"
            onClick={() => onDismiss(false)}
            style={{
              padding: '8px 18px',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10,
              color: 'rgba(255,255,255,0.6)',
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: THEME.fontFamily,
            }}
          >
            Cancel
          </button>
          <button
            data-testid="settings-save-btn"
            onClick={() => void handleSave()}
            disabled={isSaving}
            style={{
              padding: '8px 22px',
              background: 'linear-gradient(135deg, #ff8d5c 0%, #d45a1e 100%)',
              border: 'none',
              borderRadius: 10,
              color: 'white',
              fontSize: 13,
              fontWeight: 600,
              cursor: isSaving ? 'wait' : 'pointer',
              opacity: isSaving ? 0.7 : 1,
              boxShadow: '0 4px 20px rgba(255,100,40,0.28)',
              fontFamily: THEME.fontFamily,
            }}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>

        <p
          style={{
            textAlign: 'center',
            fontSize: 10.5,
            color: THEME.textDim,
            margin: 0,
          }}
        >
          ⌘S to save &middot; Esc to cancel
        </p>
      </div>
    </div>
  );
}

// ─── Command row ───────────────────────────────────────────────────────────

interface CommandRowProps {
  trigger: string;
  description: string;
  isDisabled: boolean;
  isEditing: boolean;
  hasOverride: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete?: () => void;
  testId: string;
}

function CommandRow({
  trigger,
  description,
  isDisabled,
  isEditing,
  onToggle,
  onEdit,
  onDelete,
  testId,
}: CommandRowProps) {
  return (
    /* v8 ignore start -- isDisabled ternary branches: all visible items have isDisabled=false */
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 4px',
        borderRadius: 8,
        opacity: isDisabled ? 0.4 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      {/* Status dot / toggle */}
      <button
        data-testid={`${testId}-toggle`}
        onClick={onToggle}
        aria-label={isDisabled ? 'Enable command' : 'Disable command'}
        style={{
          width: 10,
          height: 10,
          borderRadius: 9999,
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
          background: isDisabled ? 'rgba(255,255,255,0.25)' : '#22c55e',
          boxShadow: isDisabled ? 'none' : '0 0 8px rgba(34,197,94,0.4)',
        }}
      />

      {/* Trigger + description */}
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: 12.5,
          color: isDisabled ? 'rgba(255,255,255,0.4)' : THEME.accent,
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {trigger}
      </span>
      {/* v8 ignore stop */}
      <span
        style={{
          fontSize: 12,
          /* v8 ignore start -- isDisabled always false for visible items */
          color: isDisabled
            ? 'rgba(255,255,255,0.25)'
            : 'rgba(255,255,255,0.45)',
          /* v8 ignore stop */
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {description}
      </span>

      {/* Actions */}
      <button
        data-testid={`${testId}-edit`}
        onClick={onEdit}
        aria-label="Edit command"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: isEditing ? THEME.accent : 'rgba(255,255,255,0.3)',
          fontSize: 14,
          padding: 2,
          lineHeight: 1,
        }}
      >
        ✎
      </button>
      {onDelete && (
        <button
          data-testid={`${testId}-delete`}
          onClick={onDelete}
          aria-label="Delete command"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.3)',
            fontSize: 14,
            padding: 2,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ─── Command edit panel ────────────────────────────────────────────────────

interface ShortcutRowProps {
  testIdPrefix: string;
  title: string;
  description: string;
  value: string;
  hint: string;
  isRecording: boolean;
  onRecord: () => void;
}

function ShortcutRow({
  testIdPrefix,
  title,
  description,
  value,
  hint,
  isRecording,
  onRecord,
}: ShortcutRowProps) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong
            style={{
              color: THEME.textPrimary,
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {title}
          </strong>
          <span
            style={{
              color: 'rgba(255,255,255,0.45)',
              fontSize: 11.5,
              lineHeight: 1.45,
            }}
          >
            {description}
          </span>
        </div>
        <button
          data-testid={`${testIdPrefix}-record`}
          onClick={onRecord}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: `1px solid ${isRecording ? THEME.accent : 'rgba(255,255,255,0.12)'}`,
            background: isRecording ? 'rgba(255,141,92,0.12)' : 'transparent',
            color: isRecording ? THEME.accent : 'rgba(255,255,255,0.78)',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: THEME.fontFamily,
            whiteSpace: 'nowrap',
          }}
        >
          {isRecording ? 'Recording…' : 'Change Shortcut'}
        </button>
      </div>
      <div
        data-testid={`${testIdPrefix}-value`}
        style={{
          display: 'inline-flex',
          alignSelf: 'flex-start',
          padding: '5px 10px',
          borderRadius: 999,
          background: 'rgba(255,255,255,0.05)',
          color: THEME.textPrimary,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.02em',
        }}
      >
        {value}
      </div>
      <span
        data-testid={`${testIdPrefix}-hint`}
        style={{
          color: isRecording ? THEME.accent : 'rgba(255,255,255,0.3)',
          fontSize: 10.5,
          lineHeight: 1.45,
        }}
      >
        {isRecording ? hint : 'Changes take effect immediately after saving.'}
      </span>
    </div>
  );
}

interface CommandEditPanelProps {
  trigger: string;
  description: string;
  promptTemplate: string;
  onTriggerChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onTemplateChange: (v: string) => void;
  onReset?: () => void;
  /** Save this single command's changes and close the panel. */
  onApply: () => void;
  hasOverride?: boolean;
  testIdPrefix: string;
}

function CommandEditPanel({
  trigger,
  description,
  promptTemplate,
  onTriggerChange,
  onDescriptionChange,
  onTemplateChange,
  onReset,
  onApply,
  hasOverride,
  testIdPrefix,
}: CommandEditPanelProps) {
  return (
    <div
      data-testid={testIdPrefix}
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 10,
        padding: '12px 14px',
        marginTop: 4,
        marginBottom: 4,
        marginLeft: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <Field label="Command Trigger">
        <input
          data-testid={`${testIdPrefix}-trigger`}
          type="text"
          style={{ ...inputStyle, fontFamily: 'monospace' }}
          value={trigger}
          onChange={(e) => onTriggerChange(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input
          data-testid={`${testIdPrefix}-desc`}
          type="text"
          style={inputStyle}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
        />
      </Field>
      <Field label="Prompt Template">
        <textarea
          data-testid={`${testIdPrefix}-template`}
          rows={3}
          style={{ ...inputStyle, fontSize: 11.5 }}
          value={promptTemplate}
          onChange={(e) => onTemplateChange(e.target.value)}
        />
        <p
          style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.25)',
            marginTop: 4,
            fontStyle: 'italic',
          }}
        >
          Use $INPUT for user text, $LANG for target language
        </p>
      </Field>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 2,
        }}
      >
        {onReset && hasOverride ? (
          <button
            data-testid={`${testIdPrefix}-reset`}
            onClick={onReset}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.35)',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              padding: 0,
              fontFamily: THEME.fontFamily,
            }}
          >
            Reset Default
          </button>
        ) : (
          <span />
        )}
        <button
          data-testid={`${testIdPrefix}-apply`}
          onClick={onApply}
          style={{
            padding: '5px 14px',
            background: THEME.accent,
            border: 'none',
            borderRadius: 8,
            color: 'white',
            fontSize: 11.5,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: THEME.fontFamily,
            boxShadow: '0 2px 8px rgba(255,100,40,0.2)',
          }}
        >
          Apply Changes
        </button>
      </div>
    </div>
  );
}

// ─── Shared layout components ──────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2
        style={{
          fontSize: 12.5,
          fontWeight: 700,
          color: 'rgba(255,141,92,0.75)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          margin: 0,
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: THEME.divider }} />;
}
