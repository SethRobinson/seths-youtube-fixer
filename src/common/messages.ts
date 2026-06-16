// Typed messages exchanged between content script, popup, options, and the
// background service worker. Extend this union as features land.

export type SyfMessage =
  | { type: 'SYF_PING' }
  | { type: 'SYF_INJECTED'; videoId: string };

export type SyfResponse =
  | { ok: true; ts: number }
  | { ok: false; error: string };

export const SETTINGS_KEY = 'syf.settings';

export interface SyfSettings {
  apiKey?: string;
  wipePresetsMin?: number[];
  confirmBeforeWipe?: boolean;
}

export const DEFAULT_SETTINGS: SyfSettings = {
  apiKey: '',
  wipePresetsMin: [15, 30, 60, 120],
  confirmBeforeWipe: true,
};
