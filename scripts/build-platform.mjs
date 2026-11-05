export function extensionManifest(base, safari) {
  const manifest = structuredClone(base);
  for (const script of manifest.content_scripts) {
    if (script.matches.includes('https://www.youtube.com/*')) script.matches.push('https://m.youtube.com/*');
  }
  if (safari) {
    manifest.permissions = manifest.permissions.filter((permission) => permission !== 'declarativeNetRequest');
    delete manifest.declarative_net_request;
    manifest.content_scripts = manifest.content_scripts.filter((script) => !script.js.includes('content/embed.js'));
    // Settings open in their own tab; no framed extension pages or watch pages.
    delete manifest.web_accessible_resources;
    delete manifest.options_ui.open_in_tab;
    manifest.content_security_policy.extension_pages = "script-src 'self'; object-src 'self'; frame-ancestors 'none'";
  } else {
    manifest.web_accessible_resources[0].matches.push('https://m.youtube.com/*');
    manifest.content_security_policy.extension_pages += ' https://m.youtube.com';
  }
  return manifest;
}
