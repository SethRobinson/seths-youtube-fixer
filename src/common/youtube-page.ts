// Page-layout adapters work independently of the browser and requested hostname.
// Safari's Request Desktop Website can serve desktop YouTube on an iPhone.
export const HOME_CHIP_SELECTOR =
  'ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer, ' +
  'ytm-browse ytm-chip-cloud-chip-renderer, ytm-feed-filter-chip-bar-renderer ytm-chip-cloud-chip-renderer';

export const MOBILE_VIDEO_CARDS =
  'ytm-rich-item-renderer, ytm-video-with-context-renderer, ytm-compact-video-renderer, ' +
  'ytm-video-renderer, ytm-grid-video-renderer, ytm-playlist-video-renderer';

export function isMobileYouTube(): boolean {
  return !!document.querySelector('ytm-app');
}

export function watchMount(): HTMLElement | null {
  const selectors = isMobileYouTube()
    ? ['ytm-slim-video-metadata-section-renderer', 'ytm-slim-video-metadata-renderer', 'ytm-slim-video-information-renderer', '.watch-below-the-player']
    : ['ytd-watch-metadata', '#above-the-fold', '#primary-inner'];
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
  }
  return null;
}

export function isYouTubeDataRequest(input: string, base: string): boolean {
  try {
    const url = new URL(input, base);
    if (url.protocol !== 'https:' || !['www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return false;
    return /^\/youtubei\/v1\/(browse|next|search|guide|player)$/.test(url.pathname) ||
      (url.searchParams.get('pbj') === '1' && /^\/(?:watch|results|feed(?:\/|$)|channel\/|@|$)/.test(url.pathname));
  } catch { return false; }
}

export function parseYouTubeResponse(text: string): any {
  return JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
}

export function playerHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#movie_player, #player-container-inner, #player, .player-container');
}

// Only use the boot payload on the route it belongs to. Mobile SPA responses
// are also observed by the bridge; never treat old ytInitialData as fresh data.
export function pageRoots(initialRoute: string): any[] {
  const mobile = isMobileYouTube();
  const path = location.pathname;
  const selectors = mobile
    ? (path === '/watch' ? ['ytm-watch', 'ytm-app'] : ['ytm-browse', 'ytm-search', 'ytm-app'])
    : [path === '/watch' ? 'ytd-watch-flexy' : path === '/results' ? 'ytd-search' : 'ytd-browse'];
  const roots: any[] = [];
  const seen = new Set<any>();
  const add = (element: any) => {
    const data = element?.data;
    if (data && typeof data === 'object' && !seen.has(data)) { seen.add(data); roots.push(data); }
  };
  for (const selector of selectors) add(document.querySelector(selector));
  if (mobile && !roots.length) {
    for (const card of Array.from(document.querySelectorAll(MOBILE_VIDEO_CARDS)).slice(0, 500)) add(card);
  }
  if (!roots.length && (!mobile || location.pathname + location.search === initialRoute)) {
    const initial = (window as any).ytInitialData;
    if (initial) roots.push(initial);
  }
  return roots;
}
