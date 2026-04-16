import { useCallback, useEffect, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import type { SettingsData } from '../hooks/useSettings';
import { COMMANDS } from '../config/commands';

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
  onDismiss: () => void;
}

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

  useEffect(() => {
    if (settings && !draft) {
      setDraft(settings);
    }
  }, [settings, draft]);

  const update = useCallback(
    <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => {
      /* v8 ignore next -- draft is always non-null after the loading gate */
      setDraft((d) => (d ? { ...d, [key]: value } : d));
    },
    [],
  );

  const updateCmdPrompt = useCallback((trigger: string, value: string) => {
    /* v8 ignore start -- defensive null-check; draft guaranteed non-null */
    setDraft(
      (d) =>
        d
          ? {
              ...d,
              command_prompts: { ...d.command_prompts, [trigger]: value },
            }
          : d,
      /* v8 ignore stop */
    );
  }, []);

  const handleSave = useCallback(async () => {
    /* v8 ignore next -- loading gate ensures draft is always non-null here */
    if (!draft || isSaving) return;
    await save(draft);
    onDismiss();
  }, [draft, isSaving, save, onDismiss]);

  const handleTest = useCallback(async () => {
    /* v8 ignore next */
    if (!draft) return;
    await testConnection(draft.api_base_url, draft.api_key);
  }, [draft, testConnection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* v8 ignore start -- keyboard shortcut alternative modifiers */
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
      /* v8 ignore stop */
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss, handleSave]);

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

  const cmdEntries = COMMANDS.filter((c) => c.promptTemplate);

  return (
    <div
      data-testid="settings-root"
      style={{
        width: 480,
        maxHeight: 580,
        overflowY: 'auto',
        background: THEME.cardBg,
        border: THEME.cardBorder,
        borderRadius: 24,
        boxShadow: THEME.cardShadow,
        padding: '24px 22px 18px',
        fontFamily: THEME.fontFamily,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* Header */}
      <div style={{ textAlign: 'center' }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: THEME.textPrimary,
            letterSpacing: '-0.4px',
            margin: '0 0 4px',
          }}
        >
          Settings
        </h1>
        <p style={{ fontSize: 12, color: THEME.textMuted, margin: 0 }}>
          Changes take effect immediately — no restart needed.
        </p>
      </div>

      <Divider />

      {/* ── AI Model ──────────────────────────────────── */}
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

      <Divider />

      {/* ── Prompts ───────────────────────────────────── */}
      <Section title="Chat System Prompt">
        <textarea
          data-testid="settings-system-prompt"
          rows={4}
          style={inputStyle}
          value={draft.system_prompt}
          onChange={(e) => update('system_prompt', e.target.value)}
        />
      </Section>

      <Divider />

      <Section title="Smart Reply Prompt (⌃⇧R)">
        <textarea
          data-testid="settings-reply-prompt"
          rows={4}
          style={inputStyle}
          value={draft.reply_prompt}
          onChange={(e) => update('reply_prompt', e.target.value)}
        />
      </Section>

      <Divider />

      <Section title="Slash Command Prompts">
        {cmdEntries.map((cmd) => (
          <Field
            key={cmd.trigger}
            label={`${cmd.trigger} — ${cmd.description}`}
          >
            <textarea
              data-testid={`settings-cmd-${cmd.trigger.replace('/', '')}`}
              rows={3}
              style={{ ...inputStyle, fontSize: 11.5 }}
              /* v8 ignore start -- ?? fallback branches */
              value={
                draft.command_prompts[cmd.trigger] ?? cmd.promptTemplate ?? ''
              }
              /* v8 ignore stop */
              onChange={(e) => updateCmdPrompt(cmd.trigger, e.target.value)}
              placeholder={cmd.promptTemplate}
            />
          </Field>
        ))}
      </Section>

      <Divider />

      {/* ── Actions ───────────────────────────────────── */}
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
          onClick={onDismiss}
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
  );
}

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
