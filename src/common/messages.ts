// Typed messages between content script, popup, options, and the service worker.
import type { CaptureItem, FeedbackStats } from './feedback';

export type SyfMessage =
  | { type: 'SYF_PING' }
  | { type: 'SYF_INJECTED'; videoId: string }
  | { type: 'SYF_CAPTURE'; items: CaptureItem[] }
  | { type: 'SYF_LOOKUP'; videoId: string; channelId?: string }
  | { type: 'SYF_STATS' };

export interface LookupResult {
  ok: true;
  nah: boolean;
  hate: boolean;
  videoKnown: boolean;
}

export interface StatsResult {
  ok: true;
  stats: FeedbackStats;
}

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
