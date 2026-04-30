import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import CodeMirror, {
  EditorView,
  keymap,
  type Extension,
} from '@uiw/react-codemirror';
import { githubDark } from '@uiw/codemirror-theme-github';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';
import { markdown } from '@codemirror/lang-markdown';
import { formatAiActionLabel } from '../config/aiActions';
import { mergeCommands, type CommandsConfig } from '../config/commands';
import type { ClipboardEntry } from '../types/clipboard';

const UPDATED_EVENT = 'oling://clipboard-history-updated';
const SHOWN_EVENT = 'oling://clipboard-history-shown';
const STATUS_AUTO_DISMISS_MS = 2200;

type FilterKey = 'all' | 'text' | 'image' | 'favorites';
type ClipType = 'image' | 'url' | 'color' | 'code' | 'text';
type SectionKey = 'pinned' | 'today' | 'yesterday' | 'earlier';

/** Resolved AI Action — a slash command trigger + display label. */
interface AiActionSpec {
  trigger: string;
  label: string;
  description: string;
}

interface SettingsSnapshot {
  clipboard_ai_actions?: string[];
  commands_config?: CommandsConfig;
}

/**
 * Resolves the user-selected AI action triggers against the live
 * commands config, returning renderable tile specs. Triggers that
 * reference a deleted/disabled command are silently dropped so the
 * panel never shows a dead tile. Pure helper for unit testing.
 */
export function resolveAiActions(snapshot: SettingsSnapshot): AiActionSpec[] {
  const selected = snapshot.clipboard_ai_actions ?? [];
  if (selected.length === 0) return [];
  const commands = mergeCommands(snapshot.commands_config ?? null);
  return selected
    .map((trigger) => {
      const cmd = commands.find(
        (c) => c.trigger === trigger || c.originalTrigger === trigger,
      );
      if (!cmd) return null;
      return {
        trigger: cmd.trigger,
        label: formatAiActionLabel(cmd.trigger),
        description: cmd.description,
      } satisfies AiActionSpec;
    })
    .filter((spec): spec is AiActionSpec => spec !== null);
}

interface Section {
  key: SectionKey;
  label: string;
  entries: ClipboardEntry[];
}

const THEME = {
  shell:
    'radial-gradient(ellipse 85% 60% at 50% -6%, rgba(255,141,92,0.16) 0%, rgba(32,27,23,0.97) 55%), linear-gradient(180deg, rgba(29,24,21,0.99) 0%, rgba(16,13,11,0.99) 100%)',
  detailBg:
    'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.012) 100%)',
  border: '1px solid rgba(255,141,92,0.2)',
  divider: 'rgba(255,255,255,0.06)',
  text: '#f4f1ed',
  muted: 'rgba(255,255,255,0.58)',
  dim: 'rgba(255,255,255,0.34)',
  accent: '#ff8d5c',
  accentBorder: 'rgba(255,141,92,0.38)',
  glass: 'rgba(255,255,255,0.045)',
  shadow:
    '0 34px 90px rgba(0,0,0,0.52), 0 0 38px rgba(255,100,40,0.08), inset 0 1px 0 rgba(255,255,255,0.07)',
  font: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

const BADGE_STYLES: Record<ClipType, { bg: string; fg: string }> = {
  text: {
    bg: 'linear-gradient(145deg, #8B7FFF 0%, #5847D6 100%)',
    fg: '#ffffff',
  },
  code: {
    bg: 'linear-gradient(145deg, #A78BFA 0%, #6D28D9 100%)',
    fg: '#ffffff',
  },
  url: {
    bg: 'linear-gradient(145deg, #4FD99E 0%, #1A9B6C 100%)',
    fg: '#ffffff',
  },
  color: {
    bg: 'linear-gradient(145deg, #5AC8FA 0%, #2B80F0 100%)',
    fg: '#ffffff',
  },
  image: {
    bg: 'linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
    fg: 'rgba(255,255,255,0.58)',
  },
};

const KEY_LEGEND: { combo: string; label: string }[] = [
  { combo: '↑↓', label: 'Navigate' },
  { combo: '⏎', label: 'Paste' },
  { combo: '⇧⏎', label: 'Paste as text' },
  { combo: '⌘C', label: 'Copy' },
  { combo: '⌘⌫', label: 'Delete' },
];

function formatTimeAgo(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  return `${Math.floor(delta / day)}d ago`;
}

function detectClipType(entry: ClipboardEntry): ClipType {
  if (entry.kind === 'image') return 'image';
  const text = (entry.text_content ?? entry.text_preview ?? '').trim();
  if (!text) return 'text';
  if (/^https?:\/\/\S+$/i.test(text)) return 'url';
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return 'color';
  if (/[{}<>]/.test(text) && /[\n;=]/.test(text)) return 'code';
  return 'text';
}

export function detectCodeLanguage(text: string): string {
  const sample = text.slice(0, 4000);
  const trimmed = sample.trim();
  if (!trimmed) return 'text';
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // fall through
    }
  }
  if (/^\s*<\?xml|<!DOCTYPE html|<html[\s>]|<\/\w+>/.test(sample))
    return 'html';
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/im.test(sample))
    return 'sql';
  if (
    /^\s*(#!\/bin\/(ba)?sh|\$ |sudo |brew |npm |bun |cargo |git )/m.test(sample)
  )
    return 'bash';
  if (/\b(fn |let |mut |impl |pub fn|use [a-z_]+::)/.test(sample))
    return 'rust';
  if (/^\s*package\s+\w+|func\s+\w+\s*\(|:=|\bgo\s+\w+\(/m.test(sample))
    return 'go';
  if (/\b(def |class |import |from )\w+/.test(sample) && /:\s*$/m.test(sample))
    return 'python';
  if (
    /\binterface\s+\w+|:\s*(string|number|boolean)\b|\bas\s+\w+\b/.test(sample)
  )
    return 'typescript';
  if (/\b(const|let|var)\s+\w+\s*=|=>|\bfunction\s+\w*\(/.test(sample))
    return 'javascript';
  if (/[.#][\w-]+\s*\{[^}]*:/.test(sample)) return 'css';
  return 'text';
}

function extractColorSwatch(entry: ClipboardEntry): string | null {
  const text = (entry.text_content ?? entry.text_preview ?? '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(text) ? text : null;
}

function groupEntries(entries: ClipboardEntry[]): Section[] {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const pinned: ClipboardEntry[] = [];
  const today: ClipboardEntry[] = [];
  const yesterday: ClipboardEntry[] = [];
  const earlier: ClipboardEntry[] = [];
  for (const entry of entries) {
    if (entry.is_favorite) {
      pinned.push(entry);
      continue;
    }
    const ts = entry.last_copied_at;
    if (ts >= startOfToday) today.push(entry);
    else if (ts >= startOfYesterday) yesterday.push(entry);
    else earlier.push(entry);
  }
  const all: Section[] = [
    { key: 'pinned', label: 'Pinned', entries: pinned },
    { key: 'today', label: 'Today', entries: today },
    { key: 'yesterday', label: 'Yesterday', entries: yesterday },
    { key: 'earlier', label: 'Earlier', entries: earlier },
  ];
  return all.filter((section) => section.entries.length > 0);
}

function isTextInputTarget(target: EventTarget | null) {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return true;
  }
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return true;
    if (target.closest('.cm-editor, [contenteditable="true"]')) return true;
  }
  return false;
}

type IconCacheEntry = {
  status: 'loading' | 'ready' | 'error';
  path: string | null;
};
const iconCache = new Map<string, IconCacheEntry>();
const iconSubscribers = new Set<() => void>();

/** Exposed so tests can reset the module-level cache between cases. */
export function __resetSourceAppIconCacheForTests() {
  iconCache.clear();
}

function notifyIconSubscribers() {
  for (const fn of iconSubscribers) fn();
}

async function ensureAppIcon(bundleId: string): Promise<void> {
  const existing = iconCache.get(bundleId);
  if (existing && existing.status !== 'loading') return;
  if (existing && existing.status === 'loading') return;
  iconCache.set(bundleId, { status: 'loading', path: null });
  try {
    const path = await invoke<string>('get_source_app_icon', { bundleId });
    iconCache.set(bundleId, { status: 'ready', path });
  } catch {
    iconCache.set(bundleId, { status: 'error', path: null });
  }
  notifyIconSubscribers();
}

function useSourceAppIcon(bundleId: string | null): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!bundleId) return;
    const fn = () => setTick((n) => n + 1);
    iconSubscribers.add(fn);
    void ensureAppIcon(bundleId);
    return () => {
      iconSubscribers.delete(fn);
    };
  }, [bundleId]);
  if (!bundleId) return null;
  const entry = iconCache.get(bundleId);
  return entry?.status === 'ready' ? entry.path : null;
}

function entryKindLabel(entry: ClipboardEntry): string {
  const type = detectClipType(entry);
  switch (type) {
    case 'image':
      return 'Image';
    case 'url':
      return 'Link';
    case 'color':
      return 'Color';
    case 'code':
      return 'Code';
    default:
      return 'Text';
  }
}

export function ClipboardHistoryView() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [aiActions, setAiActions] = useState<AiActionSpec[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const statusTimerRef = useRef<number | null>(null);

  const flashStatus = useCallback((message: string) => {
    setStatus(message);
    if (statusTimerRef.current != null) {
      window.clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = window.setTimeout(() => {
      setStatus(null);
      statusTimerRef.current = null;
    }, STATUS_AUTO_DISMISS_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current != null) {
        window.clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

  // Read the user's picked AI Action commands on mount AND whenever
  // the main window emits `oling://settings-updated`, so tile changes
  // propagate to an already-open clipboard panel without a reopen.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const refetch = () => {
      void invoke<SettingsSnapshot>('get_settings')
        .then((snapshot) => {
          if (cancelled) return;
          setAiActions(resolveAiActions(snapshot ?? {}));
        })
        .catch(() => {
          // Settings failures just collapse the AI Actions section;
          // nothing else in the panel depends on this read.
          if (!cancelled) setAiActions([]);
        });
    };

    refetch();
    void listen('oling://settings-updated', () => refetch()).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const loadEntries = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = await invoke<ClipboardEntry[]>('list_clipboard_entries', {
        search: search.trim() || null,
        kind: filter === 'text' ? 'text' : filter === 'image' ? 'image' : null,
        favoritesOnly: filter === 'favorites',
      });
      const resolved = Array.isArray(next) ? next : [];
      setEntries(resolved);
      setSelectedId((current) => {
        if (resolved.length === 0) {
          return null;
        }
        return current && resolved.some((entry) => entry.id === current)
          ? current
          : resolved[0].id;
      });
    } catch (error) {
      setEntries([]);
      flashStatus(typeof error === 'string' ? error : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [filter, flashStatus, search]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(UPDATED_EVENT, () => {
      if (!disposed) {
        void loadEntries();
      }
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadEntries]);

  // Every time the panel transitions from hidden → shown, refresh the list
  // and reset the selection so the most-recently-used clip is highlighted
  // and Enter pastes it without further navigation.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(SHOWN_EVENT, () => {
      if (disposed) return;
      setSelectedId(null);
      setEditingEntryId(null);
      setEditingText('');
      setIsSavingEdit(false);
      void loadEntries();
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadEntries]);

  useEffect(() => {
    if (entries.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(entries[0].id);
    }
  }, [entries, selectedId]);

  const sections = useMemo(() => groupEntries(entries), [entries]);
  const displayEntries = useMemo(
    () => sections.flatMap((section) => section.entries),
    [sections],
  );

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );
  const activeType = activeEntry ? detectClipType(activeEntry) : null;
  const isEditingActiveText =
    activeEntry?.kind === 'text' && editingEntryId === activeEntry.id;

  useEffect(() => {
    if (!activeEntry || activeEntry.kind !== 'text') {
      setEditingEntryId(null);
      setEditingText('');
      setIsSavingEdit(false);
      return;
    }
    if (editingEntryId && editingEntryId !== activeEntry.id) {
      setEditingEntryId(null);
      setEditingText('');
      setIsSavingEdit(false);
    }
  }, [activeEntry, editingEntryId]);

  const closeWindow = useCallback(async () => {
    try {
      await invoke('close_clipboard_window');
    } catch {
      try {
        await getCurrentWindow().hide();
      } catch {
        // ignore
      }
    }
  }, []);

  const copyEntry = useCallback(
    async (entryId: string) => {
      await invoke('copy_clipboard_entry', { entryId });
      flashStatus('Copied back to clipboard');
      void loadEntries();
    },
    [flashStatus, loadEntries],
  );

  const pasteEntryPlain = useCallback(
    async (entryId: string) => {
      await invoke('paste_clipboard_entry_plain_text', { entryId });
      flashStatus('Pasted as plain text');
      void loadEntries();
    },
    [flashStatus, loadEntries],
  );

  const pasteEntry = useCallback(
    async (entryId: string) => {
      await invoke('paste_clipboard_entry', { entryId });
      flashStatus('Pasted into previous app');
      void loadEntries();
    },
    [flashStatus, loadEntries],
  );

  const toggleFavorite = useCallback(
    async (entryId: string) => {
      await invoke('toggle_clipboard_entry_favorite', { entryId });
      void loadEntries();
    },
    [loadEntries],
  );

  const deleteEntry = useCallback(
    async (entryId: string) => {
      await invoke('delete_clipboard_entry', { entryId });
      if (selectedId === entryId) {
        setSelectedId(null);
      }
      void loadEntries();
    },
    [loadEntries, selectedId],
  );

  const clearAll = useCallback(async () => {
    await invoke('clear_clipboard_history');
    setSelectedId(null);
    void loadEntries();
  }, [loadEntries]);

  const openInOling = useCallback(
    async (entryId: string, prompt?: string, autoSubmit = false) => {
      await invoke('open_clipboard_entry_in_oling', {
        entryId,
        prompt: prompt ?? null,
        autoSubmit,
      });
    },
    [],
  );

  const editEntry = useCallback(async (entryId: string) => {
    const win = getCurrentWindow();
    const [phys, size, scaleFactor] = await Promise.all([
      win.innerPosition(),
      win.innerSize(),
      win.scaleFactor(),
    ]);
    await invoke('edit_clipboard_entry', {
      entryId,
      x: phys.x / scaleFactor,
      y: phys.y / scaleFactor,
      width: size.width / scaleFactor,
      height: size.height / scaleFactor,
    });
  }, []);

  const beginTextEdit = useCallback((entry: ClipboardEntry) => {
    if (entry.kind !== 'text') {
      return;
    }
    setEditingEntryId(entry.id);
    setEditingText(entry.text_content ?? entry.text_preview);
    setStatus(null);
  }, []);

  const cancelTextEdit = useCallback(() => {
    setEditingEntryId(null);
    setEditingText('');
    setIsSavingEdit(false);
  }, []);

  const saveTextEdit = useCallback(
    async (entryId: string) => {
      setIsSavingEdit(true);
      try {
        const resolvedId = await invoke<string>('update_clipboard_text_entry', {
          entryId,
          text: editingText,
        });
        setSelectedId(resolvedId);
        flashStatus('Clipboard text updated');
        cancelTextEdit();
        void loadEntries();
      } catch (error) {
        flashStatus(typeof error === 'string' ? error : String(error));
        setIsSavingEdit(false);
      }
    },
    [cancelTextEdit, editingText, flashStatus, loadEntries],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        void closeWindow();
        return;
      }
      if (
        isEditingActiveText &&
        activeEntry?.kind === 'text' &&
        (event.metaKey || event.ctrlKey) &&
        event.key === 'Enter'
      ) {
        event.preventDefault();
        void saveTextEdit(activeEntry.id);
        return;
      }
      if (!displayEntries.length) {
        return;
      }
      if (event.key === 'ArrowDown') {
        if (isTextInputTarget(event.target)) return;
        event.preventDefault();
        const currentIndex = displayEntries.findIndex(
          (entry) => entry.id === selectedId,
        );
        const nextIndex =
          currentIndex < 0
            ? 0
            : Math.min(displayEntries.length - 1, currentIndex + 1);
        setSelectedId(displayEntries[nextIndex].id);
        return;
      }
      if (event.key === 'ArrowUp') {
        if (isTextInputTarget(event.target)) return;
        event.preventDefault();
        const currentIndex = displayEntries.findIndex(
          (entry) => entry.id === selectedId,
        );
        const nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
        setSelectedId(displayEntries[nextIndex].id);
        return;
      }
      if (event.key === 'Enter' && activeEntry) {
        if (isTextInputTarget(event.target)) return;
        if (isEditingActiveText) return;
        event.preventDefault();
        if (event.shiftKey && activeEntry.kind === 'text') {
          void pasteEntryPlain(activeEntry.id);
        } else {
          void pasteEntry(activeEntry.id);
        }
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === 'Backspace' &&
        activeEntry
      ) {
        event.preventDefault();
        void deleteEntry(activeEntry.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeEntry,
    closeWindow,
    deleteEntry,
    displayEntries,
    isEditingActiveText,
    pasteEntry,
    pasteEntryPlain,
    saveTextEdit,
    selectedId,
  ]);

  return (
    <div
      data-testid="clipboard-root"
      style={{
        width: '100vw',
        height: '100vh',
        padding: 0,
        boxSizing: 'border-box',
        background: 'transparent',
        fontFamily: THEME.font,
        color: THEME.text,
      }}
    >
      <style>{INTERACTION_CSS}</style>
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto',
          background: THEME.shell,
          border: THEME.border,
          borderRadius: 24,
          boxShadow: THEME.shadow,
          overflow: 'hidden',
          backdropFilter: 'blur(32px) saturate(140%)',
          WebkitBackdropFilter: 'blur(32px) saturate(140%)',
        }}
      >
        <TopBar
          onDragStart={() => {
            void getCurrentWindow()
              .startDragging()
              .catch(() => undefined);
          }}
          onClose={() => void closeWindow()}
          search={search}
          onSearchChange={setSearch}
          searchRef={searchRef}
          filter={filter}
          onFilterChange={setFilter}
          totalCount={entries.length}
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(340px, 0.92fr) minmax(420px, 1.08fr)',
            minHeight: 0,
          }}
        >
          <ListPane
            isLoading={isLoading}
            sections={sections}
            activeEntryId={activeEntry?.id ?? null}
            onSelect={setSelectedId}
          />

          <DetailPane
            activeEntry={activeEntry}
            activeType={activeType}
            isEditingActiveText={isEditingActiveText}
            editingText={editingText}
            onEditingTextChange={setEditingText}
            isSavingEdit={isSavingEdit}
            onCopy={copyEntry}
            onPastePlain={pasteEntryPlain}
            onPaste={pasteEntry}
            onAiAction={(id, prompt) => void openInOling(id, prompt, true)}
            onEdit={editEntry}
            aiActions={aiActions}
            onStartTextEdit={beginTextEdit}
            onSaveTextEdit={saveTextEdit}
            onCancelTextEdit={cancelTextEdit}
            onDelete={deleteEntry}
            onToggleFavorite={toggleFavorite}
          />
        </div>

        <FooterBar
          status={status}
          totalCount={entries.length}
          onClear={() => void clearAll()}
        />
      </div>
    </div>
  );
}

type TopBarProps = {
  onDragStart: () => void;
  onClose: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  filter: FilterKey;
  onFilterChange: (next: FilterKey) => void;
  totalCount: number;
};

function TopBar({
  onDragStart,
  onClose,
  search,
  onSearchChange,
  searchRef,
  filter,
  onFilterChange,
  totalCount,
}: TopBarProps) {
  const filters: {
    key: FilterKey;
    label: string;
    glyph: ReactNode;
  }[] = [
    { key: 'all', label: 'All', glyph: <FilterGlyphAll /> },
    { key: 'text', label: 'Text', glyph: <FilterGlyphText /> },
    { key: 'image', label: 'Images', glyph: <FilterGlyphImage /> },
    { key: 'favorites', label: 'Pinned', glyph: <FilterGlyphStar /> },
  ];
  return (
    <div
      onMouseDown={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('button,input')) {
          return;
        }
        onDragStart();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderBottom: `1px solid ${THEME.divider}`,
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close clipboard history"
        className="oling-close-btn"
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: '#ff5f57',
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
          boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.25)',
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 1,
          padding: '8px 12px',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.04)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <SearchGlyph />
        <input
          ref={searchRef}
          data-testid="clipboard-search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search clips, paste anything…"
          style={{
            flex: 1,
            minWidth: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: THEME.text,
            outline: 'none',
            fontSize: 12.5,
            fontFamily: THEME.font,
          }}
        />
        <KeyCap label="⌘F" muted />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: 3,
          borderRadius: 12,
          background: 'rgba(255,255,255,0.035)',
          border: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        {filters.map((item) => {
          const active = filter === item.key;
          return (
            <button
              key={item.key}
              data-testid={`clipboard-filter-${item.key}`}
              type="button"
              onClick={() => onFilterChange(item.key)}
              className="oling-filter-pill"
              style={filterChipStyle(active)}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {item.glyph}
                {item.label}
                {active ? (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: THEME.accent,
                      opacity: 0.85,
                    }}
                  >
                    {totalCount}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type ListPaneProps = {
  isLoading: boolean;
  sections: Section[];
  activeEntryId: string | null;
  onSelect: (id: string) => void;
};

function ListPane({
  isLoading,
  sections,
  activeEntryId,
  onSelect,
}: ListPaneProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeEntryId) return;
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('[data-clipboard-entry-id]'),
    );
    const activeRow = rows.find(
      (row) => row.dataset.clipboardEntryId === activeEntryId,
    );
    if (typeof activeRow?.scrollIntoView === 'function') {
      activeRow.scrollIntoView({ block: 'nearest' });
    }
  }, [activeEntryId]);

  return (
    <section
      style={{
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '10px 12px 14px',
        borderRight: `1px solid ${THEME.divider}`,
      }}
    >
      <div
        ref={listRef}
        data-testid="clipboard-list-scroll"
        style={{
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          paddingRight: 4,
        }}
      >
        {isLoading ? (
          <SkeletonList />
        ) : sections.length === 0 ? (
          <EmptyState label="No clipboard items yet." />
        ) : (
          sections.map((section) => (
            <ListSection
              key={section.key}
              section={section}
              activeEntryId={activeEntryId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </section>
  );
}

type ListSectionProps = {
  section: Section;
  activeEntryId: string | null;
  onSelect: (id: string) => void;
};

function ListSection({ section, activeEntryId, onSelect }: ListSectionProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 10 }}>
      <div
        data-testid={`clipboard-section-${section.key}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 8px 8px',
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: THEME.dim,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
          }}
        >
          {section.label}
        </span>
        <span
          style={{
            fontSize: 10,
            color: THEME.dim,
            opacity: 0.7,
          }}
        >
          {section.entries.length}
        </span>
        <div
          style={{
            flex: 1,
            height: 1,
            background: `linear-gradient(90deg, ${THEME.divider} 0%, transparent 100%)`,
          }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {section.entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            active={entry.id === activeEntryId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

type EntryRowProps = {
  entry: ClipboardEntry;
  active: boolean;
  onSelect: (id: string) => void;
};

function EntryRow({ entry, active, onSelect }: EntryRowProps) {
  const type = detectClipType(entry);
  const swatch = type === 'color' ? extractColorSwatch(entry) : null;
  return (
    <button
      data-testid={`clipboard-entry-${entry.id}`}
      data-clipboard-entry-id={entry.id}
      type="button"
      onClick={() => onSelect(entry.id)}
      className="oling-entry-row"
      style={entryRowStyle(active)}
    >
      {active ? <span style={selectionIndicatorStyle()} /> : null}
      <TypeBadge entry={entry} type={type} swatch={swatch} size={44} />
      <div
        style={{
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          flex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            fontSize: 11,
            color: THEME.muted,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 600,
            }}
          >
            {entry.source_app ?? 'Unknown app'}
          </span>
          <span style={{ color: THEME.dim }}>·</span>
          <span style={{ color: THEME.dim, flexShrink: 0 }}>
            {formatTimeAgo(entry.last_copied_at)}
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.45,
            fontWeight: 400,
            color: THEME.text,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textAlign: 'left',
            fontFamily:
              type === 'code' || type === 'color' ? THEME.mono : THEME.font,
          }}
        >
          {entry.text_preview}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 6,
          flexShrink: 0,
          paddingTop: 2,
        }}
      >
        {entry.is_favorite ? (
          <StarGlyph filled />
        ) : (
          <span style={{ width: 12, height: 12 }} />
        )}
        {entry.copy_count > 1 ? (
          <span style={{ fontSize: 10.5, color: THEME.dim, fontWeight: 600 }}>
            ×{entry.copy_count}
          </span>
        ) : null}
      </div>
    </button>
  );
}

type TypeBadgeProps = {
  entry: ClipboardEntry;
  type: ClipType;
  swatch: string | null;
  size: number;
};

function TypeBadge({ entry, type, swatch, size }: TypeBadgeProps) {
  const appIconPath = useSourceAppIcon(entry.source_bundle_id);
  const badge = BADGE_STYLES[type];
  const radius = size >= 44 ? 12 : 8;
  const overlaySize = Math.max(14, Math.round(size * 0.42));

  // Image entries: thumbnail with tiny app-icon corner overlay.
  if (type === 'image' && entry.image_path) {
    return (
      <div
        style={{
          position: 'relative',
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <img
          src={convertFileSrc(entry.image_path)}
          alt=""
          style={{
            width: size,
            height: size,
            objectFit: 'cover',
            borderRadius: radius,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.04)',
            display: 'block',
          }}
        />
        {appIconPath ? (
          <img
            src={convertFileSrc(appIconPath)}
            alt=""
            style={appIconCornerStyle(overlaySize)}
          />
        ) : null}
      </div>
    );
  }

  // When we have an app icon, show the real app icon as the primary badge,
  // with a tiny type-glyph corner overlay so the content-kind is still
  // visible at a glance.
  if (appIconPath) {
    return (
      <div
        style={{
          position: 'relative',
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <img
          src={convertFileSrc(appIconPath)}
          alt=""
          style={{
            width: size,
            height: size,
            objectFit: 'contain',
            borderRadius: radius,
            display: 'block',
            background: 'rgba(255,255,255,0.02)',
            filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.25))',
          }}
        />
        <div style={typeGlyphCornerStyle(overlaySize, badge.bg)}>
          <TypeGlyph type={type} swatch={swatch} size={overlaySize * 0.55} />
        </div>
      </div>
    );
  }

  // Fallback: colored type badge.
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: badge.bg,
        color: badge.fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,0.25), 0 2px 6px rgba(0,0,0,0.18)',
      }}
    >
      <TypeGlyph type={type} swatch={swatch} size={size} />
    </div>
  );
}

function TypeGlyph({
  type,
  swatch,
  size,
}: {
  type: ClipType;
  swatch: string | null;
  size: number;
}) {
  if (type === 'text') {
    return <span style={{ fontSize: size * 0.38, fontWeight: 800 }}>Aa</span>;
  }
  if (type === 'code') {
    return (
      <span
        style={{
          fontSize: size * 0.36,
          fontWeight: 800,
          fontFamily: THEME.mono,
        }}
      >
        {'{}'}
      </span>
    );
  }
  if (type === 'url') {
    return <LinkGlyph size={size * 0.45} />;
  }
  if (type === 'color') {
    return (
      <div
        style={{
          width: size * 0.5,
          height: size * 0.5,
          borderRadius: size * 0.14,
          background: swatch ?? '#ffffff',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.45)',
        }}
      />
    );
  }
  return <ImageGlyph size={size * 0.48} color={THEME.muted} />;
}

function appIconCornerStyle(size: number): CSSProperties {
  return {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: size,
    height: size,
    borderRadius: Math.max(4, Math.round(size * 0.25)),
    objectFit: 'contain',
    background: 'rgba(24,20,18,0.9)',
    border: '1.5px solid rgba(24,20,18,0.9)',
    boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
    display: 'block',
  };
}

function typeGlyphCornerStyle(size: number, bg: string): CSSProperties {
  return {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: size,
    height: size,
    borderRadius: Math.max(4, Math.round(size * 0.28)),
    background: bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    border: '1.5px solid rgba(24,20,18,0.9)',
    boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
  };
}

type DetailPaneProps = {
  activeEntry: ClipboardEntry | null;
  activeType: ClipType | null;
  isEditingActiveText: boolean;
  editingText: string;
  onEditingTextChange: (value: string) => void;
  isSavingEdit: boolean;
  onCopy: (id: string) => void;
  onPastePlain: (id: string) => void;
  onPaste: (id: string) => void;
  onAiAction: (id: string, prompt: string) => void;
  onEdit: (id: string) => void;
  aiActions: AiActionSpec[];
  onStartTextEdit: (entry: ClipboardEntry) => void;
  onSaveTextEdit: (id: string) => void;
  onCancelTextEdit: () => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
};

function DetailPane(props: DetailPaneProps) {
  const { activeEntry, activeType } = props;
  if (!activeEntry || !activeType) {
    return (
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          padding: 18,
          background: THEME.detailBg,
        }}
      >
        <EmptyState label="Select a clipboard item to inspect it." />
      </section>
    );
  }
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        padding: '14px 18px 0',
        gap: 12,
        overflow: 'hidden',
        background: THEME.detailBg,
      }}
    >
      <DetailHeader
        activeEntry={activeEntry}
        activeType={activeType}
        onToggleFavorite={props.onToggleFavorite}
      />

      <div
        data-testid="clipboard-detail-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          paddingRight: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <DetailContent
          activeEntry={activeEntry}
          activeType={activeType}
          isEditingActiveText={props.isEditingActiveText}
          editingText={props.editingText}
          onEditingTextChange={props.onEditingTextChange}
          onSaveTextEdit={props.onSaveTextEdit}
        />

        <MetaChips activeEntry={activeEntry} activeType={activeType} />

        <AiActionsPanel
          activeEntry={activeEntry}
          onAiAction={props.onAiAction}
          actions={props.aiActions}
        />
      </div>

      <StickyActionBar
        activeEntry={activeEntry}
        activeType={activeType}
        isEditingActiveText={props.isEditingActiveText}
        isSavingEdit={props.isSavingEdit}
        onCopy={props.onCopy}
        onPastePlain={props.onPastePlain}
        onPaste={props.onPaste}
        onEdit={props.onEdit}
        onStartTextEdit={props.onStartTextEdit}
        onSaveTextEdit={props.onSaveTextEdit}
        onCancelTextEdit={props.onCancelTextEdit}
        onDelete={props.onDelete}
      />
    </section>
  );
}

function DetailHeader({
  activeEntry,
  activeType,
  onToggleFavorite,
}: {
  activeEntry: ClipboardEntry;
  activeType: ClipType;
  onToggleFavorite: (id: string) => void;
}) {
  const swatch =
    activeType === 'color' ? extractColorSwatch(activeEntry) : null;
  const title =
    activeType === 'url'
      ? 'Link'
      : activeType === 'color'
        ? 'Color'
        : activeType === 'code'
          ? 'Code snippet'
          : activeType === 'image'
            ? 'Image'
            : 'Text';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        paddingBottom: 4,
      }}
    >
      <TypeBadge
        entry={activeEntry}
        type={activeType}
        swatch={swatch}
        size={34}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 700,
            color: THEME.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title} from {activeEntry.source_app ?? 'Unknown app'}
        </div>
        <div
          style={{
            fontSize: 11,
            color: THEME.muted,
            marginTop: 2,
            display: 'flex',
            gap: 6,
          }}
        >
          <span>{formatTimeAgo(activeEntry.last_copied_at)}</span>
          <span style={{ color: THEME.dim }}>·</span>
          <span>×{activeEntry.copy_count}</span>
          <span style={{ color: THEME.dim }}>·</span>
          <span>{entryKindLabel(activeEntry)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onToggleFavorite(activeEntry.id)}
        aria-label={activeEntry.is_favorite ? 'Unpin entry' : 'Pin entry'}
        className="oling-icon-btn"
        style={iconButtonStyle(activeEntry.is_favorite)}
      >
        <StarGlyph filled={activeEntry.is_favorite} />
      </button>
    </div>
  );
}

function DetailContent({
  activeEntry,
  activeType,
  isEditingActiveText,
  editingText,
  onEditingTextChange,
  onSaveTextEdit,
}: {
  activeEntry: ClipboardEntry;
  activeType: ClipType;
  isEditingActiveText: boolean;
  editingText: string;
  onEditingTextChange: (value: string) => void;
  onSaveTextEdit: (id: string) => void;
}) {
  const monospaced = activeType === 'code' || activeType === 'color';
  return (
    <div
      style={{
        minHeight: 220,
        borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.06)',
        background: monospaced
          ? 'rgba(12,10,9,0.55)'
          : 'rgba(255,255,255,0.035)',
        overflow: 'auto',
        padding: activeType === 'image' ? 0 : 14,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
        flexShrink: 0,
      }}
    >
      {activeType === 'image' && activeEntry.image_path ? (
        <img
          data-testid="clipboard-preview-image"
          src={convertFileSrc(activeEntry.image_path)}
          alt="Clipboard detail preview"
          style={{
            width: '100%',
            height: 'auto',
            borderRadius: 16,
            display: 'block',
          }}
        />
      ) : isEditingActiveText ? (
        <CodeEditor
          value={editingText}
          onChange={onEditingTextChange}
          isCode={activeType === 'code'}
          language={
            activeType === 'code'
              ? detectCodeLanguage(editingText || ' ')
              : 'text'
          }
          onSaveHotkey={() => onSaveTextEdit(activeEntry.id)}
        />
      ) : activeType === 'code' ? (
        <CodePreview
          text={activeEntry.text_content ?? activeEntry.text_preview}
        />
      ) : (
        <pre
          data-testid="clipboard-preview-text"
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 12.5,
            lineHeight: 1.65,
            color: THEME.text,
            fontFamily: monospaced ? THEME.mono : THEME.font,
          }}
        >
          {activeEntry.text_content ?? activeEntry.text_preview}
        </pre>
      )}
    </div>
  );
}

function CodeEditor({
  value,
  onChange,
  isCode,
  language,
  onSaveHotkey,
}: {
  value: string;
  onChange: (next: string) => void;
  isCode: boolean;
  language: string;
  onSaveHotkey: () => void;
}) {
  if (!isCode) {
    return (
      <textarea
        data-testid="clipboard-edit-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          minHeight: 220,
          height: '100%',
          resize: 'vertical',
          border: 'none',
          background: 'transparent',
          color: THEME.text,
          outline: 'none',
          fontSize: 12.5,
          lineHeight: 1.65,
          fontFamily: THEME.mono,
        }}
      />
    );
  }
  return (
    <CodeMirrorEditor
      value={value}
      onChange={onChange}
      language={language}
      onSaveHotkey={onSaveHotkey}
    />
  );
}

function CodeMirrorEditor({
  value,
  onChange,
  language,
  onSaveHotkey,
}: {
  value: string;
  onChange: (next: string) => void;
  language: string;
  onSaveHotkey: () => void;
}) {
  const langExtension = useMemo(
    () => codeMirrorLanguageExtension(language),
    [language],
  );
  const saveKeymap = useMemo(
    () =>
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onSaveHotkey();
            return true;
          },
        },
      ]),
    [onSaveHotkey],
  );
  const extensions = useMemo<Extension[]>(
    () => [
      EditorView.lineWrapping,
      ...(langExtension ? [langExtension] : []),
      saveKeymap,
    ],
    [langExtension, saveKeymap],
  );
  return (
    <div
      data-testid="clipboard-edit-textarea"
      className="oling-code-editor"
      style={{
        minHeight: 240,
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(12,10,9,0.72)',
        overflow: 'hidden',
      }}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={githubDark}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          foldGutter: false,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
          searchKeymap: false,
        }}
        height="100%"
        minHeight="240px"
        style={{ fontSize: 12.5, fontFamily: THEME.mono }}
      />
    </div>
  );
}

function codeMirrorLanguageExtension(language: string): Extension | null {
  switch (language) {
    case 'typescript':
      return javascript({ typescript: true, jsx: true });
    case 'javascript':
      return javascript({ jsx: true });
    case 'json':
      return json();
    case 'css':
      return css();
    case 'html':
      return html();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'go':
      return go();
    case 'sql':
      return sql();
    case 'markdown':
      return markdown();
    default:
      return null;
  }
}

function CodePreview({ text }: { text: string }) {
  const language = useMemo(() => detectCodeLanguage(text), [text]);
  const langExtension = useMemo(
    () => codeMirrorLanguageExtension(language),
    [language],
  );
  const extensions = useMemo<Extension[]>(
    () => [
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      ...(langExtension ? [langExtension] : []),
    ],
    [langExtension],
  );
  return (
    <div
      data-testid="clipboard-preview-text"
      data-language={language}
      style={{
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(12,10,9,0.72)',
        overflow: 'hidden',
      }}
    >
      <CodeMirror
        value={text}
        theme={githubDark}
        extensions={extensions}
        readOnly
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          foldGutter: false,
          autocompletion: false,
          bracketMatching: false,
          closeBrackets: false,
          indentOnInput: true,
          searchKeymap: false,
        }}
        style={{ fontSize: 12.5, fontFamily: THEME.mono }}
      />
    </div>
  );
}

function MetaChips({
  activeEntry,
  activeType,
}: {
  activeEntry: ClipboardEntry;
  activeType: ClipType;
}) {
  const text = activeEntry.text_content ?? activeEntry.text_preview ?? '';
  const chips: { label: string }[] = [];
  if (activeType === 'image') {
    chips.push({ label: 'Image' });
  } else {
    chips.push({ label: `${text.length} chars` });
    const lineCount = text ? text.split('\n').length : 0;
    if (lineCount > 1) {
      chips.push({ label: `${lineCount} lines` });
    }
  }
  chips.push({ label: `History ×${activeEntry.copy_count}` });
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
      }}
    >
      {chips.map((chip) => (
        <span key={chip.label} style={metaChipStyle()}>
          {chip.label}
        </span>
      ))}
    </div>
  );
}

function AiActionsPanel({
  activeEntry,
  onAiAction,
  actions,
}: {
  activeEntry: ClipboardEntry;
  onAiAction: (id: string, prompt: string) => void;
  actions: AiActionSpec[];
}) {
  if (actions.length === 0) {
    return null;
  }
  const columns = Math.min(actions.length, 4);
  return (
    <div
      data-testid="clipboard-ai-actions"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 10,
          fontWeight: 700,
          color: THEME.muted,
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          padding: '2px 2px 2px 0',
        }}
      >
        <SparkleGlyph />
        <span>AI Actions</span>
        <div
          style={{
            flex: 1,
            height: 1,
            background: `linear-gradient(90deg, ${THEME.divider} 0%, transparent 100%)`,
          }}
        />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 6,
        }}
      >
        {actions.map((action) => (
          <AiTile
            key={action.trigger}
            testId={`clipboard-ai-${action.trigger.slice(1)}`}
            glyph={<AiActionGlyphFor trigger={action.trigger} />}
            label={action.label}
            title={action.description}
            onClick={() => onAiAction(activeEntry.id, action.trigger)}
          />
        ))}
      </div>
    </div>
  );
}

function AiActionGlyphFor({ trigger }: { trigger: string }) {
  switch (trigger) {
    case '/tldr':
      return <TileGlyphSummarize />;
    case '/translate':
      return <TileGlyphTranslate />;
    case '/rewrite':
    case '/refine':
      return <TileGlyphRewrite />;
    case '/bullets':
    case '/todos':
      return <TileGlyphSummarize />;
    default:
      return <SparkleGlyph />;
  }
}

function AiTile({
  testId,
  glyph,
  label,
  onClick,
  title,
}: {
  testId: string;
  glyph: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      onClick={onClick}
      title={title}
      className="oling-ai-tile"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 58,
        padding: '8px 6px',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.03)',
        color: THEME.text,
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: THEME.font,
      }}
    >
      <span style={{ color: THEME.muted }}>{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

function StickyActionBar({
  activeEntry,
  activeType,
  isEditingActiveText,
  isSavingEdit,
  onCopy,
  onPastePlain,
  onPaste,
  onEdit,
  onStartTextEdit,
  onSaveTextEdit,
  onCancelTextEdit,
  onDelete,
}: {
  activeEntry: ClipboardEntry;
  activeType: ClipType;
  isEditingActiveText: boolean;
  isSavingEdit: boolean;
  onCopy: (id: string) => void;
  onPastePlain: (id: string) => void;
  onPaste: (id: string) => void;
  onEdit: (id: string) => void;
  onStartTextEdit: (entry: ClipboardEntry) => void;
  onSaveTextEdit: (id: string) => void;
  onCancelTextEdit: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '10px 0 14px',
        borderTop: `1px solid ${THEME.divider}`,
        marginTop: 4,
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        data-testid="clipboard-paste-btn"
        onClick={() => onPaste(activeEntry.id)}
        className="oling-primary-btn"
        style={primaryButtonStyle()}
      >
        <span>Paste</span>
        <KeyCap label="⏎" tint="onPrimary" />
      </button>
      <button
        type="button"
        data-testid="clipboard-copy-btn"
        onClick={() => onCopy(activeEntry.id)}
        className="oling-secondary-btn"
        style={secondaryButtonStyle()}
      >
        <span>Copy</span>
        <KeyCap label="⌘C" />
      </button>
      {activeType !== 'image' ? (
        <button
          type="button"
          data-testid="clipboard-paste-plain-btn"
          onClick={() => onPastePlain(activeEntry.id)}
          title="Paste without formatting (strips RTF/HTML)"
          className="oling-secondary-btn"
          style={secondaryButtonStyle()}
        >
          <span>As Text</span>
          <KeyCap label="⇧⏎" />
        </button>
      ) : null}
      {activeType === 'image' ? (
        <button
          type="button"
          data-testid="clipboard-edit-btn"
          onClick={() => onEdit(activeEntry.id)}
          className="oling-secondary-btn"
          style={secondaryButtonStyle()}
        >
          Edit
        </button>
      ) : null}
      {activeEntry.kind === 'text' ? (
        isEditingActiveText ? (
          <>
            <button
              type="button"
              data-testid="clipboard-save-edit-btn"
              onClick={() => onSaveTextEdit(activeEntry.id)}
              disabled={isSavingEdit}
              className="oling-secondary-btn"
              style={secondaryButtonStyle()}
            >
              {isSavingEdit ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              data-testid="clipboard-cancel-edit-btn"
              onClick={onCancelTextEdit}
              disabled={isSavingEdit}
              className="oling-ghost-btn"
              style={ghostButtonStyle()}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="clipboard-start-edit-btn"
            onClick={() => onStartTextEdit(activeEntry)}
            className="oling-secondary-btn"
            style={secondaryButtonStyle()}
          >
            Edit Text
          </button>
        )
      ) : null}
      <div style={{ flex: 1 }} />
      <button
        type="button"
        data-testid="clipboard-delete-btn"
        onClick={() => onDelete(activeEntry.id)}
        className="oling-ghost-btn"
        style={ghostButtonStyle()}
      >
        <span>Delete</span>
        <KeyCap label="⌘⌫" muted />
      </button>
    </div>
  );
}

function FooterBar({
  status,
  totalCount,
  onClear,
}: {
  status: string | null;
  totalCount: number;
  onClear: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 14px',
        borderTop: `1px solid ${THEME.divider}`,
        background: 'rgba(0,0,0,0.2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: THEME.muted,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: '#4FD99E',
            boxShadow: '0 0 6px rgba(79,217,158,0.5)',
          }}
        />
        <span>
          {status ??
            `${totalCount} item${totalCount === 1 ? '' : 's'} stored locally`}
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10.5,
          color: THEME.dim,
        }}
      >
        {KEY_LEGEND.map((item, idx) => (
          <span
            key={item.combo}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <KeyCap label={item.combo} muted />
            <span>{item.label}</span>
            {idx < KEY_LEGEND.length - 1 ? (
              <span style={{ color: THEME.dim, opacity: 0.4 }}>·</span>
            ) : null}
          </span>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        data-testid="clipboard-clear-btn"
        onClick={onClear}
        className="oling-ghost-btn"
        style={{
          ...ghostButtonStyle(),
          padding: '6px 10px',
          fontSize: 10.5,
        }}
      >
        Clear All
      </button>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div
      style={{
        minHeight: 160,
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        fontSize: 12.5,
        color: 'rgba(255,255,255,0.5)',
        padding: 24,
      }}
    >
      {label}
    </div>
  );
}

function SkeletonList() {
  return (
    <div
      data-testid="clipboard-skeleton"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 4 }}
    >
      {[0, 1, 2, 3].map((idx) => (
        <div
          key={idx}
          style={{
            display: 'flex',
            gap: 12,
            padding: '10px 12px',
            borderRadius: 14,
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background:
                'linear-gradient(110deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
            }}
          />
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              paddingTop: 4,
            }}
          >
            <div
              style={{
                width: '38%',
                height: 8,
                borderRadius: 4,
                background: 'rgba(255,255,255,0.05)',
              }}
            />
            <div
              style={{
                width: '88%',
                height: 10,
                borderRadius: 4,
                background: 'rgba(255,255,255,0.045)',
              }}
            />
            <div
              style={{
                width: '64%',
                height: 10,
                borderRadius: 4,
                background: 'rgba(255,255,255,0.035)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function KeyCap({
  label,
  muted = false,
  tint,
}: {
  label: string;
  muted?: boolean;
  tint?: 'onPrimary';
}) {
  const onPrimary = tint === 'onPrimary';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        lineHeight: 1,
        padding: '3px 6px',
        borderRadius: 6,
        border: onPrimary
          ? '1px solid rgba(255,255,255,0.35)'
          : '1px solid rgba(255,255,255,0.12)',
        background: onPrimary
          ? 'rgba(255,255,255,0.2)'
          : 'rgba(255,255,255,0.06)',
        color: onPrimary ? '#fff' : muted ? THEME.dim : THEME.muted,
        fontFamily: THEME.mono,
        letterSpacing: 0.3,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function filterChipStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: active
      ? `1px solid ${THEME.accentBorder}`
      : '1px solid transparent',
    background: active
      ? 'linear-gradient(180deg, rgba(255,141,92,0.18), rgba(255,141,92,0.1))'
      : 'transparent',
    color: active ? THEME.text : THEME.muted,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
    lineHeight: 1.1,
    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.08)' : 'none',
  };
}

function entryRowStyle(active: boolean): CSSProperties {
  return {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '9px 12px 9px 14px',
    borderRadius: 14,
    border: active
      ? '1px solid rgba(255,141,92,0.28)'
      : '1px solid transparent',
    background: active
      ? 'linear-gradient(180deg, rgba(255,141,92,0.1) 0%, rgba(255,141,92,0.04) 100%)'
      : 'transparent',
    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : 'none',
    cursor: 'pointer',
    color: THEME.text,
    textAlign: 'left',
    transition: 'background 120ms ease, border-color 120ms ease',
  };
}

function selectionIndicatorStyle(): CSSProperties {
  return {
    position: 'absolute',
    left: 4,
    top: '20%',
    bottom: '20%',
    width: 3,
    borderRadius: 3,
    background:
      'linear-gradient(180deg, #ffb38a 0%, #ff8d5c 50%, #ff6a33 100%)',
    boxShadow: '0 0 8px rgba(255,141,92,0.6)',
  };
}

function primaryButtonStyle(): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 14px',
    borderRadius: 10,
    border: '1px solid rgba(255,141,92,0.5)',
    background: 'linear-gradient(180deg, #ff9f72 0%, #ff7a42 100%)',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow:
      'inset 0 1px 0 rgba(255,255,255,0.25), 0 4px 10px rgba(255,100,40,0.22)',
    fontFamily: THEME.font,
  };
}

function secondaryButtonStyle(): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.05)',
    color: THEME.text,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: THEME.font,
  };
}

function ghostButtonStyle(): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.06)',
    background: 'transparent',
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: THEME.font,
  };
}

function iconButtonStyle(active: boolean): CSSProperties {
  return {
    width: 30,
    height: 30,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    border: active
      ? '1px solid rgba(255,141,92,0.35)'
      : '1px solid rgba(255,255,255,0.08)',
    background: active ? 'rgba(255,141,92,0.12)' : 'rgba(255,255,255,0.04)',
    color: active ? THEME.accent : THEME.muted,
    cursor: 'pointer',
    flexShrink: 0,
  };
}

function metaChipStyle(): CSSProperties {
  return {
    fontSize: 10.5,
    lineHeight: 1,
    padding: '5px 9px',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.05)',
    color: THEME.muted,
    fontWeight: 600,
  };
}

const INTERACTION_CSS = `
.oling-entry-row:hover {
  background: rgba(255,255,255,0.04) !important;
}
.oling-filter-pill:hover {
  color: ${THEME.text};
}
.oling-ai-tile:hover {
  background: rgba(255,255,255,0.06) !important;
  border-color: rgba(255,255,255,0.12) !important;
}
.oling-primary-btn:hover {
  filter: brightness(1.06);
}
.oling-secondary-btn:hover {
  background: rgba(255,255,255,0.08) !important;
}
.oling-ghost-btn:hover {
  color: ${THEME.text} !important;
  background: rgba(255,255,255,0.04) !important;
}
.oling-icon-btn:hover {
  background: rgba(255,255,255,0.08) !important;
}
.oling-close-btn:hover {
  filter: brightness(1.1);
}
.oling-code-editor-textarea::selection {
  background: rgba(255, 141, 92, 0.28);
  color: transparent;
}
.oling-code-editor-textarea::-moz-selection {
  background: rgba(255, 141, 92, 0.28);
  color: transparent;
}
`;

function SearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke={THEME.muted} strokeWidth="1.4" />
      <path
        d="M10.5 10.5L13.5 13.5"
        stroke={THEME.muted}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FilterGlyphAll() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="6" r="1.4" fill="currentColor" />
    </svg>
  );
}

function FilterGlyphText() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 2.5h8M6 2.5V10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FilterGlyphImage() {
  return (
    <svg width="12" height="11" viewBox="0 0 14 12" fill="none" aria-hidden>
      <rect
        x="1.5"
        y="1.5"
        width="11"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="5" cy="5" r="1" fill="currentColor" />
      <path
        d="M1.5 9l3-3 3.5 3 2-1.5L12.5 9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilterGlyphStar() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M6 1.3l1.45 2.94 3.25.47-2.35 2.29.56 3.24L6 8.72l-2.91 1.52.56-3.24L1.3 4.71l3.25-.47L6 1.3z"
        fill="currentColor"
      />
    </svg>
  );
}

function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M6 1.3l1.45 2.94 3.25.47-2.35 2.29.56 3.24L6 8.72l-2.91 1.52.56-3.24L1.3 4.71l3.25-.47L6 1.3z"
        fill={filled ? THEME.accent : 'transparent'}
        stroke={filled ? THEME.accent : THEME.dim}
        strokeWidth={filled ? 0 : 1.1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LinkGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M8.5 11.5l3-3M7 13.5a3 3 0 01-4.24-4.24l2-2a3 3 0 014.24 0M13 6.5a3 3 0 014.24 4.24l-2 2a3 3 0 01-4.24 0"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ImageGlyph({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 16" fill="none" aria-hidden>
      <rect
        x="1.5"
        y="1.5"
        width="17"
        height="13"
        rx="2"
        stroke={color}
        strokeWidth="1.3"
      />
      <circle cx="6.5" cy="6.5" r="1.5" fill={color} />
      <path
        d="M1.5 12l5-5 5 4 3-2 4 3"
        stroke={color}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SparkleGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M6 1v3M6 8v3M1 6h3M8 6h3"
        stroke={THEME.accent}
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="6" cy="6" r="1.2" fill={THEME.accent} />
    </svg>
  );
}

function TileGlyphSummarize() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5h10M3 8h7M3 11.5h10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TileGlyphTranslate() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2.5 8h11M8 2.5c1.6 2 1.6 9 0 11M8 2.5c-1.6 2-1.6 9 0 11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TileGlyphRewrite() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 4l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
