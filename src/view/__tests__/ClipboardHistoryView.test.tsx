import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClipboardHistoryView } from '../ClipboardHistoryView';
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

const ENTRIES = [
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

describe('ClipboardHistoryView', () => {
  beforeEach(() => {
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
          return ENTRIES.filter((entry) => {
            if (kind && entry.kind !== kind) return false;
            if (favoritesOnly && !entry.is_favorite) return false;
            return true;
          });
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

  it('runs copy, paste, and Ask in Oling actions for the active entry', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-copy-btn'));
      fireEvent.click(screen.getByTestId('clipboard-paste-btn'));
      fireEvent.click(screen.getByTestId('clipboard-ask-btn'));
      fireEvent.click(screen.getByTestId('clipboard-ai-summarize'));
    });

    expect(invoke).toHaveBeenCalledWith('copy_clipboard_entry', {
      entryId: 'text-1',
    });
    expect(invoke).toHaveBeenCalledWith('paste_clipboard_entry', {
      entryId: 'text-1',
    });
    expect(invoke).toHaveBeenCalledWith('open_clipboard_entry_in_oling', {
      entryId: 'text-1',
      prompt: null,
      autoSubmit: false,
    });
    expect(invoke).toHaveBeenCalledWith('open_clipboard_entry_in_oling', {
      entryId: 'text-1',
      prompt: '/tldr',
      autoSubmit: true,
    });
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

  it('shows image preview and image-specific AI action', async () => {
    render(<ClipboardHistoryView />);
    await screen.findByTestId('clipboard-root');

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-entry-image-1'));
    });

    expect(screen.getByTestId('clipboard-preview-image')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('clipboard-ai-ocr-clean'));
    });

    expect(invoke).toHaveBeenCalledWith(
      'open_clipboard_entry_in_oling',
      expect.objectContaining({
        entryId: 'image-1',
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
});
