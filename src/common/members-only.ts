import { isChannelId } from './channel-exceptions';

// Read badge enums, never titles, translated labels, or the generic green commerce
// styling (which YouTube also uses for videos that aren't members-only).
export interface MemberVideoState {
  videoId: string;
  membersOnly: boolean;
  channelId?: string;
}

export const MEMBER_VIDEO_CAP = 5000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

export function memberVideoState(node: any, channelGridOwner?: string): MemberVideoState | undefined {
  const card = node?.lockupViewModel ?? node?.videoRenderer ?? node?.compactVideoRenderer ??
    node?.gridVideoRenderer ?? node?.playlistVideoRenderer;
  if (!card) return;
  const videoId = card.contentId ?? card.videoId;
  if (!isVideoId(videoId)) return;
  if (card.contentType && card.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return;

  const rows = card.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows;
  const badges = [
    ...(Array.isArray(card.badges) ? card.badges : []),
    ...(Array.isArray(rows) ? rows.flatMap((row: any) => Array.isArray(row?.badges) ? row.badges : []) : []),
  ];
  const membersOnly = !!card.sponsorsOnlyBadge?.sponsorsOnlyBadgeRenderer || badges.some((badge: any) =>
    badge?.badgeViewModel?.badgeStyle === 'BADGE_MEMBERS_ONLY' ||
    badge?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_MEMBERS_ONLY'
  );
  // Search only uploader metadata, not menus (which may mention other channels).
  const metadata = card.metadata?.lockupMetadataViewModel;
  const ownership = [card.longBylineText, card.shortBylineText, card.ownerText,
    card.channelThumbnailSupportedRenderers, metadata?.image, metadata?.metadata];
  const findOwner = (value: any, depth = 0): string | undefined => {
    if (!value || typeof value !== 'object' || depth > 16) return;
    if (isChannelId(value.browseEndpoint?.browseId)) return value.browseEndpoint.browseId;
    for (const child of Object.values(value)) {
      const found = findOwner(child, depth + 1);
      if (found) return found;
    }
  };
  const channelId = findOwner(ownership) || (isChannelId(channelGridOwner) ? channelGridOwner : undefined);
  return { videoId, membersOnly, ...(channelId ? { channelId } : {}) };
}

const VIDEO_CARDS = ':is(ytd-rich-item-renderer, ytd-rich-grid-media, yt-lockup-view-model, ' +
  'ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer)';

// CSS handles lazy insertion and recycled cards without another DOM observer or
// recurring scan. Hide the complete card, including its grid slot, not the shelf.
export function membersOnlyCss(videos: Iterable<MemberVideoState>, exceptionChannelIds: Iterable<string> = []): string {
  const exceptions = new Set<string>([...exceptionChannelIds].filter(isChannelId));
  const hidden: string[] = [];
  const allowed: string[] = [];
  for (const video of videos) {
    if (!video.membersOnly || !isVideoId(video.videoId)) continue;
    (video.channelId && exceptions.has(video.channelId) ? allowed : hidden).push(video.videoId);
  }
  const links = (ids: string[]) => ids.map((id) =>
    `a[href*="/watch?"]:is([href$="?v=${id}"], [href*="?v=${id}&"], ` +
    `[href$="&v=${id}"], [href*="&v=${id}&"])`
  );
  const targets = ['.badge-style-type-members-only', 'ytd-sponsors-only-badge-renderer', ...links(hidden)];
  const exempt = allowed.length ? `:not(:has(:is(${links(allowed).join(',')})))` : '';
  return `html.syf-hide-members-only ${VIDEO_CARDS}:has(:is(${targets.join(',')}))${exempt} { display: none !important; }`;
}
