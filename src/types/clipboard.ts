export type ClipboardEntryKind = 'text' | 'image';

export interface ClipboardEntry {
  id: string;
  kind: ClipboardEntryKind;
  text_preview: string;
  text_content: string | null;
  image_path: string | null;
  source_app: string | null;
  source_bundle_id: string | null;
  created_at: number;
  last_copied_at: number;
  copy_count: number;
  is_favorite: boolean;
}
