const statusEl = document.getElementById('status') as HTMLDivElement;
const openOptions = document.getElementById('open-options') as HTMLAnchorElement;

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  const url = tab?.url ?? '';
  const m = url.match(/[?&]v=([\w-]{11})/);
  statusEl.textContent = m ? `Watching video: ${m[1]}` : 'Not on a YouTube watch page.';
});

openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
