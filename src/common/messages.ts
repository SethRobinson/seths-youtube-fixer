// Typed messages between content script, popup, options, and the service worker.
import type { CaptureItem, FeedbackStats, FeedbackType, ActionLogEntry } from './feedback';

export interface NewActionInput {
  type: FeedbackType;
  source: 'app' | 'native';
  videoId?: string;
  channelId?: string;
  title?: string;
  channelName?: string;
  actionToken?: string;
  undoToken?: string;
}

export type SyfMessage =
  | { type: 'SYF_PING' }
  | { type: 'SYF_INJECTED'; videoId: string }
  | { type: 'SYF_CAPTURE'; items: CaptureItem[] }
  | { type: 'SYF_LOOKUP'; videoId: string; channelId?: string }
  | { type: 'SYF_STATS' }
  | { type: 'SYF_LOG_ACTION'; entry: NewActionInput }
  | {
      type: 'SYF_MARK_UNDONE';
      id?: string;
      match?: { type: FeedbackType; videoId?: string; channelId?: string };
    }
  | { type: 'SYF_GET_LOG' }
  | { type: 'SYF_WIPE'; mode: 'scan' | 'delete'; startMs: number; endMs: number }
  | { type: 'SYF_MA_SCAN'; startMs: number; endMs: number }
  | { type: 'SYF_MA_DELETE'; startMs: number; endMs: number }
  | { type: 'SYF_OPEN_OPTIONS' }
  | { type: 'SYF_OPEN_PAGE'; page: 'wipe' | 'log' | 'history' }
  | { type: 'SYF_RELAY_REPLAY'; token: string }
  | { type: 'SYF_DO_REPLAY'; token: string }
  | { type: 'SYF_HISTORY'; action: 'toggle' | 'state' }
  | { type: 'SYF_HISTORY_DO'; action: 'toggle' | 'state' }
  | { type: 'SYF_RESET' };

export interface HistoryResult {
  ok: boolean;
  paused?: boolean | null;
  found?: boolean;
  error?: string;
}

export interface WipeItem {
  title: string;
  timeText: string;
  ms: number;
}

export interface WipeResult {
  ok: boolean;
  mode: 'scan' | 'delete';
  matched: WipeItem[];
  deleted?: number;
  error?: string;
}

export interface ActiveAction {
  id: string;
  undoToken?: string;
}

export interface LookupResult {
  ok: true;
  nah: boolean;
  hate: boolean;
  videoKnown: boolean;
  nahToken?: string;
  nahUndoToken?: string;
  hateToken?: string;
  hateUndoToken?: string;
  nahActive?: ActiveAction;
  hateActive?: ActiveAction;
}

export interface StatsResult {
  ok: true;
  stats: FeedbackStats;
}

export interface LogResult {
  ok: true;
  log: ActionLogEntry[];
}

export const SETTINGS_KEY = 'syf.settings';

export interface SyfSettings {
  apiKey?: string;
  wipePresetsMin?: number[];
  confirmBeforeWipe?: boolean;
  feedbackTtlDays?: number; // how long a cached feedback token is considered usable
  hideShorts?: boolean; // hide Shorts shelves/cards from feeds
  lastHistoryPaused?: boolean; // cached watch-history state for the bar toggle label
  dismissedWarnings?: Record<string, boolean>; // "don't show again" flags (e.g. { history: true })
}

export const DEFAULT_SETTINGS: SyfSettings = {
  apiKey: '',
  wipePresetsMin: [15, 30, 60, 120],
  confirmBeforeWipe: true,
  feedbackTtlDays: 7,
  hideShorts: false,
};

// Storage keys cleared by "Reset data for this extension".
export const ALL_STORAGE_KEYS = ['syf.feedback', 'syf.actionlog', SETTINGS_KEY];
