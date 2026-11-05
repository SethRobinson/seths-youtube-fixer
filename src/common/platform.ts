// Build-time platform selection: no user-agent sniffing and no API polyfill.
declare const __SYF_SAFARI__: boolean;
export const IS_SAFARI = typeof __SYF_SAFARI__ !== 'undefined' && __SYF_SAFARI__;
export const COMMENT_TABS = IS_SAFARI;

export async function openCommentSearch(url: string): Promise<void> {
  if (COMMENT_TABS || !chrome.windows?.create) {
    await chrome.tabs.create({ url });
  } else {
    await chrome.windows.create({ url, type: 'normal', width: 940, height: 820 });
  }
}

export function youtubeOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['www.youtube.com', 'm.youtube.com'].includes(parsed.hostname)) {
    throw new Error('Unsupported YouTube origin');
  }
  return parsed.origin;
}
