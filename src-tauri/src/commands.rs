use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

/// Default OpenAI-compatible API base URL (includes any `/v1`-style prefix).
/// The streaming endpoint is constructed as `{base}/chat/completions`.
pub const DEFAULT_API_BASE_URL: &str = "http://10.0.0.4:1234/v1";
/// Default model name used when `THUKI_SUPPORTED_AI_MODELS` is unset.
pub const DEFAULT_MODEL_NAME: &str = "qwen/qwen3-vl-8b";
/// Default API key sent via `Authorization: Bearer`. LM Studio does not
/// validate it, but sending something keeps the request universally compatible.
pub const DEFAULT_API_KEY: &str = "lm-studio";
const DEFAULT_SYSTEM_PROMPT: &str = include_str!("../prompts/system_prompt.txt");

/// Classifies the kind of error returned from the LLM backend.
/// Used by the frontend to pick accent bar color and display copy.
#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "PascalCase")]
pub enum OllamaErrorKind {
    /// Connection refused / timeout — the LLM server is not reachable.
    NotRunning,
    /// The requested model is not loaded (HTTP 404).
    ModelNotFound,
    /// Any other unexpected error.
    Other,
}

/// Structured error emitted over the streaming channel.
/// Rust owns all user-facing copy; the frontend only uses `kind` for styling.
#[derive(Clone, Serialize, Debug)]
pub struct OllamaError {
    pub kind: OllamaErrorKind,
    /// Final user-facing string. First line is the title, remainder is the subtitle.
    pub message: String,
}

/// Maps an HTTP status code to a user-friendly `OllamaError`.
pub fn classify_http_error(status: u16) -> OllamaError {
    match status {
        404 => OllamaError {
            kind: OllamaErrorKind::ModelNotFound,
            message: "Model not found\nCheck that the model is loaded on the LLM server."
                .to_string(),
        },
        _ => OllamaError {
            kind: OllamaErrorKind::Other,
            message: format!("Something went wrong\nHTTP {status}"),
        },
    }
}

/// Maps a reqwest connection/transport error to a user-friendly `OllamaError`.
///
/// Any error that stops us from reaching the server (connect refused, DNS
/// failure, timeout, other request-phase failures) is reported as
/// `NotRunning` so the user sees a single, actionable message. Reqwest's
/// `is_connect` flag is unreliable across TLS/connection-pool code paths,
/// so we also treat generic `is_request` errors as "server unreachable" —
/// both produce the same user-facing guidance regardless.
pub fn classify_stream_error(e: &reqwest::Error) -> OllamaError {
    if e.is_connect() || e.is_timeout() || e.is_request() {
        OllamaError {
            kind: OllamaErrorKind::NotRunning,
            message: "LLM server isn't running\nStart your server and try again.".to_string(),
        }
    } else {
        OllamaError {
            kind: OllamaErrorKind::Other,
            message: "Something went wrong\nCould not reach the LLM server.".to_string(),
        }
    }
}

/// Payload emitted back to the frontend per token chunk.
#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamChunk {
    /// A single token chunk string.
    Token(String),
    /// A single thinking/reasoning token chunk string.
    ThinkingToken(String),
    /// Indicates the stream has fully completed.
    Done,
    /// The user explicitly cancelled generation.
    Cancelled,
    /// A structured, user-friendly error occurred during processing.
    Error(OllamaError),
}

/// A single chat message in the in-memory conversation.
///
/// `content` is a plain string; `images` carries optional base64-encoded
/// image bodies for multimodal requests. The wire serialization is OpenAI
/// `chat/completions` compatible — when images are present, `content`
/// becomes an array of `{type: text|image_url, ...}` parts; otherwise it is
/// sent as a plain string.
#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub images: Option<Vec<String>>,
}

impl Serialize for ChatMessage {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let mut state = ser.serialize_struct("ChatMessage", 2)?;
        state.serialize_field("role", &self.role)?;
        match &self.images {
            Some(imgs) if !imgs.is_empty() => {
                let mut parts: Vec<serde_json::Value> = Vec::with_capacity(imgs.len() + 1);
                if !self.content.is_empty() {
                    parts.push(serde_json::json!({
                        "type": "text",
                        "text": self.content,
                    }));
                }
                for img in imgs {
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:image/jpeg;base64,{img}"),
                        },
                    }));
                }
                state.serialize_field("content", &parts)?;
            }
            _ => {
                state.serialize_field("content", &self.content)?;
            }
        }
        state.end()
    }
}

/// Request payload for the OpenAI `/chat/completions` endpoint.
#[derive(Serialize)]
struct ChatCompletionsRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    temperature: f64,
    top_p: f64,
}

/// Per-chunk delta in an OpenAI streaming response. Either `content` (the
/// visible assistant text) or `reasoning_content` (DeepSeek/qwen3 reasoning
/// stream — also accepted as `reasoning` for OpenAI's o-series alias).
#[derive(Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default, alias = "reasoning")]
    reasoning_content: Option<String>,
}

/// Single choice in a streaming chunk. `delta` carries incremental tokens;
/// `finish_reason` is set on the final chunk but is informational — the
/// stream terminator is always the `data: [DONE]` sentinel.
#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Option<Delta>,
}

/// Top-level OpenAI streaming chunk.
#[derive(Deserialize)]
struct ChatCompletionsChunk {
    #[serde(default)]
    choices: Vec<Choice>,
}

/// State machine that extracts inline `<think>…</think>` tags from streamed
/// assistant content. Tags may span multiple deltas, so we buffer any suffix
/// that could be the start of a tag and only emit bytes once it's clear
/// whether they belong to the visible answer or the thinking channel.
struct ThinkTagState {
    in_think: bool,
    /// Carry-over from the previous delta — either non-empty when a partial
    /// tag is pending, or empty.
    carry: String,
}

impl ThinkTagState {
    fn new() -> Self {
        Self {
            in_think: false,
            carry: String::new(),
        }
    }

    /// Processes an incoming content delta, emitting `Token` and
    /// `ThinkingToken` chunks as segments become unambiguous. `acc` records
    /// only user-visible Token text so the caller can persist it.
    fn process(&mut self, delta: &str, on_chunk: &impl Fn(StreamChunk), acc: &mut String) {
        self.carry.push_str(delta);
        loop {
            if self.in_think {
                if let Some(idx) = self.carry.find("</think>") {
                    let before: String = self.carry.drain(..idx).collect();
                    if !before.is_empty() {
                        on_chunk(StreamChunk::ThinkingToken(before));
                    }
                    // Drop the closing tag itself.
                    self.carry.drain(..CLOSE_TAG.len());
                    self.in_think = false;
                    continue;
                }
                let tail = potential_tag_tail(&self.carry, CLOSE_TAG);
                let safe_len = self.carry.len() - tail;
                if safe_len > 0 {
                    let emit: String = self.carry.drain(..safe_len).collect();
                    on_chunk(StreamChunk::ThinkingToken(emit));
                }
                break;
            } else {
                if let Some(idx) = self.carry.find(OPEN_TAG) {
                    let before: String = self.carry.drain(..idx).collect();
                    if !before.is_empty() {
                        acc.push_str(&before);
                        on_chunk(StreamChunk::Token(before));
                    }
                    self.carry.drain(..OPEN_TAG.len());
                    self.in_think = true;
                    continue;
                }
                let tail = potential_tag_tail(&self.carry, OPEN_TAG);
                let safe_len = self.carry.len() - tail;
                if safe_len > 0 {
                    let emit: String = self.carry.drain(..safe_len).collect();
                    acc.push_str(&emit);
                    on_chunk(StreamChunk::Token(emit));
                }
                break;
            }
        }
    }

    /// Flushes any remaining buffered text at end of stream. Emits under
    /// whichever channel matches the current state so no bytes are lost
    /// if the stream terminates mid-tag.
    fn flush(&mut self, on_chunk: &impl Fn(StreamChunk), acc: &mut String) {
        if self.carry.is_empty() {
            return;
        }
        let emit = std::mem::take(&mut self.carry);
        if self.in_think {
            on_chunk(StreamChunk::ThinkingToken(emit));
        } else {
            acc.push_str(&emit);
            on_chunk(StreamChunk::Token(emit));
        }
    }
}

const OPEN_TAG: &str = "<think>";
const CLOSE_TAG: &str = "</think>";

/// Returns the length of the longest suffix of `s` that is a strict prefix
/// of `tag` (i.e. a partial-tag tail that we must hold off emitting until
/// the next delta clarifies whether a tag is forming). Zero when no partial
/// tag is present. Tag must be ASCII so byte- and char-boundaries coincide.
fn potential_tag_tail(s: &str, tag: &str) -> usize {
    let max_len = tag.len().saturating_sub(1).min(s.len());
    for i in (1..=max_len).rev() {
        if s.ends_with(&tag[..i]) {
            return i;
        }
    }
    0
}

/// Holds the active cancellation token for the current generation request.
///
/// Only one generation runs at a time — starting a new request replaces the
/// previous token. `cancel_generation` cancels whatever is currently active.
#[derive(Default)]
pub struct GenerationState {
    token: Mutex<Option<CancellationToken>>,
}

impl GenerationState {
    /// Creates a new empty generation state with no active token.
    pub fn new() -> Self {
        Self {
            token: Mutex::new(None),
        }
    }

    /// Stores a new cancellation token, replacing any previous one.
    pub fn set(&self, token: CancellationToken) {
        *self.token.lock().unwrap() = Some(token);
    }

    /// Cancels the active generation, if any, and clears the stored token.
    pub fn cancel(&self) {
        if let Some(token) = self.token.lock().unwrap().take() {
            token.cancel();
        }
    }

    /// Clears the stored token without cancelling it (used on natural completion).
    pub fn clear(&self) {
        *self.token.lock().unwrap() = None;
    }
}

/// Backend-managed conversation history with an epoch counter to prevent
/// stale writes after a reset. The Rust side is the source of truth; the
/// frontend sends only new user messages and receives streamed tokens.
pub struct ConversationHistory {
    pub messages: Mutex<Vec<ChatMessage>>,
    pub epoch: AtomicU64,
}

impl Default for ConversationHistory {
    fn default() -> Self {
        Self {
            messages: Mutex::new(Vec::new()),
            epoch: AtomicU64::new(0),
        }
    }
}

impl ConversationHistory {
    /// Creates a new empty conversation history at epoch 0.
    pub fn new() -> Self {
        Self::default()
    }
}

/// System prompt loaded once at startup from the `THUKI_SYSTEM_PROMPT`
/// environment variable, falling back to a built-in default.
pub struct SystemPrompt(pub String);

/// Reads `THUKI_SYSTEM_PROMPT` from the environment, falling back to the
/// built-in default when unset or empty.
pub fn load_system_prompt() -> String {
    std::env::var("THUKI_SYSTEM_PROMPT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string())
}

/// Model configuration loaded once at startup from the `THUKI_SUPPORTED_AI_MODELS`
/// environment variable (comma-separated list). The first entry is the active model
/// used for inference. Falls back to `DEFAULT_MODEL_NAME` when unset or empty.
pub struct ModelConfig {
    pub active: String,
    pub all: Vec<String>,
}

/// Reads `THUKI_SUPPORTED_AI_MODELS` from the environment and returns a
/// `ModelConfig`. Trims whitespace around each entry and filters empty entries.
/// Defaults to `[DEFAULT_MODEL_NAME]` when the variable is unset or empty.
pub fn load_model_config() -> ModelConfig {
    let models: Vec<String> = std::env::var("THUKI_SUPPORTED_AI_MODELS")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            s.split(',')
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty())
                .collect()
        })
        .unwrap_or_else(|| vec![DEFAULT_MODEL_NAME.to_string()]);
    let active = models
        .first()
        .cloned()
        .unwrap_or_else(|| DEFAULT_MODEL_NAME.to_string());
    ModelConfig {
        active,
        all: models,
    }
}

/// OpenAI-compatible endpoint configuration. Loaded once at startup from
/// the `THUKI_API_BASE_URL` and `THUKI_API_KEY` environment variables.
pub struct ApiConfig {
    pub base_url: String,
    pub api_key: String,
}

/// Reads the API base URL and key from environment variables, falling back
/// to defaults when unset or empty. The trailing slash is stripped so the
/// caller can unconditionally append `/chat/completions`.
pub fn load_api_config() -> ApiConfig {
    let base_url = std::env::var("THUKI_API_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string());
    let api_key = std::env::var("THUKI_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API_KEY.to_string());
    ApiConfig { base_url, api_key }
}

/// Returns the active model and full supported list to the frontend.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn get_model_config(model_config: tauri::State<'_, ModelConfig>) -> serde_json::Value {
    serde_json::json!({ "active": model_config.active, "all": model_config.all })
}

/// Finds the end index of the next SSE event in `buffer`. Events are
/// delimited by a blank line — either `\n\n` or `\r\n\r\n`. Returns the
/// byte index of the last delimiter byte (inclusive); caller should drain
/// up to and including that index.
fn find_sse_event(buffer: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < buffer.len() {
        if buffer[i] == b'\n' && buffer[i + 1] == b'\n' {
            return Some(i + 1);
        }
        if i + 3 < buffer.len()
            && buffer[i] == b'\r'
            && buffer[i + 1] == b'\n'
            && buffer[i + 2] == b'\r'
            && buffer[i + 3] == b'\n'
        {
            return Some(i + 3);
        }
        i += 1;
    }
    None
}

/// Processes a single SSE event (one or more `data:` lines). Returns `true`
/// when the sentinel `data: [DONE]` marker is encountered, indicating the
/// stream has completed naturally.
fn process_sse_event(
    event: &str,
    on_chunk: &impl Fn(StreamChunk),
    acc: &mut String,
    parser: &mut ThinkTagState,
) -> bool {
    for line in event.lines() {
        let trimmed = line.trim_start();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        if data == "[DONE]" {
            parser.flush(on_chunk, acc);
            on_chunk(StreamChunk::Done);
            return true;
        }
        if data.is_empty() {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<ChatCompletionsChunk>(data) else {
            continue;
        };
        for choice in &chunk.choices {
            let Some(delta) = &choice.delta else {
                continue;
            };
            if let Some(reasoning) = &delta.reasoning_content {
                if !reasoning.is_empty() {
                    on_chunk(StreamChunk::ThinkingToken(reasoning.clone()));
                }
            }
            if let Some(text) = &delta.content {
                if !text.is_empty() {
                    parser.process(text, on_chunk, acc);
                }
            }
        }
    }
    false
}

/// Core streaming logic for the OpenAI-compatible `/chat/completions`
/// endpoint, separated from the Tauri command for testability. Uses
/// `tokio::select!` to race each chunk read against the cancellation token,
/// ensuring the HTTP connection is dropped immediately when the user
/// cancels — which signals the server to stop inference. Returns the
/// accumulated assistant response so the caller can persist it.
pub async fn stream_ollama_chat(
    endpoint: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
    client: &reqwest::Client,
    cancel_token: CancellationToken,
    on_chunk: impl Fn(StreamChunk),
) -> String {
    let request_payload = ChatCompletionsRequest {
        model,
        messages: &messages,
        stream: true,
        temperature: 1.0,
        top_p: 0.95,
    };

    let mut accumulated = String::new();
    let mut tag_parser = ThinkTagState::new();

    let res = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&request_payload)
        .send()
        .await;

    match res {
        Ok(response) => {
            if !response.status().is_success() {
                let status = response.status().as_u16();
                on_chunk(StreamChunk::Error(classify_http_error(status)));
                return accumulated;
            }

            let mut stream = response.bytes_stream();
            let mut buffer: Vec<u8> = Vec::new();

            loop {
                tokio::select! {
                    biased;
                    _ = cancel_token.cancelled() => {
                        // Drop the stream — closes the HTTP connection,
                        // which signals the server to stop inference.
                        drop(stream);
                        on_chunk(StreamChunk::Cancelled);
                        return accumulated;
                    }
                    chunk_opt = stream.next() => {
                        match chunk_opt {
                            Some(Ok(bytes)) => {
                                buffer.extend_from_slice(&bytes);

                                while let Some(idx) = find_sse_event(&buffer) {
                                    let event_bytes =
                                        buffer.drain(..=idx).collect::<Vec<u8>>();
                                    if let Ok(event_text) = std::str::from_utf8(&event_bytes) {
                                        if process_sse_event(
                                            event_text,
                                            &on_chunk,
                                            &mut accumulated,
                                            &mut tag_parser,
                                        ) {
                                            return accumulated;
                                        }
                                    }
                                }
                            }
                            Some(Err(e)) => {
                                on_chunk(StreamChunk::Error(classify_stream_error(&e)));
                                return accumulated;
                            }
                            None => {
                                tag_parser.flush(&on_chunk, &mut accumulated);
                                return accumulated;
                            }
                        }
                    }
                }
            }
        }
        Err(e) => {
            on_chunk(StreamChunk::Error(classify_stream_error(&e)));
        }
    }

    accumulated
}

/// Streams a chat response from the configured OpenAI-compatible backend.
/// Appends the user message and assistant response to conversation history
/// after completion or cancellation (retaining context for follow-up
/// requests). Uses an epoch counter to prevent stale writes after a reset.
///
/// The `_think` parameter is accepted for IPC compatibility with the
/// frontend's `/think` slash command but is not sent on the wire — OpenAI
/// protocol has no standardised think flag, and the streamer already
/// extracts reasoning content from `reasoning_content` deltas and inline
/// `<think>…</think>` tags regardless.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn ask_ollama(
    message: String,
    quoted_text: Option<String>,
    image_paths: Option<Vec<String>>,
    _think: bool,
    on_event: Channel<StreamChunk>,
    client: State<'_, reqwest::Client>,
    generation: State<'_, GenerationState>,
    history: State<'_, ConversationHistory>,
    system_prompt: State<'_, SystemPrompt>,
    model_config: State<'_, ModelConfig>,
    api_config: State<'_, ApiConfig>,
) -> Result<(), String> {
    let endpoint = format!("{}/chat/completions", api_config.base_url);
    let cancel_token = CancellationToken::new();
    generation.set(cancel_token.clone());

    // Build user message content.  When quoted text is present, label it
    // explicitly so the model knows the highlighted text is the primary
    // subject and any attached images provide surrounding context.
    let content = match quoted_text {
        Some(ref qt) if !qt.trim().is_empty() => {
            format!("[Highlighted Text]\n\"{}\"\n\n[Request]\n{}", qt, message)
        }
        _ => message,
    };

    // Base64-encode attached images for the OpenAI multimodal API.
    let images = match image_paths {
        Some(ref paths) if !paths.is_empty() => {
            Some(crate::images::encode_images_as_base64(paths)?)
        }
        _ => None,
    };

    let user_msg = ChatMessage {
        role: "user".to_string(),
        content,
        images,
    };

    // Snapshot the current epoch and build the messages array for the API.
    // The user message is NOT yet committed to history — it is only added
    // after a response (including partial/cancelled) to prevent orphaned
    // messages on errors.
    let (epoch_at_start, messages) = {
        let conv = history.messages.lock().unwrap();
        let epoch = history.epoch.load(Ordering::SeqCst);
        let mut msgs = vec![ChatMessage {
            role: "system".to_string(),
            content: system_prompt.0.clone(),
            images: None,
        }];
        msgs.extend(conv.clone());
        msgs.push(user_msg.clone());
        (epoch, msgs)
    };

    let accumulated = stream_ollama_chat(
        &endpoint,
        &api_config.api_key,
        &model_config.active,
        messages,
        &client,
        cancel_token.clone(),
        |chunk| {
            let _ = on_event.send(chunk);
        },
    )
    .await;

    // Persist user + assistant messages to in-memory history when the epoch
    // has not changed (no reset during streaming) and we received content.
    // This includes cancelled generations so that subsequent requests retain
    // the conversational context (the user message and any partial response).
    let current_epoch = history.epoch.load(Ordering::SeqCst);
    if current_epoch == epoch_at_start && !accumulated.is_empty() {
        let mut conv = history.messages.lock().unwrap();
        // Preserve images in history so that follow-up messages can still
        // reference earlier screenshots or attachments.  The full conversation
        // (including base64 blobs) is replayed on every turn, which is fine
        // for a local/LAN server setup.
        conv.push(user_msg);
        conv.push(ChatMessage {
            role: "assistant".to_string(),
            content: accumulated,
            images: None,
        });
    }

    generation.clear();
    Ok(())
}

/// Cancels the currently active generation, if any.
///
/// Signals the `CancellationToken` stored in `GenerationState`, which causes the
/// `stream_ollama_chat` loop to exit immediately and drop the HTTP connection.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn cancel_generation(generation: State<'_, GenerationState>) -> Result<(), String> {
    generation.cancel();
    Ok(())
}

/// Clears the backend conversation history and increments the epoch counter.
/// The epoch increment prevents any in-flight `ask_ollama` from writing stale
/// messages into the freshly cleared history.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn reset_conversation(history: State<'_, ConversationHistory>) {
    history.epoch.fetch_add(1, Ordering::SeqCst);
    history.messages.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    fn collect_chunks() -> (Arc<StdMutex<Vec<StreamChunk>>>, impl Fn(StreamChunk)) {
        let chunks: Arc<StdMutex<Vec<StreamChunk>>> = Arc::new(StdMutex::new(Vec::new()));
        let chunks_clone = chunks.clone();
        let callback = move |chunk: StreamChunk| {
            chunks_clone.lock().unwrap().push(chunk);
        };
        (chunks, callback)
    }

    /// Helper: builds a single SSE event containing a `choices[].delta.content`
    /// token. Terminates with the double-newline that separates SSE events.
    fn sse_content(content: &str) -> String {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n",
            serde_json::Value::String(content.to_string())
        )
    }

    /// Helper: builds an SSE event containing only a `reasoning_content` delta.
    fn sse_reasoning(reasoning: &str) -> String {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"reasoning_content\":{}}}}}]}}\n\n",
            serde_json::Value::String(reasoning.to_string())
        )
    }

    /// Helper: SSE event with an empty delta — matches the pre-[DONE] chunk
    /// many providers send carrying only `finish_reason`.
    fn sse_finish() -> &'static str {
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
    }

    const SSE_DONE: &str = "data: [DONE]\n\n";

    /// Builds a reqwest client with no proxy configuration so tests are not
    /// affected by an ambient macOS system proxy that would otherwise
    /// intercept requests to `127.0.0.1:<port>` and rewrite connection
    /// failures as HTTP 502 gateway responses.
    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("test reqwest client")
    }

    #[tokio::test]
    async fn streams_tokens_from_valid_response() {
        let mut server = mockito::Server::new_async().await;
        let body = format!(
            "{}{}{}{}",
            sse_content("Hello"),
            sse_content(" world"),
            sse_finish(),
            SSE_DONE
        );
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
            images: None,
        }];

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            messages,
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(matches!(&chunks[0], StreamChunk::Token(t) if t == "Hello"));
        assert!(matches!(&chunks[1], StreamChunk::Token(t) if t == " world"));
        assert!(matches!(chunks.last().unwrap(), StreamChunk::Done));
        assert_eq!(accumulated, "Hello world");
    }

    #[tokio::test]
    async fn handles_http_500() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .with_status(500)
            .with_body("Internal Server Error")
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(matches!(&chunks[0], StreamChunk::Error(e) if e.kind == OllamaErrorKind::Other));
        assert!(accumulated.is_empty());
    }

    #[tokio::test]
    async fn handles_connection_refused() {
        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            "http://127.0.0.1:1/chat/completions",
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(matches!(&chunks[0], StreamChunk::Error(_)));
        assert!(accumulated.is_empty());
    }

    #[tokio::test]
    async fn handles_malformed_json() {
        let mut server = mockito::Server::new_async().await;
        let body = format!("data: not json at all\n\n{}{}", sse_content("ok"), SSE_DONE);
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks.iter().any(|c| matches!(c, StreamChunk::Done)));
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Token(t) if t == "ok")));
    }

    #[tokio::test]
    async fn handles_empty_response_body() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body("")
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks.is_empty());
        assert!(accumulated.is_empty());
    }

    #[tokio::test]
    async fn tokens_arrive_in_order() {
        let mut server = mockito::Server::new_async().await;
        let body = format!(
            "{}{}{}{}",
            sse_content("A"),
            sse_content("B"),
            sse_content("C"),
            SSE_DONE,
        );
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        let tokens: Vec<&str> = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Token(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tokens, vec!["A", "B", "C"]);
        assert_eq!(accumulated, "ABC");
    }

    #[tokio::test]
    async fn handles_invalid_utf8_in_stream() {
        let mut server = mockito::Server::new_async().await;
        // Invalid UTF-8 bytes form one "event" (terminated by \n\n) that we
        // cannot decode as a str — it must be skipped silently.  The next
        // event carries a normal token.
        let mut body = b"\xFF\xFE\n\n".to_vec();
        body.extend_from_slice(sse_content("ok").as_bytes());
        body.extend_from_slice(SSE_DONE.as_bytes());
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Token(t) if t == "ok")));
        assert!(chunks.iter().any(|c| matches!(c, StreamChunk::Done)));
    }

    #[tokio::test]
    async fn handles_mid_stream_network_error() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\n\
                      Content-Type: text/event-stream\r\n\
                      Transfer-Encoding: chunked\r\n\r\n\
                      4\r\ntest",
                )
                .await;
        });

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("http://127.0.0.1:{}/chat/completions", port),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        let chunks = chunks.lock().unwrap();
        let has_no_tokens = chunks.iter().all(|c| !matches!(c, StreamChunk::Token(_)));
        assert!(has_no_tokens);
    }

    #[tokio::test]
    async fn http_500_with_empty_body() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .with_status(500)
            .with_body("")
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(
            matches!(&chunks[0], StreamChunk::Error(e) if e.kind == OllamaErrorKind::Other && e.message.contains("500"))
        );
    }

    #[tokio::test]
    async fn non_data_sse_lines_are_skipped() {
        let mut server = mockito::Server::new_async().await;
        // Comments (starting with `:`) and event-id lines must be ignored.
        let body = format!(
            ": keep-alive comment\nid: 42\n\n{}{}",
            sse_content("hi"),
            SSE_DONE
        );
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Token(t) if t == "hi")));
        assert!(chunks.iter().any(|c| matches!(c, StreamChunk::Done)));
    }

    #[tokio::test]
    async fn empty_data_line_is_skipped() {
        let mut server = mockito::Server::new_async().await;
        let body = format!("data:\n\n{}{}", sse_content("ok"), SSE_DONE);
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Token(t) if t == "ok")));
    }

    #[tokio::test]
    async fn delta_absent_emits_only_done() {
        let mut server = mockito::Server::new_async().await;
        let body = format!(
            "data: {{\"choices\":[{{\"finish_reason\":\"stop\"}}]}}\n\n{}",
            SSE_DONE
        );
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks.iter().all(|c| !matches!(c, StreamChunk::Token(_))));
        assert!(chunks.iter().any(|c| matches!(c, StreamChunk::Done)));
    }

    #[tokio::test]
    async fn cancellation_stops_stream_and_emits_cancelled() {
        use std::sync::Arc;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let server_done = Arc::new(tokio::sync::Notify::new());
        let server_done_clone = server_done.clone();

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let first = sse_content("A");
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n{}",
                first
            );
            let _ = stream.write_all(header.as_bytes()).await;
            server_done_clone.notified().await;
        });

        let client = test_client();
        let token = CancellationToken::new();
        let token_clone = token.clone();
        let (chunks, callback) = collect_chunks();

        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            token_clone.cancel();
        });

        stream_ollama_chat(
            &format!("http://127.0.0.1:{}/chat/completions", port),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        let chunks = chunks.lock().unwrap();
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Token(t) if t == "A")));
        assert!(chunks.iter().any(|c| matches!(c, StreamChunk::Cancelled)));
        assert!(chunks.iter().all(|c| !matches!(c, StreamChunk::Done)));

        server_done.notify_one();
        tokio::task::yield_now().await;
    }

    #[tokio::test]
    async fn pre_cancelled_token_emits_cancelled_immediately() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_body(format!("{}{}", sse_content("Hello"), SSE_DONE))
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        token.cancel();

        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        let chunks = chunks.lock().unwrap();
        assert!(chunks.iter().any(|c| matches!(c, StreamChunk::Cancelled)));
    }

    #[tokio::test]
    async fn sends_messages_array_in_request() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"messages":[{"role":"system","content":"Be helpful"},{"role":"user","content":"hi"}]}"#.to_string(),
            ))
            .with_body(SSE_DONE)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (_, callback) = collect_chunks();
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "Be helpful".to_string(),
                images: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
                images: None,
            },
        ];

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            messages,
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn sends_bearer_authorization_header() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .match_header("Authorization", "Bearer sk-test-42")
            .with_body(SSE_DONE)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (_, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test-42",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn delta_content_absent_emits_only_done() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(format!(
                "data: {{\"choices\":[{{\"delta\":{{\"role\":\"assistant\"}}}}]}}\n\n{}",
                SSE_DONE
            ))
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks.iter().all(|c| !matches!(c, StreamChunk::Token(_))));
        assert!(chunks.iter().any(|c| matches!(c, StreamChunk::Done)));
    }

    #[test]
    fn generation_state_set_and_cancel() {
        let state = GenerationState::new();
        let token = CancellationToken::new();
        let token_clone = token.clone();

        state.set(token);
        assert!(!token_clone.is_cancelled());

        state.cancel();
        assert!(token_clone.is_cancelled());
    }

    #[test]
    fn generation_state_cancel_when_empty() {
        let state = GenerationState::new();
        state.cancel();
    }

    #[test]
    fn generation_state_clear_does_not_cancel() {
        let state = GenerationState::new();
        let token = CancellationToken::new();
        let token_clone = token.clone();

        state.set(token);
        state.clear();
        assert!(!token_clone.is_cancelled());
    }

    #[test]
    fn generation_state_set_replaces_previous() {
        let state = GenerationState::new();
        let first = CancellationToken::new();
        let first_clone = first.clone();
        let second = CancellationToken::new();
        let second_clone = second.clone();

        state.set(first);
        state.set(second);

        state.cancel();
        assert!(!first_clone.is_cancelled());
        assert!(second_clone.is_cancelled());
    }

    /// Guard to serialize tests that mutate environment variables.
    /// Rust runs tests in parallel by default; without serialization these
    /// tests race on shared environment variables.
    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    // ── load_model_config tests ──────────────────────────────────────────────

    #[test]
    fn load_model_config_returns_default_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("THUKI_SUPPORTED_AI_MODELS");
        let config = load_model_config();
        assert_eq!(config.active, DEFAULT_MODEL_NAME);
        assert_eq!(config.all, vec![DEFAULT_MODEL_NAME.to_string()]);
    }

    #[test]
    fn load_model_config_reads_single_model() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_SUPPORTED_AI_MODELS", "gemma4:e4b");
        let config = load_model_config();
        assert_eq!(config.active, "gemma4:e4b");
        assert_eq!(config.all, vec!["gemma4:e4b".to_string()]);
        std::env::remove_var("THUKI_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn load_model_config_reads_multiple_models_first_is_active() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_SUPPORTED_AI_MODELS", "gemma4:e2b,gemma4:e4b");
        let config = load_model_config();
        assert_eq!(config.active, "gemma4:e2b");
        assert_eq!(
            config.all,
            vec!["gemma4:e2b".to_string(), "gemma4:e4b".to_string()]
        );
        std::env::remove_var("THUKI_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn load_model_config_trims_whitespace_around_entries() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_SUPPORTED_AI_MODELS", " gemma4:e2b , gemma4:e4b ");
        let config = load_model_config();
        assert_eq!(config.active, "gemma4:e2b");
        assert_eq!(
            config.all,
            vec!["gemma4:e2b".to_string(), "gemma4:e4b".to_string()]
        );
        std::env::remove_var("THUKI_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn load_model_config_falls_back_to_default_when_whitespace_only() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_SUPPORTED_AI_MODELS", "   ");
        let config = load_model_config();
        assert_eq!(config.active, DEFAULT_MODEL_NAME);
        assert_eq!(config.all, vec![DEFAULT_MODEL_NAME.to_string()]);
        std::env::remove_var("THUKI_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn load_model_config_filters_empty_entries_from_list() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_SUPPORTED_AI_MODELS", "gemma4:e2b,,gemma4:e4b");
        let config = load_model_config();
        assert_eq!(
            config.all,
            vec!["gemma4:e2b".to_string(), "gemma4:e4b".to_string()]
        );
        std::env::remove_var("THUKI_SUPPORTED_AI_MODELS");
    }

    #[test]
    fn load_model_config_falls_back_when_all_entries_are_empty_commas() {
        let _guard = ENV_LOCK.lock().unwrap();
        // All entries filter to empty strings, leaving an empty list.
        // The active model must still fall back to DEFAULT_MODEL_NAME.
        std::env::set_var("THUKI_SUPPORTED_AI_MODELS", ",");
        let config = load_model_config();
        assert_eq!(config.active, DEFAULT_MODEL_NAME);
        assert_eq!(config.all, Vec::<String>::new());
        std::env::remove_var("THUKI_SUPPORTED_AI_MODELS");
    }

    // ── load_api_config tests ────────────────────────────────────────────────

    #[test]
    fn load_api_config_returns_defaults_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("THUKI_API_BASE_URL");
        std::env::remove_var("THUKI_API_KEY");
        let cfg = load_api_config();
        assert_eq!(cfg.base_url, DEFAULT_API_BASE_URL);
        assert_eq!(cfg.api_key, DEFAULT_API_KEY);
    }

    #[test]
    fn load_api_config_reads_env_vars() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_API_BASE_URL", "http://example.test:9000/v1");
        std::env::set_var("THUKI_API_KEY", "sk-abc");
        let cfg = load_api_config();
        assert_eq!(cfg.base_url, "http://example.test:9000/v1");
        assert_eq!(cfg.api_key, "sk-abc");
        std::env::remove_var("THUKI_API_BASE_URL");
        std::env::remove_var("THUKI_API_KEY");
    }

    #[test]
    fn load_api_config_strips_trailing_slash() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_API_BASE_URL", "http://example.test:9000/v1/");
        let cfg = load_api_config();
        assert_eq!(cfg.base_url, "http://example.test:9000/v1");
        std::env::remove_var("THUKI_API_BASE_URL");
    }

    #[test]
    fn load_api_config_ignores_blank_env_vars() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_API_BASE_URL", "   ");
        std::env::set_var("THUKI_API_KEY", "   ");
        let cfg = load_api_config();
        assert_eq!(cfg.base_url, DEFAULT_API_BASE_URL);
        assert_eq!(cfg.api_key, DEFAULT_API_KEY);
        std::env::remove_var("THUKI_API_BASE_URL");
        std::env::remove_var("THUKI_API_KEY");
    }

    // ── sampling options test ────────────────────────────────────────────────

    #[tokio::test]
    async fn sends_sampling_options_in_request() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"temperature":1.0,"top_p":0.95,"stream":true}"#.to_string(),
            ))
            .with_body(SSE_DONE)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (_, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
    }

    #[test]
    fn load_system_prompt_returns_default_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("THUKI_SYSTEM_PROMPT");

        let prompt = load_system_prompt();
        assert_eq!(prompt, DEFAULT_SYSTEM_PROMPT);
    }

    #[test]
    fn load_system_prompt_reads_env_var() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_SYSTEM_PROMPT", "Custom prompt");

        let prompt = load_system_prompt();
        assert_eq!(prompt, "Custom prompt");

        std::env::remove_var("THUKI_SYSTEM_PROMPT");
    }

    #[test]
    fn load_system_prompt_ignores_empty_env_var() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("THUKI_SYSTEM_PROMPT", "   ");

        let prompt = load_system_prompt();
        assert_eq!(prompt, DEFAULT_SYSTEM_PROMPT);

        std::env::remove_var("THUKI_SYSTEM_PROMPT");
    }

    #[test]
    fn conversation_history_new_starts_at_epoch_zero() {
        let h = ConversationHistory::new();
        assert_eq!(h.epoch.load(Ordering::SeqCst), 0);
        assert!(h.messages.lock().unwrap().is_empty());
    }

    #[test]
    fn conversation_history_epoch_increments_on_clear() {
        let h = ConversationHistory::new();
        h.messages.lock().unwrap().push(ChatMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
            images: None,
        });

        h.epoch.fetch_add(1, Ordering::SeqCst);
        h.messages.lock().unwrap().clear();

        assert_eq!(h.epoch.load(Ordering::SeqCst), 1);
        assert!(h.messages.lock().unwrap().is_empty());
    }

    // ─── OllamaError classification ───────────────────────────────────────────

    #[test]
    fn classify_http_404_returns_model_not_found() {
        let err = classify_http_error(404);
        assert_eq!(err.kind, OllamaErrorKind::ModelNotFound);
        assert!(err.message.contains("Model not found"));
    }

    #[test]
    fn classify_http_500_returns_other_with_status() {
        let err = classify_http_error(500);
        assert_eq!(err.kind, OllamaErrorKind::Other);
        assert!(err.message.contains("500"));
    }

    #[test]
    fn classify_http_401_returns_other_with_status() {
        let err = classify_http_error(401);
        assert_eq!(err.kind, OllamaErrorKind::Other);
        assert!(err.message.contains("401"));
    }

    #[tokio::test]
    async fn connection_refused_emits_not_running_error() {
        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            "http://127.0.0.1:1/chat/completions",
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(
            matches!(&chunks[0], StreamChunk::Error(e) if e.kind == OllamaErrorKind::NotRunning)
        );
    }

    #[tokio::test]
    async fn http_404_emits_model_not_found_error() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .with_status(404)
            .with_body("")
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(
            matches!(&chunks[0], StreamChunk::Error(e) if e.kind == OllamaErrorKind::ModelNotFound)
        );
    }

    #[test]
    fn thinking_token_serializes_correctly() {
        let chunk = StreamChunk::ThinkingToken("reasoning step".to_string());
        let json = serde_json::to_value(&chunk).unwrap();
        assert_eq!(json["type"], "ThinkingToken");
        assert_eq!(json["data"], "reasoning step");
    }

    #[test]
    fn delta_deserializes_content_and_reasoning() {
        let json = r#"{"content":"hello","reasoning_content":"let me think"}"#;
        let d: Delta = serde_json::from_str(json).unwrap();
        assert_eq!(d.content.unwrap(), "hello");
        assert_eq!(d.reasoning_content.unwrap(), "let me think");
    }

    #[test]
    fn delta_accepts_reasoning_alias() {
        let json = r#"{"reasoning":"o1-style"}"#;
        let d: Delta = serde_json::from_str(json).unwrap();
        assert_eq!(d.reasoning_content.unwrap(), "o1-style");
    }

    #[test]
    fn delta_deserializes_without_reasoning() {
        let json = r#"{"content":"hello"}"#;
        let d: Delta = serde_json::from_str(json).unwrap();
        assert_eq!(d.content.unwrap(), "hello");
        assert!(d.reasoning_content.is_none());
    }

    #[tokio::test]
    async fn http_500_emits_other_error_with_status() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .with_status(500)
            .with_body("Internal Server Error")
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(
            matches!(&chunks[0], StreamChunk::Error(e) if e.kind == OllamaErrorKind::Other && e.message.contains("500"))
        );
    }

    // ─── reasoning_content streaming ────────────────────────────────────────

    #[tokio::test]
    async fn stream_emits_reasoning_as_thinking_tokens() {
        let mut server = mockito::Server::new_async().await;
        let body = format!(
            "{}{}{}",
            sse_reasoning("step 1"),
            sse_content("Hello"),
            SSE_DONE,
        );
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(matches!(&chunks[0], StreamChunk::ThinkingToken(t) if t == "step 1"));
        assert!(matches!(&chunks[1], StreamChunk::Token(t) if t == "Hello"));
        assert!(matches!(chunks.last().unwrap(), StreamChunk::Done));
        // Accumulated contains only visible content, not the thinking stream.
        assert_eq!(accumulated, "Hello");
    }

    #[tokio::test]
    async fn stream_skips_empty_reasoning_delta() {
        let mut server = mockito::Server::new_async().await;
        let body = format!("{}{}{}", sse_reasoning(""), sse_content("Hello"), SSE_DONE,);
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks
            .iter()
            .all(|c| !matches!(c, StreamChunk::ThinkingToken(_))));
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Token(t) if t == "Hello")));
    }

    // ─── <think>…</think> inline tag parsing ─────────────────────────────────

    #[tokio::test]
    async fn inline_think_tag_is_split_into_thinking_and_content() {
        let mut server = mockito::Server::new_async().await;
        let body = format!("{}{}", sse_content("<think>hmm</think>answer"), SSE_DONE,);
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        let thinking: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::ThinkingToken(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        let content: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Token(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, "hmm");
        assert_eq!(content, "answer");
        assert_eq!(accumulated, "answer");
    }

    #[tokio::test]
    async fn think_tag_split_across_deltas() {
        let mut server = mockito::Server::new_async().await;
        // The open tag is split: "<thi" ends one delta, "nk>why</think>done"
        // completes the thinking block and starts visible content.
        let body = format!(
            "{}{}{}",
            sse_content("<thi"),
            sse_content("nk>why</think>done"),
            SSE_DONE,
        );
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        let thinking: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::ThinkingToken(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        let content: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Token(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, "why");
        assert_eq!(content, "done");
        assert_eq!(accumulated, "done");
    }

    #[tokio::test]
    async fn unterminated_think_tag_flushes_as_thinking() {
        let mut server = mockito::Server::new_async().await;
        // Stream ends mid-think-block without a closing tag — the buffered
        // content should still be flushed as thinking, not lost.
        let body = format!("{}{}", sse_content("<think>still going"), SSE_DONE);
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::ThinkingToken(t) if t == "still going")));
    }

    #[tokio::test]
    async fn partial_tag_tail_held_until_stream_end_is_flushed_as_content() {
        let mut server = mockito::Server::new_async().await;
        // Last delta ends with "<thi" which is a partial tag tail.  When the
        // stream closes with no more data, the tail is not a real tag so it
        // must be flushed as visible content rather than silently dropped.
        let body = format!("{}{}", sse_content("hi<thi"), SSE_DONE);
        let mock = server
            .mock("POST", "/chat/completions")
            .with_body(body)
            .create_async()
            .await;

        let client = test_client();
        let token = CancellationToken::new();
        let (chunks, callback) = collect_chunks();

        let accumulated = stream_ollama_chat(
            &format!("{}/chat/completions", server.url()),
            "sk-test",
            "test-model",
            vec![],
            &client,
            token,
            callback,
        )
        .await;

        mock.assert_async().await;
        let chunks = chunks.lock().unwrap();
        let content: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Token(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(content, "hi<thi");
        assert_eq!(accumulated, "hi<thi");
    }

    // ─── think-tag-parser unit tests ─────────────────────────────────────────

    #[test]
    fn potential_tag_tail_full_prefix() {
        assert_eq!(potential_tag_tail("abc<thi", "<think>"), 4);
    }

    #[test]
    fn potential_tag_tail_single_char_prefix() {
        assert_eq!(potential_tag_tail("abc<", "<think>"), 1);
    }

    #[test]
    fn potential_tag_tail_no_match() {
        assert_eq!(potential_tag_tail("abc", "<think>"), 0);
    }

    #[test]
    fn potential_tag_tail_empty_string() {
        assert_eq!(potential_tag_tail("", "<think>"), 0);
    }

    #[test]
    fn potential_tag_tail_shorter_than_full_tag() {
        // "</t" is a valid prefix of "</think>" of length 3.
        assert_eq!(potential_tag_tail("some</t", "</think>"), 3);
    }

    #[test]
    fn think_tag_state_emits_normal_content() {
        let mut state = ThinkTagState::new();
        let (chunks, cb) = collect_chunks();
        let mut acc = String::new();
        state.process("hello", &cb, &mut acc);
        let chunks = chunks.lock().unwrap();
        assert!(chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Token(t) if t == "hello")));
        assert_eq!(acc, "hello");
    }

    #[test]
    fn think_tag_state_splits_complete_tag_in_single_delta() {
        let mut state = ThinkTagState::new();
        let (chunks, cb) = collect_chunks();
        let mut acc = String::new();
        state.process("a<think>b</think>c", &cb, &mut acc);
        let chunks = chunks.lock().unwrap();
        let thinking: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::ThinkingToken(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        let content: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Token(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, "b");
        assert_eq!(content, "ac");
        assert_eq!(acc, "ac");
    }

    #[test]
    fn think_tag_state_flush_normal_buffer_emits_as_content() {
        let mut state = ThinkTagState::new();
        let (chunks, cb) = collect_chunks();
        let mut acc = String::new();
        // Enter and exit a brief think block to land a ThinkingToken in the
        // chunk list so the filter_map below exercises both arms.
        state.process("<think>brief</think>", &cb, &mut acc);
        // Feed a partial open tag — it stays buffered.
        state.process("abc<thi", &cb, &mut acc);
        // Flush — the tail is not a real tag, so it must surface as content.
        state.flush(&cb, &mut acc);
        let chunks = chunks.lock().unwrap();
        let all_tokens: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Token(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(all_tokens, "abc<thi");
        assert_eq!(acc, "abc<thi");
    }

    #[test]
    fn think_tag_state_flush_in_think_mode_emits_as_thinking() {
        let mut state = ThinkTagState::new();
        let (chunks, cb) = collect_chunks();
        let mut acc = String::new();
        // Emit some visible content first so the filter_map below exercises
        // both arms (Token → _ arm, ThinkingToken → Some arm).
        state.process("hi", &cb, &mut acc);
        // Enter think mode and buffer a partial close tag tail at the end.
        state.process("<think>abc</thi", &cb, &mut acc);
        // Flush with carry="</thi" and in_think=true: the held tail must
        // surface as a ThinkingToken rather than being silently dropped.
        state.flush(&cb, &mut acc);
        let chunks = chunks.lock().unwrap();
        let thinking: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::ThinkingToken(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, "abc</thi");
        assert_eq!(acc, "hi");
    }

    #[test]
    fn think_tag_state_flush_empty_buffer_emits_nothing() {
        let mut state = ThinkTagState::new();
        let (chunks, cb) = collect_chunks();
        let mut acc = String::new();
        state.flush(&cb, &mut acc);
        let chunks = chunks.lock().unwrap();
        assert!(chunks.is_empty());
    }

    // ─── ChatMessage wire format ─────────────────────────────────────────────

    #[test]
    fn chat_message_serializes_plain_string_without_images() {
        let msg = ChatMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
            images: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["role"], "user");
        assert_eq!(json["content"], "hi");
    }

    #[test]
    fn chat_message_serializes_empty_image_list_as_plain_string() {
        let msg = ChatMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
            images: Some(vec![]),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["content"], "hi");
    }

    #[test]
    fn chat_message_serializes_images_as_multimodal_content_array() {
        let msg = ChatMessage {
            role: "user".to_string(),
            content: "what is this?".to_string(),
            images: Some(vec!["AAAA".to_string(), "BBBB".to_string()]),
        };
        let json = serde_json::to_value(&msg).unwrap();
        let arr = json["content"].as_array().expect("content should be array");
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "what is this?");
        assert_eq!(arr[1]["type"], "image_url");
        assert_eq!(arr[1]["image_url"]["url"], "data:image/jpeg;base64,AAAA");
        assert_eq!(arr[2]["type"], "image_url");
        assert_eq!(arr[2]["image_url"]["url"], "data:image/jpeg;base64,BBBB");
    }

    #[test]
    fn chat_message_serializes_images_with_empty_text_as_image_only_array() {
        let msg = ChatMessage {
            role: "user".to_string(),
            content: String::new(),
            images: Some(vec!["AAAA".to_string()]),
        };
        let json = serde_json::to_value(&msg).unwrap();
        let arr = json["content"].as_array().expect("content should be array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "image_url");
    }

    // ─── SSE framing helper ─────────────────────────────────────────────────

    #[test]
    fn find_sse_event_returns_none_for_partial_event() {
        assert_eq!(find_sse_event(b"data: hi\n"), None);
        assert_eq!(find_sse_event(b""), None);
        assert_eq!(find_sse_event(b"d"), None);
    }

    #[test]
    fn find_sse_event_detects_lf_delimiter() {
        // "data: hi\n\n" — index of the second '\n' is 9.
        assert_eq!(find_sse_event(b"data: hi\n\n"), Some(9));
    }

    #[test]
    fn find_sse_event_detects_crlf_delimiter() {
        // "data: hi\r\n\r\n" — index of the last '\n' is 11.
        assert_eq!(find_sse_event(b"data: hi\r\n\r\n"), Some(11));
    }

    #[test]
    fn find_sse_event_returns_first_event_when_multiple_present() {
        let buf = b"data: a\n\ndata: b\n\n";
        assert_eq!(find_sse_event(buf), Some(8));
    }
}
