import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClipboardHistoryView,
  __resetSourceAppIconCacheForTests,
} from '../ClipboardHistoryView';
import {
  emitTauriEvent,
  invoke,
  clearEventHandlers,
} from '../../testUtils/mocks/tauri';
import {
  __mockWindow,
  PhysicalPosition,
  PhysicalSize,
} from '../../testUtils/mocks/tauri-window';
import type { ClipboardEntry } from '../../types/clipboard';

function createEntries(): ClipboardEntry[] {
  return [
    {
      id: 'text-1',
      kind: 'text',
      text_preview: 'Fix the release checklist before Friday',
      text_content: 'Fix the release checklist before Friday',
      image_path: null,
      source_app: 'Slack',
      source_bundle_id: 'com.tinyspeck.slackmacgap',
      created_at: Date.now() - 1000,
      last_copied_at: Date.now() - 1000,
      copy_count: 2,
      is_favorite: false,
    },
    {
      id: 'image-1',
      kind: 'image',
      text_preview: 'Image copied from Chrome',
      text_content: null,
      image_path: '/tmp/clip.png',
      source_app: 'Chrome',
      source_bundle_id: 'com.google.Chrome',
      created_at: Date.now() - 5000,
      last_copied_at: Date.now() - 5000,
      copy_count: 1,
      is_favorite: true,
    },
  ];
}

describe('ClipboardHistoryView', () => {
  let entries: ReturnType<typeof createEntries>;

  beforeEach(() => {
    __resetSourceAppIconCacheForTests();
    entries = createEntries();
    invoke.mockClear();
    clearEventHandlers();
    __mockWindow.innerPosition.mockReset();
    __mockWindow.innerPosition.mockResolvedValue(new PhysicalPosition(120, 90));
    __mockWindow.innerSize.mockReset();
    __mockWindow.innerSize.mockResolvedValue(new PhysicalSize(920, 640));
    __mockWindow.scaleFactor.mockReset();
    __mockWindow.scaleFactor.mockResolvedValue(2);
    invoke.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'list_clipboard_entries') {
          const kind = args?.kind as string | null | undefined;
          const favoritesOnly = Boolean(args?.favoritesOnly);
          return entries.filter((entry) => {
            if (kind && entry.kind !== kind) return false;
            if (favoritesOnly && !entry.is_favorite) return false;
            return true;
          });
        }
        if (cmd === 'get_settings') {
          return {
            clipboard_ai_actions: ['/tldr', '/translate', '/rewrite'],
            commands_config: { overrides: {}, custom: [], disabled: [] },
          };
        }
        if (cmd === 'update_clipboard_text_entry') {
          entries = entries.map((entry) =>
            entry.id === args?.entryId
              ? {
                  ...entry,
                  text_preview: String(args?.text),
                  text_content: String(args?.text),
                  source_app: 'Oling',
                  source_bundle_id: 'com.quietnode.oling',
                }
              : entry,
          );
          return String(args?.entryId);
        }
        return undefined;
      },
    );
  });

  it('renders clipboard entries and selects the first one', async () => {
    render(<ClipboardHistoryView />);

    expect(await screen.findByTestId('clipboard-root')).toBeInTheDocument();
    expect(
      screen.getAllByText('Fix the release checklist before Friday').length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId('clipboard-preview-text')).toHaveTextContent(
      'Fix the release checklist before Friday',
    );
  });

  it('filters to favorites and requests the backend accordingly', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-filter-favorites'));
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('list_clipboard_entries', {
        search: null,
        kind: null,
        favoritesOnly: true,
      });
    });
    expect(screen.getByText('Image copied from Chrome')).toBeInTheDocument();
  });

  it('runs copy, paste, and user-selected AI actions for the active entry', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');
    await screen.findByTestId('clipboard-ai-tldr');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-copy-btn'));
      fireEvent.click(screen.getByTestId('clipboard-copy-plain-btn'));
      fireEvent.click(screen.getByTestId('clipboard-paste-btn'));
      fireEvent.click(screen.getByTestId('clipboard-ai-tldr'));
      fireEvent.click(screen.getByTestId('clipboard-ai-translate'));
    });

    expect(invoke).toHaveBeenCalledWith('copy_clipboard_entry', {
      entryId: 'text-1',
    });
    expect(invoke).toHaveBeenCalledWith('copy_clipboard_entry_plain_text', {
      entryId: 'text-1',
    });
    expect(invoke).toHaveBeenCalledWith('paste_clipboard_entry', {
      entryId: 'text-1',
    });
    expect(invoke).toHaveBeenCalledWith('open_clipboard_entry_in_oling', {
      entryId: 'text-1',
      prompt: '/tldr',
      autoSubmit: true,
    });
    expect(invoke).toHaveBeenCalledWith('open_clipboard_entry_in_oling', {
      entryId: 'text-1',
      prompt: '/translate',
      autoSubmit: true,
    });
  });

  it('hides the AI Actions section when the user has selected nothing', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_clipboard_entries') return entries;
      if (cmd === 'get_settings') {
        return {
          clipboard_ai_actions: [],
          commands_config: { overrides: {}, custom: [], disabled: [] },
        };
      }
      return undefined;
    });
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');
    await act(async () => {});
    expect(screen.queryByTestId('clipboard-ai-actions')).toBeNull();
  });

  it('allows editing a text clipboard entry and saving it back', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-start-edit-btn'));
    });

    const textarea = screen.getByTestId(
      'clipboard-edit-textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Fix the release checklist before Friday');

    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: 'Ship the clipboard panel polish today' },
      });
      fireEvent.click(screen.getByTestId('clipboard-save-edit-btn'));
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update_clipboard_text_entry', {
        entryId: 'text-1',
        text: 'Ship the clipboard panel polish today',
      });
    });
    expect(screen.getByTestId('clipboard-preview-text')).toHaveTextContent(
      'Ship the clipboard panel polish today',
    );
  });

  it('reloads when the clipboard update event fires', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    invoke.mockClear();
    act(() => {
      emitTauriEvent('oling://clipboard-history-updated', null);
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('list_clipboard_entries', {
        search: null,
        kind: null,
        favoritesOnly: false,
      });
    });
  });

  it('shows the image preview and fires AI action against the image entry', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');
    await screen.findByTestId('clipboard-ai-tldr');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-entry-image-1'));
    });

    expect(screen.getByTestId('clipboard-preview-image')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-ai-translate'));
    });

    expect(invoke).toHaveBeenCalledWith(
      'open_clipboard_entry_in_oling',
      expect.objectContaining({
        entryId: 'image-1',
        prompt: '/translate',
        autoSubmit: true,
      }),
    );
  });

  it('opens the shared image editor for image entries', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-entry-image-1'));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-edit-btn'));
    });

    expect(invoke).toHaveBeenCalledWith('edit_clipboard_entry', {
      entryId: 'image-1',
      x: 60,
      y: 45,
      width: 460,
      height: 320,
    });
  });

  it('keeps the preview/action column scrollable and separated from the footer', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    expect(screen.getByTestId('clipboard-detail-scroll')).toBeInTheDocument();
  });

  it('groups pinned and dated entries and renders section headers', async () => {
    const now = Date.now();
    const startOfToday = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      new Date().getDate(),
    ).getTime();
    const yesterdayTs = startOfToday - 3_600_000;
    const earlierTs = startOfToday - 3 * 86_400_000;

    entries = [
      {
        id: 'today-1',
        kind: 'text',
        text_preview: 'https://example.com/today',
        text_content: 'https://example.com/today',
        image_path: null,
        source_app: 'Arc',
        source_bundle_id: 'co.arc',
        created_at: now - 1_000,
        last_copied_at: now - 1_000,
        copy_count: 1,
        is_favorite: false,
      },
      {
        id: 'pinned-1',
        kind: 'text',
        text_preview: '#ff8d5c',
        text_content: '#ff8d5c',
        image_path: null,
        source_app: 'Figma',
        source_bundle_id: 'com.figma',
        created_at: now - 2_000,
        last_copied_at: now - 2_000,
        copy_count: 5,
        is_favorite: true,
      },
      {
        id: 'yesterday-1',
        kind: 'text',
        text_preview: 'const x = { y: 1 };',
        text_content: 'const x = { y: 1 };\nconsole.log(x);',
        image_path: null,
        source_app: 'Cursor',
        source_bundle_id: 'com.cursor',
        created_at: yesterdayTs,
        last_copied_at: yesterdayTs,
        copy_count: 2,
        is_favorite: false,
      },
      {
        id: 'earlier-1',
        kind: 'text',
        text_preview: 'Old plain text',
        text_content: 'Old plain text',
        image_path: null,
        source_app: null,
        source_bundle_id: null,
        created_at: earlierTs,
        last_copied_at: earlierTs,
        copy_count: 1,
        is_favorite: false,
      },
    ];

    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    expect(screen.getByTestId('clipboard-section-pinned')).toBeInTheDocument();
    expect(screen.getByTestId('clipboard-section-today')).toBeInTheDocument();
    expect(
      screen.getByTestId('clipboard-section-yesterday'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('clipboard-section-earlier')).toBeInTheDocument();
  });

  it('navigates entries with ArrowUp/ArrowDown and pastes on Enter', async () => {
    entries = entries.map((entry) => ({ ...entry, is_favorite: false }));
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-entry-image-1');

    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowDown' });
    });
    expect(
      screen.getByTestId('clipboard-entry-image-1').getAttribute('style'),
    ).toContain('141, 92');

    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowUp' });
    });
    expect(
      screen.getByTestId('clipboard-entry-text-1').getAttribute('style'),
    ).toContain('141, 92');

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('paste_clipboard_entry', {
        entryId: 'text-1',
      });
    });
  });

  it('focuses the search input on Cmd+F and closes on Escape', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true });
    });
    expect(screen.getByTestId('clipboard-search')).toHaveFocus();

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('close_clipboard_window');
    });
  });

  it('saves text edits via Cmd+Enter while editing', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-start-edit-btn'));
    });
    const textarea = screen.getByTestId(
      'clipboard-edit-textarea',
    ) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Fresh text' } });
      fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update_clipboard_text_entry', {
        entryId: 'text-1',
        text: 'Fresh text',
      });
    });
  });

  it('deletes the active entry on Cmd+Backspace', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-entry-text-1');

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Backspace', metaKey: true });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('delete_clipboard_entry', {
        entryId: 'text-1',
      });
    });
  });

  it('cancels text edit and restores the read-only preview', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-start-edit-btn'));
    });
    expect(screen.getByTestId('clipboard-edit-textarea')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-cancel-edit-btn'));
    });
    expect(screen.getByTestId('clipboard-preview-text')).toBeInTheDocument();
  });

  it('toggles favorite, clears the history, and fires backend invocations', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    invoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Pin entry/i }));
      fireEvent.click(screen.getByTestId('clipboard-clear-btn'));
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('toggle_clipboard_entry_favorite', {
        entryId: 'text-1',
      });
      expect(invoke).toHaveBeenCalledWith('clear_clipboard_history');
    });
  });

  describe('status flashes', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-dismisses copy status after the timer elapses', async () => {
      render(<ClipboardHistoryView />);
      await screen.findByTestId('clipboard-root');

      await act(async () => {
        fireEvent.click(screen.getByTestId('clipboard-copy-btn'));
      });
      await waitFor(() => {
        expect(
          screen.getByText('Copied back to clipboard'),
        ).toBeInTheDocument();
      });

      act(() => {
        vi.advanceTimersByTime(2500);
      });

      await waitFor(() => {
        expect(
          screen.queryByText('Copied back to clipboard'),
        ).not.toBeInTheDocument();
      });
    });
  });

  it('reports backend load errors in the footer', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_clipboard_entries') throw 'boom';
      return undefined;
    });
    render(<ClipboardHistoryView />);
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('surfaces save errors from update_clipboard_text_entry', async () => {
    invoke.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'list_clipboard_entries') {
          return entries;
        }
        if (cmd === 'update_clipboard_text_entry') {
          throw new Error('save failed: ' + String(args?.entryId));
        }
        return undefined;
      },
    );
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-start-edit-btn'));
    });
    const textarea = screen.getByTestId(
      'clipboard-edit-textarea',
    ) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'boom' } });
      fireEvent.click(screen.getByTestId('clipboard-save-edit-btn'));
    });

    await waitFor(() => {
      expect(screen.getByText(/save failed/)).toBeInTheDocument();
    });
  });

  it('falls back to window.hide when close_clipboard_window fails', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_clipboard_entries') {
        return entries;
      }
      if (cmd === 'close_clipboard_window') {
        throw new Error('nope');
      }
      return undefined;
    });
    __mockWindow.hide.mockReset();
    __mockWindow.hide.mockResolvedValue(undefined);

    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(__mockWindow.hide).toHaveBeenCalled();
    });
  });

  it('does not paste when Enter is pressed while text editing is active', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-entry-text-1');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-start-edit-btn'));
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'paste_clipboard_entry',
      expect.anything(),
    );
  });

  it('renders a resolved source app icon when the backend returns one', async () => {
    invoke.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'list_clipboard_entries') return entries;
        if (cmd === 'get_source_app_icon') {
          return `/tmp/app-icons/${String(args?.bundleId)}.png`;
        }
        return undefined;
      },
    );
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-entry-text-1');

    await waitFor(() => {
      const img = document.querySelector(
        'img[src*="com.tinyspeck.slackmacgap.png"]',
      );
      expect(img).not.toBeNull();
    });
  });

  it('ignores navigation keys while typing into a text input', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    const search = screen.getByTestId('clipboard-search');
    (search as HTMLInputElement).focus();
    await act(async () => {
      fireEvent.keyDown(search, { key: 'ArrowDown' });
      fireEvent.keyDown(search, { key: 'ArrowUp' });
      fireEvent.keyDown(search, { key: 'Enter' });
    });
    expect(screen.getByTestId('clipboard-preview-text')).toHaveTextContent(
      'Fix the release checklist before Friday',
    );
  });
});
