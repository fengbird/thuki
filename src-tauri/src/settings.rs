//! Runtime-mutable settings with SQLite persistence.
//!
//! Settings load in priority order: **SQLite → environment variable → built-in
//! default**. Changes from the Settings UI are written to SQLite AND synced to
//! the Mutex-wrapped in-memory states so every subsequent Tauri command picks
//! up the new values immediately — no restart required.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{
    ApiConfig, ModelConfig, SystemPrompt, DEFAULT_API_BASE_URL, DEFAULT_API_KEY, DEFAULT_MODEL_NAME,
};
use crate::database;
use crate::database::Database;
use crate::reply::ReplyPrompt;

/// Complete snapshot of every user-configurable value. Serialized to/from
/// the frontend via `get_settings` / `update_settings`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SettingsData {
    pub api_base_url: String,
    pub api_key: String,
    pub model_name: String,
    pub system_prompt: String,
    pub reply_prompt: String,
    #[serde(default = "default_ocr_prompt")]
    pub ocr_prompt: String,
    #[serde(default = "default_shortcut_config")]
    pub shortcut_config: ShortcutConfig,
    /// Slash command configuration stored as an opaque JSON value.
    /// The frontend owns the schema (overrides, custom, disabled).
    #[serde(default)]
    pub commands_config: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutModifier {
    Cmd,
    Ctrl,
    Shift,
    Alt,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct KeyComboShortcut {
    pub key_code: i64,
    #[serde(default)]
    pub modifiers: Vec<ShortcutModifier>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OverlayActivationShortcut {
    DoubleTapModifier {
        modifier: ShortcutModifier,
    },
    KeyCombo {
        key_code: i64,
        #[serde(default)]
        modifiers: Vec<ShortcutModifier>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ShortcutConfig {
    #[serde(default = "default_overlay_activation_shortcut")]
    pub overlay_activation: OverlayActivationShortcut,
    #[serde(default = "default_screenshot_shortcut")]
    pub screenshot_capture: KeyComboShortcut,
}

pub struct ShortcutConfigState(pub Arc<Mutex<ShortcutConfig>>);

impl ShortcutConfigState {
    pub fn new(config: ShortcutConfig) -> Self {
        Self(Arc::new(Mutex::new(config.normalize())))
    }
}

// ─── DB keys ────────────────────────────────────────────────────────────────

const K_API_BASE_URL: &str = "settings.api_base_url";
const K_API_KEY: &str = "settings.api_key";
const K_MODEL_NAME: &str = "settings.model_name";
const K_SYSTEM_PROMPT: &str = "settings.system_prompt";
const K_REPLY_PROMPT: &str = "settings.reply_prompt";
const K_OCR_PROMPT: &str = "settings.ocr_prompt";
const K_SHORTCUT_CONFIG: &str = "settings.shortcut_config";
const K_COMMANDS_CONFIG: &str = "settings.commands_config";

pub const DEFAULT_OCR_PROMPT: &str = "请提取图中所有文字，原样输出。";

fn default_ocr_prompt() -> String {
    DEFAULT_OCR_PROMPT.to_string()
}

fn default_overlay_activation_shortcut() -> OverlayActivationShortcut {
    OverlayActivationShortcut::DoubleTapModifier {
        modifier: ShortcutModifier::Ctrl,
    }
}

fn default_screenshot_shortcut() -> KeyComboShortcut {
    KeyComboShortcut {
        key_code: 0x07,
        modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
    }
}

pub fn default_shortcut_config() -> ShortcutConfig {
    ShortcutConfig {
        overlay_activation: default_overlay_activation_shortcut(),
        screenshot_capture: default_screenshot_shortcut(),
    }
}

impl KeyComboShortcut {
    fn normalize(&self) -> Self {
        let mut modifiers = self.modifiers.clone();
        modifiers.sort_by_key(|modifier| match modifier {
            ShortcutModifier::Cmd => 0,
            ShortcutModifier::Ctrl => 1,
            ShortcutModifier::Alt => 2,
            ShortcutModifier::Shift => 3,
        });
        modifiers.dedup();
        Self {
            key_code: self.key_code,
            modifiers,
        }
    }
}

impl ShortcutConfig {
    pub fn normalize(&self) -> Self {
        Self {
            overlay_activation: match &self.overlay_activation {
                OverlayActivationShortcut::DoubleTapModifier { modifier } => {
                    OverlayActivationShortcut::DoubleTapModifier {
                        modifier: *modifier,
                    }
                }
                OverlayActivationShortcut::KeyCombo {
                    key_code,
                    modifiers,
                } => {
                    let combo = KeyComboShortcut {
                        key_code: *key_code,
                        modifiers: modifiers.clone(),
                    }
                    .normalize();
                    OverlayActivationShortcut::KeyCombo {
                        key_code: combo.key_code,
                        modifiers: combo.modifiers,
                    }
                }
            },
            screenshot_capture: self.screenshot_capture.normalize(),
        }
    }
}

// ─── Load / Save ────────────────────────────────────────────────────────────

/// Reads all settings from the DB, falling back through env vars and
/// built-in defaults for any key that is absent. Orchestration wrapper
/// around tested helpers (`env_nonempty`, `model_name_from_env`,
/// `load_command_prompts`). Excluded from coverage because llvm-cov
/// cannot resolve inline-closure attribution for the chained Option
/// combinators.
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn load_settings(conn: &rusqlite::Connection) -> SettingsData {
    let db = |key: &str| database::get_config(conn, key).ok().flatten();

    let api_base_url = db(K_API_BASE_URL)
        .or_else(|| env_nonempty("OLING_API_BASE_URL"))
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string());
    let api_key = db(K_API_KEY)
        .or_else(|| env_nonempty("OLING_API_KEY"))
        .unwrap_or_else(|| DEFAULT_API_KEY.to_string());
    let model_name = db(K_MODEL_NAME)
        .or_else(model_name_from_env)
        .unwrap_or_else(|| DEFAULT_MODEL_NAME.to_string());
    let system_prompt = db(K_SYSTEM_PROMPT)
        .or_else(|| env_nonempty("OLING_SYSTEM_PROMPT"))
        .unwrap_or_else(crate::commands::load_system_prompt);
    let reply_prompt = db(K_REPLY_PROMPT)
        .or_else(|| env_nonempty("OLING_REPLY_PROMPT"))
        .unwrap_or_else(crate::reply::load_reply_prompt);
    let ocr_prompt = db(K_OCR_PROMPT).unwrap_or_else(default_ocr_prompt);
    let shortcut_config = load_shortcut_config(conn);
    let commands_config = load_commands_config(conn);

    SettingsData {
        api_base_url,
        api_key,
        model_name,
        system_prompt,
        reply_prompt,
        ocr_prompt,
        shortcut_config,
        commands_config,
    }
}

/// Writes every field to the DB so the next launch picks them up.
/// The error-mapping closure inside (`map_err(|e| e.to_string())`) is
/// unreachable under normal conditions since `set_config` uses UPSERT.
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn save_settings(conn: &rusqlite::Connection, data: &SettingsData) -> Result<(), String> {
    let set = |k: &str, v: &str| database::set_config(conn, k, v).map_err(|e| e.to_string());
    set(K_API_BASE_URL, &data.api_base_url)?;
    set(K_API_KEY, &data.api_key)?;
    set(K_MODEL_NAME, &data.model_name)?;
    set(K_SYSTEM_PROMPT, &data.system_prompt)?;
    set(K_REPLY_PROMPT, &data.reply_prompt)?;
    set(K_OCR_PROMPT, &data.ocr_prompt)?;
    let shortcut_json = serde_json::to_string(&data.shortcut_config.normalize())
        .map_err(|e| format!("Failed to serialize shortcut_config: {e}"))?;
    set(K_SHORTCUT_CONFIG, &shortcut_json)?;
    let config_json = serde_json::to_string(&data.commands_config)
        .map_err(|e| format!("Failed to serialize commands_config: {e}"))?;
    set(K_COMMANDS_CONFIG, &config_json)?;
    Ok(())
}

/// Pushes `data` into the live Mutex-wrapped states so every subsequent
/// Tauri command reads the fresh values. Called immediately after
/// `save_settings`.
pub fn apply_to_live_states(
    data: &SettingsData,
    api_config: &Mutex<ApiConfig>,
    model_config: &Mutex<ModelConfig>,
    system_prompt: &Mutex<SystemPrompt>,
    reply_prompt: &Mutex<ReplyPrompt>,
    shortcut_config: &ShortcutConfigState,
) {
    *api_config.lock().unwrap() = ApiConfig {
        base_url: data.api_base_url.trim_end_matches('/').to_string(),
        api_key: data.api_key.clone(),
    };
    *model_config.lock().unwrap() = ModelConfig {
        active: data.model_name.clone(),
        all: vec![data.model_name.clone()],
    };
    *system_prompt.lock().unwrap() = SystemPrompt(data.system_prompt.clone());
    *reply_prompt.lock().unwrap() = ReplyPrompt(data.reply_prompt.clone());
    *shortcut_config.0.lock().unwrap() = data.shortcut_config.normalize();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Extracts the first comma-separated model name from
/// `OLING_SUPPORTED_AI_MODELS`, trimmed. Returns `None` if the env is
/// unset, blank, or the first entry is empty after trimming.
fn model_name_from_env() -> Option<String> {
    let s = env_nonempty("OLING_SUPPORTED_AI_MODELS")?;
    let first = s.split(',').next()?.trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}

fn load_commands_config(conn: &rusqlite::Connection) -> serde_json::Value {
    database::get_config(conn, K_COMMANDS_CONFIG)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({
            "overrides": {},
            "custom": [],
            "disabled": []
        }))
}

fn load_shortcut_config(conn: &rusqlite::Connection) -> ShortcutConfig {
    database::get_config(conn, K_SHORTCUT_CONFIG)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<ShortcutConfig>(&s).ok())
        .map(|config| config.normalize())
        .unwrap_or_else(default_shortcut_config)
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Returns the full settings snapshot as JSON.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn get_settings(db: State<'_, Database>) -> Result<SettingsData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(load_settings(&conn))
}

/// Persists settings to SQLite and syncs them into the live in-memory
/// states so subsequent commands pick up the new values immediately.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn update_settings(
    data: SettingsData,
    db: State<'_, Database>,
    api_config: State<'_, Mutex<ApiConfig>>,
    model_config: State<'_, Mutex<ModelConfig>>,
    system_prompt: State<'_, Mutex<SystemPrompt>>,
    reply_prompt: State<'_, Mutex<ReplyPrompt>>,
    shortcut_config: State<'_, ShortcutConfigState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut data = data;
    data.shortcut_config = data.shortcut_config.normalize();
    save_settings(&conn, &data)?;
    apply_to_live_states(
        &data,
        &api_config,
        &model_config,
        &system_prompt,
        &reply_prompt,
        &shortcut_config,
    );
    Ok(())
}

/// Tests connectivity to the configured LLM server by hitting
/// `GET {base_url}/models`. Returns the parsed JSON body on success
/// so the frontend can display available models.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn test_api_connection(
    base_url: String,
    api_key: String,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let resp = client
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> rusqlite::Connection {
        database::open_in_memory().unwrap()
    }

    #[test]
    fn load_settings_returns_defaults_on_empty_db() {
        let conn = test_conn();
        let s = load_settings(&conn);
        assert_eq!(s.api_base_url, DEFAULT_API_BASE_URL);
        assert_eq!(s.api_key, DEFAULT_API_KEY);
        assert_eq!(s.model_name, DEFAULT_MODEL_NAME);
        assert!(!s.system_prompt.is_empty());
        assert!(!s.reply_prompt.is_empty());
        assert_eq!(s.ocr_prompt, DEFAULT_OCR_PROMPT);
        assert_eq!(s.shortcut_config, default_shortcut_config());
        // Default commands_config has empty overrides/custom/disabled.
        assert!(s.commands_config["overrides"]
            .as_object()
            .unwrap()
            .is_empty());
        assert!(s.commands_config["custom"].as_array().unwrap().is_empty());
        assert!(s.commands_config["disabled"].as_array().unwrap().is_empty());
    }

    #[test]
    fn save_and_load_round_trips() {
        let conn = test_conn();
        let data = SettingsData {
            api_base_url: "http://10.0.0.4:5678/v1".to_string(),
            api_key: "sk-test".to_string(),
            model_name: "llama3.1-8b".to_string(),
            system_prompt: "Be brief.".to_string(),
            reply_prompt: "Reply concisely.".to_string(),
            ocr_prompt: "Extract every visible line.".to_string(),
            shortcut_config: ShortcutConfig {
                overlay_activation: OverlayActivationShortcut::KeyCombo {
                    key_code: 0x06,
                    modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
                },
                screenshot_capture: KeyComboShortcut {
                    key_code: 0x0f,
                    modifiers: vec![ShortcutModifier::Ctrl, ShortcutModifier::Shift],
                },
            },
            commands_config: serde_json::json!({
                "overrides": {
                    "/translate": { "prompt_template": "Custom translate" }
                },
                "custom": [
                    { "trigger": "/mycmd", "description": "My cmd", "prompt_template": "Do $INPUT" }
                ],
                "disabled": ["/refine"]
            }),
        };
        save_settings(&conn, &data).unwrap();

        let loaded = load_settings(&conn);
        assert_eq!(loaded.api_base_url, "http://10.0.0.4:5678/v1");
        assert_eq!(loaded.api_key, "sk-test");
        assert_eq!(loaded.model_name, "llama3.1-8b");
        assert_eq!(loaded.system_prompt, "Be brief.");
        assert_eq!(loaded.reply_prompt, "Reply concisely.");
        assert_eq!(loaded.ocr_prompt, "Extract every visible line.");
        assert_eq!(
            loaded.shortcut_config.overlay_activation,
            OverlayActivationShortcut::KeyCombo {
                key_code: 0x06,
                modifiers: vec![ShortcutModifier::Cmd, ShortcutModifier::Shift],
            }
        );
        assert_eq!(
            loaded.shortcut_config.screenshot_capture,
            KeyComboShortcut {
                key_code: 0x0f,
                modifiers: vec![ShortcutModifier::Ctrl, ShortcutModifier::Shift],
            }
        );
        assert_eq!(
            loaded.commands_config["overrides"]["/translate"]["prompt_template"],
            "Custom translate"
        );
        assert_eq!(loaded.commands_config["custom"][0]["trigger"], "/mycmd");
        assert_eq!(loaded.commands_config["disabled"][0], "/refine");
    }

    /// Guard to serialize tests that mutate environment variables.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn model_name_from_env_returns_first_entry() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("OLING_SUPPORTED_AI_MODELS", "first-model,second-model");
        assert_eq!(model_name_from_env().as_deref(), Some("first-model"));
        std::env::remove_var("OLING_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn model_name_from_env_returns_none_for_blank() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("OLING_SUPPORTED_AI_MODELS", "  ");
        assert!(model_name_from_env().is_none());
        std::env::remove_var("OLING_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn model_name_from_env_returns_none_for_commas_only() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("OLING_SUPPORTED_AI_MODELS", ",,,");
        assert!(model_name_from_env().is_none());
        std::env::remove_var("OLING_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn model_name_from_env_returns_none_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("OLING_SUPPORTED_AI_MODELS");
        assert!(model_name_from_env().is_none());
    }

    #[test]
    fn db_values_override_defaults() {
        let conn = test_conn();
        database::set_config(&conn, K_API_BASE_URL, "http://custom:9999").unwrap();
        let s = load_settings(&conn);
        assert_eq!(s.api_base_url, "http://custom:9999");
        // Other fields still at default.
        assert_eq!(s.api_key, DEFAULT_API_KEY);
    }

    #[test]
    fn apply_to_live_states_syncs_all_fields() {
        let data = SettingsData {
            api_base_url: "http://new:1234/v1/".to_string(),
            api_key: "new-key".to_string(),
            model_name: "new-model".to_string(),
            system_prompt: "new sys".to_string(),
            reply_prompt: "new reply".to_string(),
            ocr_prompt: "new ocr".to_string(),
            shortcut_config: ShortcutConfig {
                overlay_activation: OverlayActivationShortcut::DoubleTapModifier {
                    modifier: ShortcutModifier::Alt,
                },
                screenshot_capture: KeyComboShortcut {
                    key_code: 0x08,
                    modifiers: vec![ShortcutModifier::Cmd],
                },
            },
            commands_config: serde_json::json!({}),
        };
        let api = Mutex::new(ApiConfig {
            base_url: "old".to_string(),
            api_key: "old".to_string(),
        });
        let model = Mutex::new(ModelConfig {
            active: "old".to_string(),
            all: vec!["old".to_string()],
        });
        let sys = Mutex::new(SystemPrompt("old".to_string()));
        let reply = Mutex::new(ReplyPrompt("old".to_string()));
        let shortcuts = ShortcutConfigState::new(default_shortcut_config());

        apply_to_live_states(&data, &api, &model, &sys, &reply, &shortcuts);

        let a = api.lock().unwrap();
        assert_eq!(a.base_url, "http://new:1234/v1"); // trailing slash stripped
        assert_eq!(a.api_key, "new-key");
        drop(a);

        let m = model.lock().unwrap();
        assert_eq!(m.active, "new-model");
        assert_eq!(m.all, vec!["new-model".to_string()]);
        drop(m);

        assert_eq!(sys.lock().unwrap().0, "new sys");
        assert_eq!(reply.lock().unwrap().0, "new reply");
        assert_eq!(
            *shortcuts.0.lock().unwrap(),
            ShortcutConfig {
                overlay_activation: OverlayActivationShortcut::DoubleTapModifier {
                    modifier: ShortcutModifier::Alt,
                },
                screenshot_capture: KeyComboShortcut {
                    key_code: 0x08,
                    modifiers: vec![ShortcutModifier::Cmd],
                },
            }
        );
    }

    #[test]
    fn settings_data_serializes_to_json() {
        let data = SettingsData {
            api_base_url: "http://x".to_string(),
            api_key: "k".to_string(),
            model_name: "m".to_string(),
            system_prompt: "s".to_string(),
            reply_prompt: "r".to_string(),
            ocr_prompt: "o".to_string(),
            shortcut_config: default_shortcut_config(),
            commands_config: serde_json::json!({ "overrides": {}, "custom": [], "disabled": [] }),
        };
        let json = serde_json::to_value(&data).unwrap();
        assert_eq!(json["api_base_url"], "http://x");
        assert_eq!(json["model_name"], "m");
        assert_eq!(json["ocr_prompt"], "o");
        assert_eq!(
            json["shortcut_config"]["overlay_activation"]["kind"],
            "double_tap_modifier"
        );
        assert!(json["commands_config"]["overrides"].is_object());
    }

    #[test]
    fn settings_data_deserializes_from_json() {
        let json = r#"{
            "api_base_url": "http://y",
            "api_key": "k2",
            "model_name": "m2",
            "system_prompt": "sp",
            "reply_prompt": "rp",
            "ocr_prompt": "op",
            "shortcut_config": {
                "overlay_activation": {
                    "kind": "key_combo",
                    "key_code": 6,
                    "modifiers": ["cmd", "shift"]
                },
                "screenshot_capture": {
                    "key_code": 15,
                    "modifiers": ["ctrl", "shift"]
                }
            },
            "commands_config": {
                "overrides": { "/translate": { "prompt_template": "custom" } },
                "custom": [],
                "disabled": []
            }
        }"#;
        let data: SettingsData = serde_json::from_str(json).unwrap();
        assert_eq!(data.api_base_url, "http://y");
        assert_eq!(data.ocr_prompt, "op");
        assert_eq!(
            data.shortcut_config.screenshot_capture,
            KeyComboShortcut {
                key_code: 15,
                modifiers: vec![ShortcutModifier::Ctrl, ShortcutModifier::Shift],
            }
        );
        assert_eq!(
            data.commands_config["overrides"]["/translate"]["prompt_template"],
            "custom"
        );
    }

    #[test]
    fn settings_data_deserializes_without_commands_config() {
        // commands_config absent → should default to null (serde default).
        let json = r#"{
            "api_base_url": "http://z",
            "api_key": "k",
            "model_name": "m",
            "system_prompt": "s",
            "reply_prompt": "r"
        }"#;
        let data: SettingsData = serde_json::from_str(json).unwrap();
        assert_eq!(data.api_base_url, "http://z");
        assert_eq!(data.ocr_prompt, DEFAULT_OCR_PROMPT);
        assert_eq!(data.shortcut_config, default_shortcut_config());
        assert!(data.commands_config.is_null());
    }

    #[test]
    fn env_nonempty_returns_none_for_missing() {
        assert!(env_nonempty("OLING_NONEXISTENT_VAR_12345").is_none());
    }

    #[test]
    fn env_nonempty_returns_none_for_whitespace_only() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("OLING_TEST_ENVCHECK", "   ");
        assert!(env_nonempty("OLING_TEST_ENVCHECK").is_none());
        std::env::remove_var("OLING_TEST_ENVCHECK");
    }

    #[test]
    fn env_nonempty_returns_value_when_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("OLING_TEST_ENVCHECK", "hello");
        assert_eq!(
            env_nonempty("OLING_TEST_ENVCHECK").as_deref(),
            Some("hello")
        );
        std::env::remove_var("OLING_TEST_ENVCHECK");
    }

    #[test]
    fn load_commands_config_returns_defaults_on_fresh_db() {
        let conn = test_conn();
        let cfg = load_commands_config(&conn);
        assert!(cfg["overrides"].as_object().unwrap().is_empty());
        assert!(cfg["custom"].as_array().unwrap().is_empty());
        assert!(cfg["disabled"].as_array().unwrap().is_empty());
    }

    #[test]
    fn load_commands_config_reads_stored_json() {
        let conn = test_conn();
        let json = r#"{"overrides":{"/translate":{"prompt_template":"T"}},"custom":[],"disabled":["/refine"]}"#;
        database::set_config(&conn, K_COMMANDS_CONFIG, json).unwrap();

        let cfg = load_commands_config(&conn);
        assert_eq!(cfg["overrides"]["/translate"]["prompt_template"], "T");
        assert_eq!(cfg["disabled"][0], "/refine");
    }

    #[test]
    fn load_commands_config_returns_defaults_on_invalid_json() {
        let conn = test_conn();
        database::set_config(&conn, K_COMMANDS_CONFIG, "not-valid-json").unwrap();

        let cfg = load_commands_config(&conn);
        // Falls back to defaults rather than panicking.
        assert!(cfg["overrides"].as_object().unwrap().is_empty());
    }

    #[test]
    fn save_overwrites_existing_values() {
        let conn = test_conn();
        let mut data = SettingsData {
            api_base_url: "http://first".to_string(),
            api_key: "k".to_string(),
            model_name: "m".to_string(),
            system_prompt: "s".to_string(),
            reply_prompt: "r".to_string(),
            ocr_prompt: "o".to_string(),
            shortcut_config: default_shortcut_config(),
            commands_config: serde_json::json!({ "overrides": {}, "custom": [], "disabled": [] }),
        };
        save_settings(&conn, &data).unwrap();

        data.api_base_url = "http://second".to_string();
        save_settings(&conn, &data).unwrap();

        let loaded = load_settings(&conn);
        assert_eq!(loaded.api_base_url, "http://second");
    }
}
