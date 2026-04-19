import { describe, expect, it } from 'vitest';
import tauriConfig from '../../src-tauri/tauri.conf.json';

describe('tauri assetProtocol scope', () => {
  it('allows clipboard image assets from app data', () => {
    expect(tauriConfig.app?.security?.assetProtocol?.scope).toContain(
      '$APPDATA/clipboard/**',
    );
  });
});
