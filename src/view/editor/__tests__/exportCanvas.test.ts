import { describe, it, expect, vi } from 'vitest';
import { dataUrlToBase64, exportStageToDataURL } from '../exportCanvas';
import type Konva from 'konva';

describe('dataUrlToBase64', () => {
  it('extracts base64 payload from a PNG data URL', () => {
    expect(dataUrlToBase64('data:image/png;base64,ABCDEF')).toBe('ABCDEF');
  });

  it('returns null for a string without a comma separator', () => {
    expect(dataUrlToBase64('plain-string')).toBeNull();
  });

  it('returns empty string when comma is last char', () => {
    expect(dataUrlToBase64('data:image/png;base64,')).toBe('');
  });
});

describe('exportStageToDataURL', () => {
  it('returns null when stage is null', () => {
    expect(exportStageToDataURL(null)).toBeNull();
  });

  it('delegates to stage.toDataURL when available', () => {
    const toDataURL = vi.fn().mockReturnValue('data:image/png;base64,XYZ');
    const stage = { toDataURL } as unknown as Konva.Stage;
    expect(exportStageToDataURL(stage)).toBe('data:image/png;base64,XYZ');
    expect(toDataURL).toHaveBeenCalledWith({
      pixelRatio: 2,
      mimeType: 'image/png',
    });
  });

  it('passes a custom pixel ratio through to stage export', () => {
    const toDataURL = vi.fn().mockReturnValue('data:image/png;base64,CUSTOM');
    const stage = { toDataURL } as unknown as Konva.Stage;
    expect(exportStageToDataURL(stage, 0.5)).toBe(
      'data:image/png;base64,CUSTOM',
    );
    expect(toDataURL).toHaveBeenCalledWith({
      pixelRatio: 0.5,
      mimeType: 'image/png',
    });
  });
});
