// Feedback cache shape (stored in chrome.storage.local) + capture payloads.

export interface CaptureItem {
  videoId: string;
  channelId?: string;
  channelName?: string;
  title?: string;
  notInterestedToken?: string;
  notInterestedUndoToken?: string;
  dontRecommendChannelToken?: string;
  dontRecommendChannelUndoToken?: string;
  sourcePage?: string;
}

export interface CachedToken {
  token: string;
  undoToken?: string;
  capturedAt: number;
  sourcePage?: string;
  sampleVideoId?: string;
}

export interface VideoEntry {
  videoId: string;
  title?: string;
  channelId?: string;
  channelName?: string;
  notInterested?: CachedToken;
  dontRecommendChannel?: CachedToken;
  updatedAt: number;
}

export interface ChannelEntry {
  channelId: string;
  channelName?: string;
  dontRecommendChannel?: CachedToken;
  updatedAt: number;
}

export interface FeedbackStats {
  capturesSeen: number;
  videosTracked: number;
  channelsTracked: number;
  lastCaptureAt?: number;
}

export interface FeedbackCache {
  version: number;
  videos: Record<string, VideoEntry>;
  channels: Record<string, ChannelEntry>;
  stats: FeedbackStats;
}

export type FeedbackType = 'notInterested' | 'dontRecommendChannel';

export interface ActionLogEntry {
  id: string;
  ts: number;
  type: FeedbackType;
  source: 'app' | 'native';
  videoId?: string;
  channelId?: string;
  title?: string;
  channelName?: string;
  actionToken?: string;
  undoToken?: string;
  undone: boolean;
  undoneAt?: number;
}

export const FEEDBACK_KEY = 'syf.feedback';
export const ACTIONLOG_KEY = 'syf.actionlog';
export const FEEDBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Cache bounds (shared with the options UI). The manifest has `unlimitedStorage`, so
// there is NO 10 MB storage.local quota. The entry cap is user-configurable
// (`settings.maxCacheVideos`, applied to BOTH the video and channel maps): default
// DEFAULT_CACHE_CAP, adjustable between MIN_CACHE_CAP and MAX_CACHE_CAP in the options
// page. A self-imposed byte backstop bounds total size regardless.
export const DEFAULT_CACHE_CAP = 10_000;
export const MIN_CACHE_CAP = 100;
export const MAX_CACHE_CAP = 50_000;
export const MAX_FEEDBACK_BYTES = 50 * 1024 * 1024; // 50 MB

export function emptyCache(): FeedbackCache {
  return {
    version: 1,
    videos: {},
    channels: {},
    stats: { capturesSeen: 0, videosTracked: 0, channelsTracked: 0 },
  };
}

export function isFresh(t: CachedToken | undefined, ttlMs: number = FEEDBACK_TTL_MS): boolean {
  return !!t && Date.now() - t.capturedAt < ttlMs;
}
