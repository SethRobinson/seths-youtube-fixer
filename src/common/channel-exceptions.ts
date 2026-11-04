export interface MemberChannelException {
  channelId: string;
  name: string;
}

export function isChannelId(value: unknown): value is `UC${string}` {
  return typeof value === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(value);
}

// Resolve only public YouTube channel pages. Never fetch an arbitrary pasted URL.
export function channelInputUrl(input: string): string {
  const value = input.trim();
  let path: string;
  if (isChannelId(value)) path = `/channel/${value}`;
  else if (value.startsWith('@')) path = `/${value}`;
  else {
    let url: URL;
    try { url = new URL(/^[\w+.-]+:\/\//.test(value) ? value : `https://${value}`); }
    catch { throw new Error('Enter an @handle or a YouTube channel URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      throw new Error('Enter an @handle or a YouTube channel URL.');
    }
    path = url.pathname;
  }
  let parts: string[];
  try { parts = path.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error('That channel URL is invalid.'); }
  const suffixes = ['videos', 'shorts', 'streams', 'featured', 'about', 'membership', 'playlists', 'community', 'posts'];
  let base: string;
  let length: number;
  if (/^@[^/?#\s\\]+$/u.test(parts[0] || '')) {
    base = `/${encodeURIComponent(parts[0]).replace('%40', '@')}`;
    length = 1;
  } else if (parts[0] === 'channel' && isChannelId(parts[1])) {
    base = `/channel/${parts[1]}`;
    length = 2;
  } else if (['c', 'user'].includes(parts[0]) && /^[^/?#\s\\]+$/u.test(parts[1] || '')) {
    base = `/${parts[0]}/${encodeURIComponent(parts[1])}`;
    length = 2;
  } else throw new Error('Use a channel URL or @handle, rather than a video or playlist URL.');
  if (parts.length > length && (parts.length !== length + 1 || !suffixes.includes(parts[length]))) {
    throw new Error('Enter an @handle or a YouTube channel URL.');
  }
  return `https://www.youtube.com${base}/about?hl=en`;
}

export function channelFromHtml(html: string): MemberChannelException {
  const match = html.match(/(?:var ytInitialData\s*=|window\["ytInitialData"\]\s*=)\s*(\{.+?\});\s*<\/script>/s);
  let metadata: any;
  try { metadata = match && JSON.parse(match[1])?.metadata?.channelMetadataRenderer; }
  catch { /* Report a friendly error below. */ }
  if (!isChannelId(metadata?.externalId) || typeof metadata?.title !== 'string' || !metadata.title.trim()) {
    throw new Error('Couldn’t find that channel. Check the handle or channel URL and try again.');
  }
  return { channelId: metadata.externalId, name: metadata.title.trim().slice(0, 200) };
}

export async function resolveMemberChannel(input: string): Promise<MemberChannelException> {
  const url = channelInputUrl(input);
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  } catch { throw new Error('Couldn’t reach YouTube. Check your connection and try again.'); }
  if (!response.ok) throw new Error('Couldn’t find that channel. Check the handle or channel URL and try again.');
  return channelFromHtml(await response.text());
}
