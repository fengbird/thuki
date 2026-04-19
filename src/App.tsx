import { motion, AnimatePresence } from 'framer-motion';
import type React from 'react';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useLayoutEffect,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { useOllama } from './hooks/useOllama';
import type { Message } from './hooks/useOllama';
import { ConversationView } from './view/ConversationView';
import { AskBarView, MAX_IMAGES } from './view/AskBarView';
import { OnboardingView } from './view/onboarding/index';
import type { OnboardingStage } from './view/onboarding/index';
import { ReplyDraftView } from './view/ReplyDraftView';
import { SettingsView } from './view/SettingsView';
import { ImagePreviewModal } from './components/ImagePreviewModal';
import type { AttachedImage } from './types/image';
import { MAX_IMAGE_SIZE_BYTES } from './types/image';
import { quote } from './config';
import { buildPrompt, mergeCommands } from './config/commands';
import type { CommandsConfig, ActiveCommand } from './config/commands';
import './App.css';

const OVERLAY_VISIBILITY_EVENT = 'oling://visibility';
const ONBOARDING_EVENT = 'oling://onboarding';
const REPLY_DRAFT_OPEN_EVENT = 'oling://reply-draft-open';
const REPLY_DRAFT_IMAGE_EVENT = 'oling://reply-draft-image';
const SETTINGS_OPEN_EVENT = 'oling://settings-open';
const OVERLAY_SUBMIT_EVENT = 'oling://overlay-submit';

/** Payload for `oling://overlay-submit` — image-bridge from the overlay
 *  window to the main chat. `autoSubmit` is true for the "OCR" shortcut. */
interface OverlaySubmitPayload {
  imagePath: string;
  prompt?: string | null;
  autoSubmit: boolean;
}

/** Payload for `oling://reply-draft-open` — app identity only; the
 * screenshot arrives in a separate image event once CG capture finishes. */
interface ReplyDraftOpenPayload {
  bundle_id: string;
  app_name: string;
}

/** Payload for `oling://reply-draft-image` — exactly one of `image_path`
 * (success) or `error` (failure) is populated per emission. */
interface ReplyDraftImagePayload {
  image_path: string | null;
  error: string | null;
}

/** Combined reply-flow state tracked by `App.tsx`. Populated in two steps:
 * first from the `open` event (imagePath/captureError both null), then from
 * the `image` event which fills one of the two. */
interface ReplyContext {
  bundleId: string;
  appName: string;
  imagePath: string | null;
  captureError: string | null;
}

/**
 * Authoritative deadline from the start of the hide transition to the native
 * window hide call. Accounts for WKWebView `requestAnimationFrame` throttling
 * in non-key windows, which stalls spring animations indefinitely and makes
 * `AnimatePresence.onExitComplete` unreliable when the panel is unfocused.
 */
const HIDE_COMMIT_DELAY_MS = 350;

/** Must match `OVERLAY_LOGICAL_WIDTH` in `src-tauri/src/lib.rs`. */
const OVERLAY_WIDTH = 600;
/** Total transparent padding around the morphing container: pt-2(8) + pb-6(24) + motion py-2(16). */
const CONTAINER_VERTICAL_PADDING = 48;
/** Max morphing-container height in chat mode (matches `max-h-[600px]`) + vertical padding. */
const MAX_CHAT_WINDOW_HEIGHT = 600 + CONTAINER_VERTICAL_PADDING;

/** Must match `OVERLAY_LOGICAL_HEIGHT_COLLAPSED` in `src-tauri/src/lib.rs`. */
const COLLAPSED_WINDOW_HEIGHT = 80;

/**
 * Parses a message to detect all valid slash commands present as whole words.
 * Derives detectable commands from the provided list so adding a command
 * to the registry is sufficient (no hardcoded trigger strings here).
 * Also returns the message with command triggers stripped for the LLM.
 */
export function parseCommands(
  text: string,
  commands: readonly { trigger: string }[],
): {
  found: Set<string>;
  strippedMessage: string;
} {
  const words = text.trim().split(/\s+/);
  const triggerSet = new Set(commands.map((c) => c.trigger));
  const found = new Set<string>();
  const remaining: string[] = [];
  for (const word of words) {
    if (triggerSet.has(word)) {
      found.add(word);
    } else {
      remaining.push(word);
    }
  }
  return { found, strippedMessage: remaining.join(' ') };
}

type OverlayVisibilityPayload =
  | {
      state: 'show';
      selected_text: string | null;
      selected_source?: 'selection' | 'clipboard' | null;
      window_x: number | null;
      window_y: number | null;
      screen_bottom_y: number | null;
    }
  | { state: 'hide-request' };
type OverlayState = 'visible' | 'hidden' | 'hiding';

/**
 * Main application orchestrator for Oling.
 *
 * Implements an adaptive morphing UI container. It starts as a minimal spotlight-style
 * input bar (`AskBarView`), then smoothly transforms into a full chat window
 * (`ConversationView`) when the user sends their first message.
 *
 * This wrapper is strictly responsible for layout morphing, global hotkeys,
 * and window visibility state, delegating UI rendering logic to the view components.
 */
function App() {
  const [query, setQuery] = useState('');
  const [overlayState, setOverlayState] = useState<OverlayState>('hidden');
  /** Non-null when the backend signals onboarding is needed; holds the current stage. */
  const [onboardingStage, setOnboardingStage] =
    useState<OnboardingStage | null>(null);

  /** Non-null while the ⌃⇧R reply-draft flow is active. Populated by the
   * two-phase reply events: `open` seeds it with app identity, `image`
   * fills in either `imagePath` on success or `captureError` on failure. */
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null);

  /** `true` while the Settings panel is visible (opened from tray or ⌘,). */
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  /** Slash command config loaded from the backend on mount and after settings save. */
  const [commandsConfig, setCommandsConfig] = useState<CommandsConfig | null>(
    null,
  );
  /** Active commands = built-in merged with user config. */
  const activeCommands: readonly ActiveCommand[] = useMemo(
    () => mergeCommands(commandsConfig),
    [commandsConfig],
  );

  /**
   * Direct reference to the morphing container DOM node, stored alongside the
   * ResizeObserver so the dropdown sync effect can mutate `style.minHeight`
   * without going through React state (direct DOM mutation + CSS transition).
   */
  const morphingContainerNodeRef = useRef<HTMLDivElement | null>(null);

  const { messages, ask, cancel, isGenerating, reset } = useOllama();

  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** Images attached to the current (unsent) message. Blob URLs render
   *  immediately; file paths are set asynchronously after Rust processing. */
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  /** URL of the image currently open in the preview modal (blob or asset URL). */
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  /**
   * Drag state passed to AskBarView for visual ring feedback.
   * "normal" = under capacity (violet ring); "max" = at capacity (red ring + label).
   * null = no active drag.
   */
  const [isDragOver, setIsDragOver] = useState<'normal' | 'max' | null>(null);

  /** When the user submits while images are still processing, the submit
   *  intent is stored here. The effect below watches `attachedImages` and
   *  fires the actual `ask()` once every image has a resolved `filePath`.
   *  Also stores `promptOverride` when the deferred submit originates from
   *  a utility command, and `context` for any quoted selected text. */
  const pendingSubmitRef = useRef<{
    query: string;
    context: string | undefined;
    think: boolean;
    promptOverride?: string;
  } | null>(null);
  /** True while waiting for images to finish processing before a deferred
   *  submit. Drives the "waiting" UI state in the ask bar. */
  const [isSubmitPending, setIsSubmitPending] = useState(false);
  /** User message shown in the chat while waiting for images to finish
   *  processing. Cleared when `ask()` fires and adds the real message. */
  const [pendingUserMessage, setPendingUserMessage] = useState<Message | null>(
    null,
  );

  /**
   * Session counter — incremented on each overlay open. Used in the motion
   * key to force AnimatePresence to fully unmount the stale tree before
   * mounting a fresh one, preventing a flash of the previous conversation.
   */
  const [sessionId, setSessionId] = useState(0);
  const [selectedContext, setSelectedContext] = useState<string | null>(null);
  const [selectedContextSource, setSelectedContextSource] = useState<
    'selection' | 'clipboard' | null
  >(null);
  useEffect(() => {
    if (selectedContext === null) {
      setSelectedContextSource(null);
    }
  }, [selectedContext]);
  /**
   * True when the window is near the screen bottom and should grow upward.
   * Flips the outer container to `justify-end` so content pins to the bottom.
   */
  const [growsUpward, setGrowsUpward] = useState(false);

  /**
   * Determines whether the UI has entered "chat mode" — i.e., the morphing
   * chat window state with message bubbles. Transitions from input-bar mode
   * to chat-window mode are animated via Framer Motion `layout` prop.
   */
  const isChatMode = messages.length > 0 || isGenerating || isSubmitPending;
  const previousIsChatModeRef = useRef(isChatMode);

  const shouldRenderOverlay = overlayState === 'visible';

  /**
   * Reference stored for ResizeObserver cleanup.
   */
  const observerRef = useRef<ResizeObserver | null>(null);

  /**
   * Mirror of `growsUpward` as a ref so the ResizeObserver closure can read
   * it without being recreated on each state change.
   */
  const growsUpwardRef = useRef(false);

  /**
   * Stores the window's fixed bottom Y and X for upward-growth sessions.
   * The bottom stays pinned while the top edge moves up as content grows.
   */
  const windowPosRef = useRef({ x: 0, bottomY: 0 });

  /**
   * Mirror of `isGenerating` as a ref so the ResizeObserver closure can
   * check streaming state without being recreated on each render.
   */
  const isGeneratingRef = useRef(false);
  isGeneratingRef.current = isGenerating;

  /**
   * High-water mark for window height during streaming. While the LLM is
   * generating, the window only grows (never shrinks) to prevent jitter
   * from Streamdown's block-element reflows. Reset when generation ends
   * or a new session starts.
   */
  const maxHeightRef = useRef(0);

  /**
   * Callback ref to reliably attach the ResizeObserver when the conditionally
   * rendered Framer Motion container actually mounts in the DOM. This fixes
   * the bug where a standard useEffect would run before the DOM node was ready,
   * leaving the native window stuck at 600x700.
   *
   * When `growsUpwardRef` is true (window near screen bottom), the observer
   * also repositions the window upward to keep its bottom pinned as the
   * conversation grows.
   */
  /**
   * Reference to the ResizeObserver attached to the reply-draft wrapper.
   * Stored so `setReplyContainerRef` can disconnect the previous observer
   * before attaching a new one (re-attaches can happen when React
   * re-creates the DOM node during Fast Refresh or consecutive reply
   * events).
   */
  const replyObserverRef = useRef<ResizeObserver | null>(null);

  /**
   * Callback ref for the reply-draft wrapper. Observes its intrinsic
   * height and resizes the native Tauri window to match so the reply
   * panel is never clipped by the overlay's collapsed 80px height.
   * Mirrors the pattern used by `setContainerRef` for the normal chat
   * container.
   */
  const setReplyContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (replyObserverRef.current) {
      replyObserverRef.current.disconnect();
      replyObserverRef.current = null;
    }

    if (node) {
      const observer = new ResizeObserver(
        /* v8 ignore start -- ResizeObserver callback requires a native browser resize event */
        (entries) => {
          requestAnimationFrame(() => {
            for (const entry of entries) {
              const rect = entry.target.getBoundingClientRect();
              const targetHeight =
                Math.ceil(rect.height) + CONTAINER_VERTICAL_PADDING;
              void getCurrentWindow().setSize(
                new LogicalSize(OVERLAY_WIDTH, targetHeight),
              );
            }
          });
        },
        /* v8 ignore stop */
      );
      observer.observe(node);
      replyObserverRef.current = observer;
    }
  }, []);

  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    morphingContainerNodeRef.current = node;

    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (node) {
      const observer = new ResizeObserver(
        /* v8 ignore start -- ResizeObserver callback requires a native browser resize event */
        (entries) => {
          requestAnimationFrame(() => {
            for (const entry of entries) {
              const rect = entry.target.getBoundingClientRect();
              // Total vertical room: 8px (pt-2) + 24px (pb-6) + 16px (motion py-2) = 48px.
              // This ensures the tightened drop shadows aren't clipped by the native window edge.
              let targetHeight =
                Math.ceil(rect.height) + CONTAINER_VERTICAL_PADDING;

              // During streaming, only allow the window to grow (never
              // shrink) to prevent jitter from Streamdown block reflows.
              if (isGeneratingRef.current) {
                if (targetHeight > maxHeightRef.current) {
                  maxHeightRef.current = targetHeight;
                } else {
                  targetHeight = maxHeightRef.current;
                }
              }

              if (growsUpwardRef.current) {
                // Grow upward: pin the window bottom and expand the top edge.
                // Clamp Y so the window never extends above the menu bar.
                const { x, bottomY } = windowPosRef.current;
                const newY = Math.max(0, bottomY - targetHeight);
                void invoke('set_window_frame', {
                  x,
                  y: newY,
                  width: OVERLAY_WIDTH,
                  height: targetHeight,
                });
              } else {
                void getCurrentWindow().setSize(
                  new LogicalSize(OVERLAY_WIDTH, targetHeight),
                );
              }
            }
          });
        },
        /* v8 ignore stop */
      );

      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  /**
   * Reset the high-water mark when streaming finishes so the window can
   * shrink back to its natural content height on the next resize event.
   */
  useEffect(() => {
    if (!isGenerating) {
      maxHeightRef.current = 0;
    }
  }, [isGenerating]);

  /**
   * Deletes transient image files that were staged for the current ephemeral
   * session. This intentionally runs on best effort only.
   */
  const cleanupSessionImages = useCallback(() => {
    const paths = new Set<string>();

    for (const image of attachedImages) {
      if (image.filePath) {
        paths.add(image.filePath);
      }
    }

    for (const message of messages) {
      for (const imagePath of message.imagePaths ?? []) {
        if (imagePath && !imagePath.startsWith('blob:')) {
          paths.add(imagePath);
        }
      }
    }

    for (const imagePath of pendingUserMessage?.imagePaths ?? []) {
      if (imagePath && !imagePath.startsWith('blob:')) {
        paths.add(imagePath);
      }
    }

    if (
      replyContext?.imagePath &&
      !replyContext.imagePath.startsWith('blob:')
    ) {
      paths.add(replyContext.imagePath);
    }

    for (const path of paths) {
      void invoke('remove_image_command', { path }).catch(() => {
        // Best-effort cleanup only — session teardown should not surface noise.
      });
    }
  }, [attachedImages, messages, pendingUserMessage, replyContext]);

  /**
   * Replays the entrance sequence by transitioning the overlay to the visible state.
   * Clears conversation state for a fresh session each time the overlay appears.
   */
  const replayEntranceAnimation = useCallback(
    (
      context: string | null,
      source: 'selection' | 'clipboard' | null,
      windowX: number | null,
      windowY: number | null,
      screenBottomY: number | null,
    ) => {
      const shouldGrowUp =
        windowY !== null &&
        screenBottomY !== null &&
        windowY + MAX_CHAT_WINDOW_HEIGHT > screenBottomY;
      growsUpwardRef.current = shouldGrowUp;
      setGrowsUpward(shouldGrowUp);
      maxHeightRef.current = 0;
      if (shouldGrowUp && windowX !== null && windowY !== null) {
        windowPosRef.current = {
          x: windowX,
          bottomY: windowY + COLLAPSED_WINDOW_HEIGHT,
        };
      }
      setSessionId((id) => id + 1);
      cleanupSessionImages();
      setQuery('');
      setSelectedContext(context);
      setSelectedContextSource(context ? source : null);
      setAttachedImages((prev) => {
        for (const img of prev) URL.revokeObjectURL(img.blobUrl);
        return [];
      });
      pendingSubmitRef.current = null;
      setIsSubmitPending(false);
      setPendingUserMessage(null);

      reset();
      setOverlayState('visible');
    },
    [cleanupSessionImages, reset],
  );

  /**
   * Moves the overlay into an exit phase. The actual Tauri window hide call is
   * deferred until Framer Motion finishes the exit transition.
   */
  const requestHideOverlay = useCallback(() => {
    cancel();
    cleanupSessionImages();
    growsUpwardRef.current = false;
    setGrowsUpward(false);
    setSelectedContext(null);
    setSelectedContextSource(null);
    setPreviewImageUrl(null);
    setAttachedImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.blobUrl);
      return [];
    });
    setOverlayState((currentState) => {
      if (currentState === 'hidden' || currentState === 'hiding') {
        return currentState;
      }
      return 'hiding';
    });
  }, [cancel, cleanupSessionImages]);

  const prevHeightRef = useRef<number>(COLLAPSED_WINDOW_HEIGHT);

  /**
   * When a submit flips the UI from ask-bar mode into chat mode while the
   * window is pinned near the bottom edge, animate the container from its
   * current height to the fixed full chat height. This is intentionally scoped
   * to the upward-growth path so the downward path remains unchanged.
   */
  useLayoutEffect(() => {
    /* v8 ignore start -- ResizeObserver + DOM mutations require a real browser */
    const container = morphingContainerNodeRef.current;
    const wasChatMode = previousIsChatModeRef.current;
    previousIsChatModeRef.current = isChatMode;

    if (!container) return;
    if (!growsUpward || !isChatMode || wasChatMode) {
      return;
    }

    const startHeight =
      container.offsetHeight > 0
        ? container.offsetHeight
        : prevHeightRef.current;
    container.style.transition = 'none';
    container.style.minHeight = '';
    container.style.height = `${startHeight}px`;
    void container.offsetHeight;

    const frameId = requestAnimationFrame(() => {
      // 0.4s and slightly softer cubic bezier specifically for upward morph
      container.style.transition = 'height 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
      container.style.height = '600px';
    });

    return () => cancelAnimationFrame(frameId);
    /* v8 ignore stop */
  }, [growsUpward, isChatMode]);

  /**
   * Shared reset sequence for all "start a new conversation" paths.
   */
  const resetForNewConversation = useCallback(() => {
    cleanupSessionImages();
    reset();
    setQuery('');
    setAttachedImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.blobUrl);
      return [];
    });
    pendingSubmitRef.current = null;
    setIsSubmitPending(false);
    setPendingUserMessage(null);
    setSelectedContext(null);
    setSelectedContextSource(null);
  }, [cleanupSessionImages, reset]);

  /**
   * Starts a fresh conversation from within conversation view.
   */
  const handleNewConversation = useCallback(() => {
    resetForNewConversation();
  }, [resetForNewConversation]);

  /**
   * Handles newly attached image files. Creates blob URLs immediately for
   * instant thumbnail rendering, then processes each file in the background
   * via base64-encoded IPC to the Rust backend.
   */
  const handleImagesAttached = useCallback((files: File[]) => {
    const newImages: AttachedImage[] = files.map((file) => ({
      id: crypto.randomUUID(),
      blobUrl: URL.createObjectURL(file),
      filePath: null,
    }));

    setAttachedImages((prev) => [...prev, ...newImages]);

    // Defer backend processing to the next frame so React can render the
    // blob URL thumbnails immediately — keeps the UI responsive while
    // FileReader + IPC serialisation happen in subsequent event-loop ticks.
    requestAnimationFrame(() => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const imageId = newImages[i].id;

        const reader = new FileReader();
        reader.onload = () => {
          // Extract pure base64 from the data URL (strip "data:image/png;base64,").
          const base64 = (reader.result as string).split(',')[1];
          invoke<string>('save_image_command', { imageDataBase64: base64 })
            .then((filePath) => {
              setAttachedImages((prev) => {
                const stillAttached = prev.some((img) => img.id === imageId);
                if (!stillAttached) {
                  void invoke('remove_image_command', { path: filePath }).catch(
                    () => {
                      // Best-effort cleanup for images removed before processing finished.
                    },
                  );
                  return prev;
                }
                return prev.map((img) =>
                  img.id === imageId ? { ...img, filePath } : img,
                );
              });
            })
            .catch(() => {
              setAttachedImages((prev) => {
                for (const img of prev) {
                  if (img.id === imageId) URL.revokeObjectURL(img.blobUrl);
                }
                return prev.filter((img) => img.id !== imageId);
              });
            });
        };
        reader.readAsDataURL(file);
      }
    });
  }, []);

  /**
   * Root-level drag handlers. Attached to the `h-screen w-screen` root div so
   * file drops anywhere in the window are intercepted, including the
   * ConversationView area, which has no drop handlers of its own. Without this,
   * the WebView navigates to display the dropped image full-screen when the user
   * drops a second image after the first conversation turn.
   *
   * `dragover` must always call `e.preventDefault()` to signal the browser that
   * this element accepts drops; without it the `drop` event never fires.
   */
  const handleRootDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (isGenerating || isSubmitPending) return;
      setIsDragOver(attachedImages.length >= MAX_IMAGES ? 'max' : 'normal');
    },
    [isGenerating, isSubmitPending, attachedImages.length],
  );

  const handleRootDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the cursor truly exits the window. `dragleave` fires
    // when moving between child elements too; checking `relatedTarget` lets us
    // ignore those internal transitions.
    /* v8 ignore start -- dragleave relatedTarget cannot be set in jsdom; the false branch (cursor on child element) requires a real browser drag sequence */
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) {
      setIsDragOver(null);
    }
    /* v8 ignore stop */
  }, []);

  const handleRootDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(null);
      if (isGenerating || isSubmitPending) return;
      const files = e.dataTransfer?.files;
      if (!files) return;
      const remaining = MAX_IMAGES - attachedImages.length;
      if (remaining <= 0) return;
      const accepted: File[] = [];
      for (let i = 0; i < files.length && accepted.length < remaining; i++) {
        if (
          files[i].type.startsWith('image/') &&
          files[i].size <= MAX_IMAGE_SIZE_BYTES
        ) {
          accepted.push(files[i]);
        }
      }
      if (accepted.length > 0) handleImagesAttached(accepted);
    },
    [
      isGenerating,
      isSubmitPending,
      attachedImages.length,
      handleImagesAttached,
    ],
  );

  /** Removes an attached image from state, revokes the blob URL, and
   *  deletes the staged file from disk if processing completed. */
  const handleImageRemove = useCallback((id: string) => {
    setAttachedImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) {
        URL.revokeObjectURL(img.blobUrl);
        if (img.filePath) {
          void invoke('remove_image_command', { path: img.filePath });
        }
      }
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  /** Opens the preview modal for an attached image (identified by ID).
   *  The ID always comes from the thumbnail component which only renders
   *  items present in attachedImages, so the find always succeeds. */
  const handleAskBarImagePreview = useCallback(
    (id: string) => {
      setPreviewImageUrl(attachedImages.find((i) => i.id === id)!.blobUrl);
    },
    [attachedImages],
  );

  /** Opens the preview modal for a chat history image (identified by file path). */
  const handleChatImagePreview = useCallback((path: string) => {
    setPreviewImageUrl(path.startsWith('blob:') ? path : convertFileSrc(path));
  }, []);

  /** Fires the actual ask() call and cleans up attached images + input. */
  const executeSubmit = useCallback(
    (submitQuery: string, context: string | undefined, think?: boolean) => {
      const readyPaths = attachedImages
        .filter((img) => img.filePath !== null)
        .map((img) => img.filePath as string);
      const images = readyPaths.length > 0 ? readyPaths : undefined;
      ask(submitQuery, context, images, think);
      setSelectedContext(null);
      setQuery('');
      for (const img of attachedImages) {
        URL.revokeObjectURL(img.blobUrl);
      }
      setAttachedImages([]);
      inputRef.current!.style.height = 'auto';
    },
    [ask, attachedImages, setSelectedContext],
  );

  const handleSubmit = useCallback(() => {
    if (
      (query.trim().length === 0 && attachedImages.length === 0) ||
      isGenerating
    )
      return;

    // Parse all valid commands from anywhere in the message.
    const trimmedQuery = query.trim();
    const { found, strippedMessage } = parseCommands(
      trimmedQuery,
      activeCommands,
    );
    const foundCommands = Array.from(found)
      .map((trigger) => activeCommands.find((cmd) => cmd.trigger === trigger))
      .filter((cmd): cmd is ActiveCommand => cmd !== undefined);
    const hasThink = foundCommands.some(
      (cmd) => (cmd.originalTrigger ?? cmd.trigger) === '/think',
    );

    // Check for utility commands with prompt templates.
    const utilityTrigger = foundCommands.find(
      (cmd) => !!cmd.promptTemplate,
    )?.trigger;

    // Nothing to send if the message is only commands with no content or images.
    // Exception: a utility command or /think with pre-filled selected context is
    // valid even if no additional text was typed after the trigger.
    if (
      !strippedMessage &&
      attachedImages.length === 0 &&
      !((utilityTrigger || hasThink) && selectedContext?.trim())
    )
      return;

    if (utilityTrigger) {
      // Sanitize selectedContext before passing to buildPrompt so that control
      // characters from a hostile host-app selection cannot reach the model prompt.
      // eslint-disable-next-line no-control-regex
      const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
      const sanitized = selectedContext
        ?.replace(CONTROL_CHARS, '')
        .slice(0, quote.maxContextLength);
      const context = sanitized?.trim() ? sanitized : undefined;

      const composedPrompt = buildPrompt(
        utilityTrigger,
        strippedMessage,
        context,
        activeCommands,
        { hasImageInput: attachedImages.length > 0 },
      );
      /* v8 ignore next -- defensive guard; strippedMessage is pre-checked */
      if (!composedPrompt) return;

      // Show the full original query (including command trigger) in the chat
      // bubble, matching the behaviour of the normal submit path.
      const displayText = trimmedQuery;

      const hasPendingImages = attachedImages.some(
        (img) => img.filePath === null,
      );
      if (!hasPendingImages) {
        const readyPaths = attachedImages
          .filter((img) => img.filePath !== null)
          .map((img) => img.filePath as string);
        const images = readyPaths.length > 0 ? readyPaths : undefined;
        ask(
          displayText,
          context,
          images,
          hasThink || undefined,
          composedPrompt,
        );
        setSelectedContext(null);
        setQuery('');
        for (const img of attachedImages) {
          URL.revokeObjectURL(img.blobUrl);
        }
        setAttachedImages([]);
        /* v8 ignore next */
        inputRef.current!.style.height = 'auto';
        return;
      }

      // Images still processing: store intent for deferred submit.
      pendingSubmitRef.current = {
        query: displayText,
        context,
        think: hasThink,
        promptOverride: composedPrompt,
      };
      setIsSubmitPending(true);
      setPendingUserMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: displayText,
        quotedText: context,
        imagePaths: attachedImages.map((img) => img.filePath ?? img.blobUrl),
      });
      setQuery('');
      setSelectedContext(null);
      /* v8 ignore next */
      inputRef.current!.style.height = 'auto';
      return;
    }

    // Sanitize externally-sourced context: strip control characters and enforce
    // a length cap to limit prompt-injection surface from host-app selections.
    // eslint-disable-next-line no-control-regex
    const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
    const sanitized = selectedContext
      ?.replace(CONTROL_CHARS, '')
      .slice(0, quote.maxContextLength);
    const context = sanitized?.trim() ? sanitized : undefined;

    // If all images are ready (or there are none), submit immediately.
    const hasPendingImages = attachedImages.some(
      (img) => img.filePath === null,
    );
    if (!hasPendingImages) {
      executeSubmit(trimmedQuery, context, hasThink || undefined);
      return;
    }

    // Images are still processing — store the intent and wait. The effect
    // below will fire the actual ask() once every image has resolved.
    pendingSubmitRef.current = {
      query: trimmedQuery,
      context,
      think: hasThink,
    };
    setIsSubmitPending(true);

    // Show the user's message immediately in the chat view. Use file paths
    // for already-processed images (no loading spinner) and blob URLs only
    // for images still being processed (ChatBubble shows a spinner for blob: URLs).
    setPendingUserMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedQuery,
      quotedText: context,
      imagePaths: attachedImages.map((img) => img.filePath ?? img.blobUrl),
    });

    setQuery('');
    setSelectedContext(null);
    inputRef.current!.style.height = 'auto';
  }, [
    query,
    isGenerating,
    executeSubmit,
    selectedContext,
    setSelectedContext,
    attachedImages,
    activeCommands,
  ]);

  /** When true, an overlay-submit event requested auto-submission. Cleared
   *  by the effect below once handleSubmit runs with the fresh state. */
  const [pendingOverlaySubmit, setPendingOverlaySubmit] = useState(false);
  useEffect(() => {
    if (!pendingOverlaySubmit) return;
    // State from the event has been committed; query is populated and the
    // image is in attachedImages. Safe to trigger submission now.
    setPendingOverlaySubmit(false);
    handleSubmit();
  }, [pendingOverlaySubmit, handleSubmit]);

  // When a pending submit exists and all images finish processing, fire it.
  // Reads `attachedImages` directly (not via `executeSubmit` closure) to
  // guarantee the effect always sees the freshest file paths.
  /* eslint-disable @eslint-react/set-state-in-effect -- intentional: effect
     reacts to image processing completion and must synchronously transition
     state (pending → submitted) in the same tick to avoid stale renders. */
  useEffect(() => {
    if (!pendingSubmitRef.current) return;
    if (attachedImages.length === 0) {
      // All images failed — restore the user's query so their text isn't lost.
      const { query: savedQuery, context: savedContext } =
        pendingSubmitRef.current;
      pendingSubmitRef.current = null;
      setIsSubmitPending(false);
      setPendingUserMessage(null);
      setQuery(savedQuery);
      setSelectedContext(savedContext ?? null);
      return;
    }
    // Wait until every image has finished backend processing.
    const allReady = attachedImages.every((img) => img.filePath !== null);
    if (!allReady) return;

    const {
      query: pendingQuery,
      context,
      think,
      promptOverride,
    } = pendingSubmitRef.current;
    pendingSubmitRef.current = null;
    setIsSubmitPending(false);
    // Clear the preview message — ask() will add the real one with file paths.
    setPendingUserMessage(null);

    const images = attachedImages.map((img) => img.filePath as string);
    void ask(pendingQuery, context, images, think || undefined, promptOverride);
    // Note: the display content in the pending bubble (set in handleSubmit)
    // already includes command triggers for visibility in the chat.
    setSelectedContext(null);
    for (const img of attachedImages) {
      URL.revokeObjectURL(img.blobUrl);
    }
    setAttachedImages([]);
  }, [attachedImages, ask, setSelectedContext]);
  /* eslint-enable @eslint-react/set-state-in-effect */

  /**
   * Unified cancel handler: reverts a pending submit (undo-send) or cancels an
   * active Ollama generation.
   */
  const handleCancel = useCallback(() => {
    if (isSubmitPending && pendingSubmitRef.current) {
      // Case 1: image-processing pending. Restore input state.
      setQuery(pendingSubmitRef.current.query);
      setSelectedContext(pendingSubmitRef.current.context ?? null);
      pendingSubmitRef.current = null;
      setIsSubmitPending(false);
      setPendingUserMessage(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    cancel();
  }, [isSubmitPending, cancel, setSelectedContext]);

  /** Loads commands config from the backend on mount. */
  const loadCommandsConfig = useCallback(() => {
    void invoke<{ commands_config: CommandsConfig } | undefined>(
      'get_settings',
    ).then((s) => {
      if (s?.commands_config) setCommandsConfig(s.commands_config);
    });
  }, []);
  useEffect(loadCommandsConfig, [loadCommandsConfig]);

  /**
   * Synchronizes the React animation state with Tauri-driven overlay visibility
   * requests emitted from the Rust backend.
   */
  useEffect(() => {
    let unlistenVisibility: (() => void) | undefined;
    let unlistenOnboarding: (() => void) | undefined;
    let unlistenReplyDraftOpen: (() => void) | undefined;
    let unlistenReplyDraftImage: (() => void) | undefined;
    let unlistenSettings: (() => void) | undefined;
    let unlistenOverlaySubmit: (() => void) | undefined;

    /**
     * Handle an `overlay-submit` event: add the image to the ask bar and
     * either pre-fill the prompt for user review or auto-submit immediately.
     * The image path is already a real file on disk (Rust wrote it before
     * emitting), so we can skip the FileReader+save_image_command dance.
     * Auto-submit is deferred to a flag + effect combo so the submit runs
     * after React has committed the new query/attachedImages state.
     */
    const handleOverlaySubmit = (payload: OverlaySubmitPayload) => {
      if (!payload.imagePath) return;
      const newImage: AttachedImage = {
        id: crypto.randomUUID(),
        blobUrl: convertFileSrc(payload.imagePath),
        filePath: payload.imagePath,
      };
      setAttachedImages((prev) => [...prev, newImage]);
      if (payload.prompt) {
        setQuery(payload.prompt);
      }
      if (payload.autoSubmit) {
        setPendingOverlaySubmit(true);
      }
    };

    const attachListeners = async () => {
      unlistenVisibility = await listen<OverlayVisibilityPayload>(
        OVERLAY_VISIBILITY_EVENT,
        ({ payload }) => {
          if (payload.state === 'show') {
            replayEntranceAnimation(
              payload.selected_text ?? null,
              payload.selected_source ?? null,
              payload.window_x ?? null,
              payload.window_y ?? null,
              payload.screen_bottom_y ?? null,
            );
            return;
          }
          requestHideOverlay();
        },
      );
      unlistenOnboarding = await listen<{ stage: OnboardingStage }>(
        ONBOARDING_EVENT,
        ({ payload }) => {
          setOnboardingStage(payload.stage);
        },
      );
      unlistenReplyDraftOpen = await listen<ReplyDraftOpenPayload>(
        REPLY_DRAFT_OPEN_EVENT,
        ({ payload }) => {
          // A new draft request — seed the context with just app identity.
          // Image path + capture error stay null until the image event lands.
          setReplyContext({
            bundleId: payload.bundle_id,
            appName: payload.app_name,
            imagePath: null,
            captureError: null,
          });
        },
      );
      unlistenReplyDraftImage = await listen<ReplyDraftImagePayload>(
        REPLY_DRAFT_IMAGE_EVENT,
        ({ payload }) => {
          setReplyContext((prev) =>
            prev
              ? {
                  ...prev,
                  imagePath: payload.image_path,
                  captureError: payload.error,
                }
              : prev,
          );
        },
      );
      unlistenSettings = await listen(SETTINGS_OPEN_EVENT, () => {
        setIsSettingsOpen(true);
      });
      unlistenOverlaySubmit = await listen<OverlaySubmitPayload>(
        OVERLAY_SUBMIT_EVENT,
        ({ payload }) => {
          handleOverlaySubmit(payload);
        },
      );
      // Listeners registered — safe to let Rust decide what to show on launch.
      await invoke('notify_frontend_ready');
    };

    void attachListeners();
    return () => {
      unlistenVisibility?.();
      unlistenOnboarding?.();
      unlistenReplyDraftOpen?.();
      unlistenReplyDraftImage?.();
      unlistenSettings?.();
      unlistenOverlaySubmit?.();
    };
  }, [replayEntranceAnimation, requestHideOverlay]);

  /**
   * Combined close handler shared by the keyboard shortcut (Esc/Cmd+W)
   * and the traffic light close/minimize buttons. Notifies the Rust
   * backend and triggers the frontend exit animation sequence.
   */
  const handleCloseOverlay = useCallback(() => {
    void invoke('notify_overlay_hidden');
    requestHideOverlay();
  }, [requestHideOverlay]);

  /** Hide window on Escape or Cmd+W; open settings on Cmd+, */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (replyContext || isSettingsOpen) return; // sub-views handle their own keys
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setIsSettingsOpen(true);
        return;
      }
      if (((e.metaKey || e.ctrlKey) && e.key === 'w') || e.key === 'Escape') {
        e.preventDefault();
        handleCloseOverlay();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCloseOverlay, replyContext, isSettingsOpen]);

  /** Programmatic focus when the overlay becomes visible. */
  useEffect(() => {
    if (overlayState === 'visible') {
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [overlayState]);

  /**
   * Commits the native window hide after a fixed deadline from the start of
   * the exit transition. Also clears any active reply-draft context so a
   * subsequent double-tap Ctrl opens the normal Ask Bar instead of
   * re-rendering the stale reply panel.
   */
  useEffect(() => {
    if (overlayState !== 'hiding') return;

    const timer = setTimeout(() => {
      void getCurrentWindow().hide();
      void invoke('notify_overlay_hidden');
      setOverlayState('hidden');
      setReplyContext(null);
      setIsSettingsOpen(false);
    }, HIDE_COMMIT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [overlayState]);

  /**
   * Handles mousedown on any surface of the application window.
   *
   * For non-interactive targets (transparent padding, container chrome, etc.):
   * - Calls `preventDefault()` to suppress the browser's default behaviour of
   *   blurring the active element, keeping textarea focus intact.
   * - Initiates a native platform drag via `startDragging()`.
   *
   * For interactive targets (textarea, buttons, links): returns early so
   * standard DOM behaviour (focus, click, selection) proceeds normally.
   */
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement | null;

    // 1. Allow native text selection in explicitly selectable regions.
    // If the click occurs inside a chat bubble (which has .select-text),
    // we return early so the user can highlight and copy the text.
    if (el?.closest('.select-text')) {
      return;
    }

    // 2. Allow interaction with standard interactive elements.
    const INTERACTIVE_TAGS = new Set([
      'TEXTAREA',
      'INPUT',
      'BUTTON',
      'A',
      'SELECT',
      'PATH',
      'SVG',
    ]);
    let current = el;
    while (current) {
      if (INTERACTIVE_TAGS.has(current.tagName.toUpperCase())) return;
      current = current.parentElement;
    }

    // Suppress the default mousedown side-effect (focus transfer / blur)
    // so the textarea retains keyboard input during window repositioning.
    e.preventDefault();
    void getCurrentWindow().startDragging();

    // After the user repositions the window, drop the upward-grow mode so
    // subsequent conversation growth tracks the new position downward.
    window.addEventListener(
      'mouseup',
      () => {
        growsUpwardRef.current = false;
        setGrowsUpward(false);
      },
      { once: true },
    );
  }, []);

  if (onboardingStage !== null) {
    return (
      <OnboardingView
        stage={onboardingStage}
        onComplete={() => setOnboardingStage(null)}
      />
    );
  }

  if (isSettingsOpen) {
    return (
      <div
        onMouseDown={handleDragStart}
        className="flex flex-col items-center justify-start h-screen w-screen px-3 pt-2 pb-6 bg-transparent overflow-visible"
      >
        <div ref={setReplyContainerRef} className="w-full">
          <SettingsView
            onDismiss={(saved) => {
              setIsSettingsOpen(false);
              /* v8 ignore next -- reload commands on save */
              if (saved) loadCommandsConfig();
              handleCloseOverlay();
            }}
          />
        </div>
      </div>
    );
  }

  if (replyContext !== null) {
    return (
      <div
        onMouseDown={handleDragStart}
        className="flex flex-col items-center justify-start h-screen w-screen px-3 pt-2 pb-6 bg-transparent overflow-visible"
      >
        <div ref={setReplyContainerRef} className="w-full">
          <ReplyDraftView
            bundleId={replyContext.bundleId}
            appName={replyContext.appName}
            imagePath={replyContext.imagePath}
            captureError={replyContext.captureError}
            onDismiss={() => {
              setReplyContext(null);
              handleCloseOverlay();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    // Minimal padding (pt-2 pb-6) provides just enough physical clearance for the
    // tightened drop shadow to render without clipping at the native window edge.
    <div
      onMouseDown={handleDragStart}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
      className={`flex flex-col items-center ${growsUpward ? 'justify-end' : 'justify-start'} h-screen w-screen px-3 pt-2 pb-6 bg-transparent overflow-visible`}
    >
      <AnimatePresence mode="wait">
        {shouldRenderOverlay ? (
          <motion.div
            key={`overlay-${sessionId}`}
            initial={{ opacity: 0, y: -20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            className="w-full max-w-2xl px-4 py-2 overflow-visible"
          >
            <div
              ref={setContainerRef}
              style={{
                transition: 'height 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
              className={`morphing-container relative flex flex-col bg-surface-base backdrop-blur-2xl border border-surface-border max-h-[600px] overflow-hidden ${
                isChatMode ? 'rounded-lg shadow-chat' : 'rounded-2xl shadow-bar'
              }`}
            >
              {/* Chat Messages Area — morphs in when in chat mode */}
              <AnimatePresence>
                {isChatMode ? (
                  <ConversationView
                    messages={
                      pendingUserMessage
                        ? [...messages, pendingUserMessage]
                        : messages
                    }
                    isGenerating={isGenerating || isSubmitPending}
                    onClose={handleCloseOverlay}
                    onNewConversation={handleNewConversation}
                    onImagePreview={handleChatImagePreview}
                  />
                ) : null}
              </AnimatePresence>

              {/* Input Bar — always pinned to the bottom */}
              <AskBarView
                query={query}
                setQuery={setQuery}
                isChatMode={isChatMode}
                isGenerating={isGenerating}
                isSubmitPending={isSubmitPending}
                onSubmit={handleSubmit}
                onCancel={handleCancel}
                inputRef={inputRef}
                selectedText={selectedContext ?? undefined}
                selectedSource={selectedContextSource ?? undefined}
                attachedImages={isSubmitPending ? [] : attachedImages}
                onImagesAttached={handleImagesAttached}
                onImageRemove={handleImageRemove}
                onImagePreview={handleAskBarImagePreview}
                isDragOver={isDragOver ?? undefined}
                commands={activeCommands}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <ImagePreviewModal
        imageUrl={previewImageUrl}
        onClose={() => setPreviewImageUrl(null)}
      />
    </div>
  );
}

export default App;
