import type Konva from 'konva';

/**
 * Exports a Konva Stage as a PNG data URL. Returns `null` when the stage is
 * unavailable (e.g. the component has not mounted yet or the ref was cleared).
 *
 * Extracted so the export path can be unit-tested with a minimal stage stub.
 */
export function exportStageToDataURL(stage: Konva.Stage | null): string | null {
  if (!stage) return null;
  try {
    return stage.toDataURL({ pixelRatio: 2, mimeType: 'image/png' });
  } catch {
    /* v8 ignore next -- Konva throws on empty/invalid stage; defensive */
    return null;
  }
}

/** Converts a `data:image/png;base64,…` URL into the raw base64 payload. */
export function dataUrlToBase64(dataUrl: string): string | null {
  const idx = dataUrl.indexOf(',');
  if (idx === -1) return null;
  return dataUrl.slice(idx + 1);
}
