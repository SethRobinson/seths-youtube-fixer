// Typed messages between content script, popup, options, and the service worker.
import { FEEDBACK_KEY, ACTIONLOG_KEY, DEFAULT_CACHE_CAP } from './feedback';
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
  | { type: 'SYF_WIPE'; mode: 'scan' | 'delete'; startMs: number; endMs: number; authUser?: string; pageId?: string }
  | { type: 'SYF_MA_SCAN'; startMs: number; endMs: number }
  | { type: 'SYF_MA_DELETE'; startMs: number; endMs: number }
  | { type: 'SYF_OPEN_OPTIONS' }
  | { type: 'SYF_OPEN_PAGE'; page: 'wipe'; minutes?: number; authUser?: string; pageId?: string }
  | { type: 'SYF_RELAY_REPLAY'; token: string }
  | { type: 'SYF_DO_REPLAY'; token: string }
  | { type: 'SYF_HISTORY'; action: 'toggle' | 'state'; authUser?: string; pageId?: string }
  | { type: 'SYF_HISTORY_DO'; action: 'toggle' | 'state' }
  | { type: 'SYF_PATCH_SETTINGS'; patch: Partial<SyfSettings> }
  | { type: 'SYF_OPEN_COMMENT_SEARCH'; videoId: string; title?: string }
  | { type: 'SYF_COMMENTS_PAGE'; videoId: string; pageToken?: string; order?: 'relevance' | 'time' }
  | { type: 'SYF_COMMENT_REPLIES'; parentId: string; pageToken?: string }
  | { type: 'SYF_GET_QUOTA' }
  | { type: 'SYF_RESET_QUOTA' }
  | { type: 'SYF_ACCOUNT'; accountId: string; authUser?: string; pageId?: string }
  | { type: 'SYF_RESET' };

export interface QuotaResult {
  ok: true;
  used: number; // estimated API units this extension spent today (Pacific)
  limit: number; // the user's daily quota (settings.apiDailyQuota, default 10,000)
  ptDate: string; // the Pacific date the count is for (YYYY-MM-DD)
}

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

// --- Find in comments (YouTube Data API v3) ---
export interface CsComment {
  id: string; // comment id (top-level), or "parentId.replyId" for a reply — usable as &lc=
  parentId?: string;
  isReply: boolean;
  author: string;
  authorChannelId?: string;
  authorAvatar?: string;
  text: string; // plain text (textFormat=plainText)
  likeCount: number;
  publishedAt: string;
}

export interface CsThread {
  top: CsComment;
  replies: CsComment[]; // preview replies (≤5) from commentThreads, or all when deep-fetched
  totalReplyCount: number;
  hasMoreReplies: boolean; // totalReplyCount > replies.length
}

export interface CommentsPageResult {
  ok: boolean;
  threads?: CsThread[];
  nextPageToken?: string;
  error?: string; // friendly message for the UI
  reason?: string; // raw API reason for branching (noKey, keyInvalid, quotaExceeded, commentsDisabled, …)
}

export interface RepliesPageResult {
  ok: boolean;
  replies?: CsComment[];
  nextPageToken?: string;
  error?: string;
  reason?: string;
}

export const SETTINGS_KEY = 'syf.settings';

// "Find in comments" scan cap: how many comments (incl. replies) a single scan loads before
// pausing for "Load more". Comments are NOT persisted (held in memory only while the window is
// open, then dropped), so this just bounds one scan's time + API quota — not storage. The
// default is generous so most videos finish in one pass; "Load more" continues past it.
export const DEFAULT_SCAN_CAP = 50_000;
export const MIN_SCAN_CAP = 1_000;
export const MAX_SCAN_CAP = 200_000;

// Daily YouTube Data API quota (units). Google's default is 10,000/day; users who request an
// increase can set their real number here. Used only to render the "units used today" gauge.
export const DEFAULT_DAILY_QUOTA = 10_000;

// Local estimate of API units this extension has spent today (resets at midnight Pacific, like
// Google's quota). The API can't report remaining quota to a key, so we count our own calls.
export const QUOTA_KEY = 'syf.quota';

// The active YouTube account's opaque identity fingerprint (from ytcfg DATASYNC_ID), account slot
// (`authuser`), and optional Brand-account page id. The fingerprint is used to detect account
// changes and clear account-specific feedback tokens/logs; authuser/pageId route YouTube/My
// Activity helper tabs to the account/channel the user is actually viewing. None are credentials.
export const ACCOUNT_KEY = 'syf.account';

export interface SyfSettings {
  apiKey?: string;
  wipePresetsMin?: number[];
  confirmBeforeWipe?: boolean;
  feedbackTtlDays?: number; // how long a cached feedback token is considered usable
  maxCacheVideos?: number; // LRU cap for the feedback cache, applied to both videos and channels
  commentScanCap?: number; // "Find in comments": comments loaded per scan before pausing for "Load more"
  commentSearchReplies?: boolean; // "Find in comments": remembered state of the "Replies too" checkbox
  apiDailyQuota?: number; // your YouTube Data API daily quota (units); for the "used today" gauge
  hideShorts?: boolean; // hide Shorts shelves/cards from feeds
  lastHistoryPaused?: boolean; // cached watch-history state for the bar toggle label
  dismissedWarnings?: Record<string, boolean>; // "don't show again" flags (e.g. { history: true })
}

export const DEFAULT_SETTINGS: SyfSettings = {
  apiKey: '',
  wipePresetsMin: [15, 30, 60, 120],
  confirmBeforeWipe: true,
  feedbackTtlDays: 7,
  maxCacheVideos: DEFAULT_CACHE_CAP,
  commentScanCap: DEFAULT_SCAN_CAP,
  commentSearchReplies: false,
  apiDailyQuota: DEFAULT_DAILY_QUOTA,
  hideShorts: false,
};

// Storage keys cleared by "Reset data for this extension".
export const ALL_STORAGE_KEYS = [FEEDBACK_KEY, ACTIONLOG_KEY, SETTINGS_KEY, QUOTA_KEY, ACCOUNT_KEY];
