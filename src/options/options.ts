import { SETTINGS_KEY, DEFAULT_SETTINGS, type SyfSettings } from '../common/messages';

const input = document.getElementById('apiKey') as HTMLInputElement;
const savedMsg = document.getElementById('savedMsg') as HTMLSpanElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;

async function load(): Promise<SyfSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

async function init() {
  const settings = await load();
  input.value = settings.apiKey ?? '';
}

saveBtn.addEventListener('click', async () => {
  const current = await load();
  const next: SyfSettings = { ...current, apiKey: input.value.trim() };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  savedMsg.textContent = 'Saved';
  setTimeout(() => (savedMsg.textContent = ''), 1500);
});

init();
