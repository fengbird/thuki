import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ClipboardEntry } from '../types/clipboard';

const UPDATED_EVENT = 'oling://clipboard-history-updated';
const OCR_AND_CLEAN_PROMPT =
  '请读取图片中所有清晰可见的文字，并在不改变原意的前提下整理排版，让结果更清晰、易读、便于复制。不要添加任何说明、标题、解释、编号或项目符号，只输出整理后的正文内容。';

type FilterKey = 'all' | 'text' | 'image' | 'favorites';

const THEME = {
  shell:
    'radial-gradient(ellipse 80% 58% at 50% -4%, rgba(255,141,92,0.13) 0%, rgba(32,27,23,0.96) 52%), linear-gradient(180deg, rgba(29,24,21,0.98) 0%, rgba(18,15,13,0.98) 100%)',
  border: '1px solid rgba(255,141,92,0.18)',
  divider: 'rgba(255,255,255,0.06)',
  text: '#f4f1ed',
  muted: 'rgba(255,255,255,0.58)',
  dim: 'rgba(255,255,255,0.34)',
  accent: '#ff8d5c',
  glass: 'rgba(255,255,255,0.045)',
  glassStrong: 'rgba(255,255,255,0.075)',
  chip: 'rgba(255,141,92,0.11)',
  chipBorder: 'rgba(255,141,92,0.22)',
  shadow: '0 34px 90px rgba(0,0,0,0.48), 0 0 36px rgba(255,100,40,0.07)',
  font: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
};

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'text', label: 'Text' },
  { key: 'image', label: 'Images' },
  { key: 'favorites', label: 'Favorites' },
];

function formatTimeAgo(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  return `${Math.floor(delta / day)}d`;
}

function entryKindLabel(kind: ClipboardEntry['kind']) {
  return kind === 'image' ? 'Image' : 'Text';
}

function isTextInputTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  );
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
  const searchRef = useRef<HTMLInputElement | null>(null);

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
      setStatus(null);
    } catch (error) {
      setEntries([]);
      setStatus(typeof error === 'string' ? error : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [filter, search]);

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

  useEffect(() => {
    if (entries.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(entries[0].id);
    }
  }, [entries, selectedId]);

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );
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
      setStatus('Copied back to clipboard');
      void loadEntries();
    },
    [loadEntries],
  );

  const copyEntryPlainText = useCallback(
    async (entryId: string) => {
      await invoke('copy_clipboard_entry_plain_text', { entryId });
      setStatus('Copied as plain text');
      void loadEntries();
    },
    [loadEntries],
  );

  const pasteEntry = useCallback(
    async (entryId: string) => {
      await invoke('paste_clipboard_entry', { entryId });
      setStatus('Pasted into previous app');
      void loadEntries();
    },
    [loadEntries],
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
        setStatus('Clipboard text updated');
        cancelTextEdit();
        void loadEntries();
      } catch (error) {
        setStatus(typeof error === 'string' ? error : String(error));
        setIsSavingEdit(false);
      }
    },
    [cancelTextEdit, editingText, loadEntries],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
      if (!entries.length) {
        return;
      }
      if (event.key === 'ArrowDown') {
        if (isTextInputTarget(event.target)) return;
        event.preventDefault();
        const currentIndex = entries.findIndex(
          (entry) => entry.id === selectedId,
        );
        const nextIndex =
          currentIndex < 0 ? 0 : Math.min(entries.length - 1, currentIndex + 1);
        setSelectedId(entries[nextIndex].id);
        return;
      }
      if (event.key === 'ArrowUp') {
        if (isTextInputTarget(event.target)) return;
        event.preventDefault();
        const currentIndex = entries.findIndex(
          (entry) => entry.id === selectedId,
        );
        const nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
        setSelectedId(entries[nextIndex].id);
        return;
      }
      if (event.key === 'Enter' && activeEntry) {
        if (isTextInputTarget(event.target)) return;
        event.preventDefault();
        void pasteEntry(activeEntry.id);
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
    entries,
    isEditingActiveText,
    pasteEntry,
    saveTextEdit,
    selectedId,
  ]);

  return (
    <div
      data-testid="clipboard-root"
      style={{
        width: '100vw',
        height: '100vh',
        padding: 16,
        boxSizing: 'border-box',
        background: 'transparent',
        fontFamily: THEME.font,
        color: THEME.text,
      }}
    >
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
          backdropFilter: 'blur(24px)',
        }}
      >
        <div
          onMouseDown={(event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('button,input')) {
              return;
            }
            void getCurrentWindow()
              .startDragging()
              .catch(() => undefined);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            borderBottom: `1px solid ${THEME.divider}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              onClick={() => void closeWindow()}
              aria-label="Close clipboard history"
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#ff5f57',
                border: 'none',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 14, fontWeight: 700 }}>Clipboard</span>
            <span style={headerCountPillStyle()}>{entries.length} clips</span>
          </div>
          <div style={{ flex: 1 }} />
          <input
            ref={searchRef}
            data-testid="clipboard-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search clips"
            style={{
              width: 320,
              padding: '10px 14px',
              borderRadius: 14,
              border: `1px solid rgba(255,255,255,0.08)`,
              background: THEME.glass,
              color: THEME.text,
              outline: 'none',
              fontSize: 12.5,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
            }}
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(360px, 0.96fr) minmax(420px, 1.08fr)',
            minHeight: 0,
          }}
        >
          <section
            style={{
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              padding: 14,
              gap: 12,
              borderRight: `1px solid ${THEME.divider}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              {FILTERS.map((item) => {
                const active = filter === item.key;
                return (
                  <button
                    key={item.key}
                    data-testid={`clipboard-filter-${item.key}`}
                    type="button"
                    onClick={() => setFilter(item.key)}
                    style={filterChipStyle(active)}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                minHeight: 0,
                overflow: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingRight: 2,
              }}
            >
              {isLoading ? (
                <EmptyState label="Loading clipboard history…" />
              ) : entries.length === 0 ? (
                <EmptyState label="No clipboard items yet." />
              ) : (
                entries.map((entry) => {
                  const active = entry.id === activeEntry?.id;
                  return (
                    <button
                      key={entry.id}
                      data-testid={`clipboard-entry-${entry.id}`}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      style={entryRowStyle(active)}
                    >
                      {entry.kind === 'image' && entry.image_path ? (
                        <img
                          src={convertFileSrc(entry.image_path)}
                          alt="Clipboard preview"
                          style={{
                            width: 54,
                            height: 54,
                            objectFit: 'cover',
                            borderRadius: 12,
                            background: 'rgba(255,255,255,0.04)',
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <div style={entryTypeGlyphStyle()}>T</div>
                      )}
                      <div
                        style={{
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 5,
                          flex: 1,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            minWidth: 0,
                          }}
                        >
                          <span style={miniTagStyle()}>
                            {entryKindLabel(entry.kind)}
                          </span>
                          <span
                            style={{
                              fontSize: 11.5,
                              color: THEME.muted,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {entry.source_app ?? 'Unknown app'}
                          </span>
                          {entry.is_favorite ? (
                            <span
                              style={{
                                fontSize: 11,
                                color: THEME.accent,
                                flexShrink: 0,
                              }}
                            >
                              Saved
                            </span>
                          ) : null}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            lineHeight: 1.45,
                            fontWeight: 600,
                            color: THEME.text,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textAlign: 'left',
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
                        }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            color: THEME.dim,
                          }}
                        >
                          {formatTimeAgo(entry.last_copied_at)}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            color: THEME.muted,
                          }}
                        >
                          {entry.copy_count}x
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <section
            style={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              padding: 14,
              gap: 12,
              overflow: 'hidden',
              background: 'rgba(255,255,255,0.018)',
            }}
          >
            {activeEntry ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span style={miniTagStyle()}>
                      {entryKindLabel(activeEntry.kind)}
                    </span>
                    <span style={inspectorMetaPillStyle()}>
                      {activeEntry.source_app ?? 'Unknown app'}
                    </span>
                    <span style={inspectorMetaPillStyle()}>
                      {formatTimeAgo(activeEntry.last_copied_at)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggleFavorite(activeEntry.id)}
                    style={ghostButtonStyle()}
                  >
                    {activeEntry.is_favorite ? 'Unfavorite' : 'Favorite'}
                  </button>
                </div>

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
                  <div
                    style={{
                      minHeight: 220,
                      borderRadius: 20,
                      border: '1px solid rgba(255,255,255,0.06)',
                      background:
                        activeEntry.kind === 'image'
                          ? 'rgba(255,255,255,0.03)'
                          : 'rgba(255,255,255,0.045)',
                      overflow: 'auto',
                      padding: 16,
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
                    }}
                  >
                    {activeEntry.kind === 'image' && activeEntry.image_path ? (
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
                      <textarea
                        data-testid="clipboard-edit-textarea"
                        value={editingText}
                        onChange={(event) => setEditingText(event.target.value)}
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
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
                        }}
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
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
                        }}
                      >
                        {activeEntry.text_content ?? activeEntry.text_preview}
                      </pre>
                    )}
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 8,
                    }}
                  >
                    <button
                      type="button"
                      data-testid="clipboard-copy-btn"
                      onClick={() => void copyEntry(activeEntry.id)}
                      style={secondaryButtonStyle()}
                    >
                      Copy
                    </button>
                    {activeEntry.kind === 'text' ? (
                      <button
                        type="button"
                        data-testid="clipboard-copy-plain-btn"
                        onClick={() => void copyEntryPlainText(activeEntry.id)}
                        style={secondaryButtonStyle()}
                      >
                        Plain Text
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="clipboard-edit-btn"
                        onClick={() => void editEntry(activeEntry.id)}
                        style={secondaryButtonStyle()}
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid="clipboard-paste-btn"
                      onClick={() => void pasteEntry(activeEntry.id)}
                      style={primaryButtonStyle()}
                    >
                      Paste
                    </button>
                    <button
                      type="button"
                      data-testid="clipboard-ask-btn"
                      onClick={() => void openInOling(activeEntry.id)}
                      style={secondaryButtonStyle()}
                    >
                      Ask in Oling
                    </button>
                    {activeEntry.kind === 'text' ? (
                      isEditingActiveText ? (
                        <>
                          <button
                            type="button"
                            data-testid="clipboard-save-edit-btn"
                            onClick={() => void saveTextEdit(activeEntry.id)}
                            disabled={isSavingEdit}
                            style={secondaryButtonStyle()}
                          >
                            {isSavingEdit ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            data-testid="clipboard-cancel-edit-btn"
                            onClick={cancelTextEdit}
                            disabled={isSavingEdit}
                            style={ghostButtonStyle()}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          data-testid="clipboard-start-edit-btn"
                          onClick={() => beginTextEdit(activeEntry)}
                          style={secondaryButtonStyle()}
                        >
                          Edit Text
                        </button>
                      )
                    ) : null}
                    <button
                      type="button"
                      data-testid="clipboard-delete-btn"
                      onClick={() => void deleteEntry(activeEntry.id)}
                      style={ghostButtonStyle()}
                    >
                      Delete
                    </button>
                  </div>

                  <div
                    style={{
                      borderTop: `1px solid ${THEME.divider}`,
                      paddingTop: 12,
                      paddingBottom: 2,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11.5,
                        color: THEME.muted,
                        fontWeight: 700,
                      }}
                    >
                      AI Actions
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                      }}
                    >
                      <button
                        type="button"
                        data-testid="clipboard-ai-summarize"
                        onClick={() =>
                          void openInOling(activeEntry.id, '/tldr', true)
                        }
                        style={aiChipStyle()}
                      >
                        Summarize
                      </button>
                      <button
                        type="button"
                        data-testid="clipboard-ai-translate"
                        onClick={() =>
                          void openInOling(activeEntry.id, '/translate', true)
                        }
                        style={aiChipStyle()}
                      >
                        Translate
                      </button>
                      {activeEntry.kind === 'text' ? (
                        <button
                          type="button"
                          data-testid="clipboard-ai-rewrite"
                          onClick={() =>
                            void openInOling(activeEntry.id, '/rewrite', true)
                          }
                          style={aiChipStyle()}
                        >
                          Rewrite
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid="clipboard-ai-ocr-clean"
                          onClick={() =>
                            void openInOling(
                              activeEntry.id,
                              OCR_AND_CLEAN_PROMPT,
                              true,
                            )
                          }
                          style={aiChipStyle()}
                        >
                          OCR &amp; Clean
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ flex: 1, minHeight: 0 }}>
                <EmptyState label="Select a clipboard item to inspect it." />
              </div>
            )}
          </section>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 16px',
            borderTop: `1px solid ${THEME.divider}`,
          }}
        >
          <span style={{ fontSize: 11.5, color: THEME.muted }}>
            {status ?? 'Clipboard stays local and searchable.'}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="clipboard-clear-btn"
            onClick={() => void clearAll()}
            style={ghostButtonStyle()}
          >
            Clear History
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div
      style={{
        minHeight: 160,
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

function headerCountPillStyle(): CSSProperties {
  return {
    padding: '4px 8px',
    borderRadius: 999,
    border: '1px solid rgba(255,255,255,0.06)',
    background: 'rgba(255,255,255,0.04)',
    color: THEME.muted,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1,
  };
}

function filterChipStyle(active: boolean): CSSProperties {
  return {
    padding: '7px 11px',
    borderRadius: 999,
    border: `1px solid ${active ? THEME.chipBorder : 'rgba(255,255,255,0.06)'}`,
    background: active ? THEME.chip : 'rgba(255,255,255,0.03)',
    color: active ? THEME.text : THEME.muted,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
    lineHeight: 1.1,
  };
}

function entryTypeGlyphStyle(): CSSProperties {
  return {
    width: 54,
    height: 54,
    borderRadius: 12,
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))',
    border: '1px solid rgba(255,255,255,0.05)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: THEME.muted,
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  };
}

function entryRowStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    borderRadius: 16,
    border: `1px solid ${
      active ? 'rgba(255,141,92,0.24)' : 'rgba(255,255,255,0.04)'
    }`,
    background: active ? 'rgba(255,141,92,0.08)' : 'rgba(255,255,255,0.025)',
    boxShadow: active ? '0 0 0 1px rgba(255,141,92,0.04) inset' : 'none',
    cursor: 'pointer',
    color: THEME.text,
    textAlign: 'left',
  };
}

function miniTagStyle(): CSSProperties {
  return {
    fontSize: 10.5,
    lineHeight: 1,
    padding: '4px 7px',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.05)',
    color: THEME.muted,
    flexShrink: 0,
  };
}

function inspectorMetaPillStyle(): CSSProperties {
  return {
    fontSize: 11,
    lineHeight: 1,
    padding: '5px 8px',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.04)',
    color: THEME.muted,
  };
}

function primaryButtonStyle(): CSSProperties {
  return {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgba(255,141,92,0.28)',
    background:
      'linear-gradient(180deg, rgba(255,141,92,0.24), rgba(255,141,92,0.16))',
    color: '#ffd9c7',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
  };
}

function secondaryButtonStyle(): CSSProperties {
  return {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.045)',
    color: THEME.text,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function ghostButtonStyle(): CSSProperties {
  return {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.06)',
    background: 'rgba(255,255,255,0.02)',
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function aiChipStyle(): CSSProperties {
  return {
    padding: '8px 11px',
    borderRadius: 999,
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.035)',
    color: THEME.muted,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
    lineHeight: 1.1,
  };
}
