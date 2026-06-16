import { SETTINGS_KEY, DEFAULT_SETTINGS, type SyfSettings } from '../common/messages';

const input = document.getElementById('apiKey') as HTMLInputElement;
const ttlInput = document.getElementById('ttlDays') as HTMLInputElement;
const savedMsg = document.getElementById('savedMsg') as HTMLSpanElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;

async function load(): Promise<SyfSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

async function init() {
  const settings = await load();
  input.value = settings.apiKey ?? '';
  ttlInput.value = String(settings.feedbackTtlDays ?? 7);
}

saveBtn.addEventListener('click', async () => {
  const current = await load();
  const ttl = parseFloat(ttlInput.value);
  const next: SyfSettings = {
    ...current,
    apiKey: input.value.trim(),
    feedbackTtlDays: Number.isFinite(ttl) && ttl > 0 ? ttl : 7,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  savedMsg.textContent = 'Saved';
  setTimeout(() => (savedMsg.textContent = ''), 1500);
});

init();
