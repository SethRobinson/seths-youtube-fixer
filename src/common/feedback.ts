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

export function emptyCache(): FeedbackCache {
  return {
    version: 1,
    videos: {},
    channels: {},
    stats: { capturesSeen: 0, videosTracked: 0, channelsTracked: 0 },
  };
}

export function isFresh(t: CachedToken | undefined): boolean {
  return !!t && Date.now() - t.capturedAt < FEEDBACK_TTL_MS;
}
