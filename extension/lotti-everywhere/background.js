// Opens Lotti (the portal's compact "mini" page) in a small popup window next to whatever tab you are on, and re-uses that window on later clicks.
// The page is the normal Lofty Support Portal, so you sign in there once (like any website) and everything Lotti knows works the same.
const PORTAL_MINI_URL = 'https://loftysupportportal.com/?lotti=mini';
const WIDTH = 440, HEIGHT = 740;

async function openLotti() {
  try {
    const { lottiWindowId } = await chrome.storage.session.get('lottiWindowId');
    if (lottiWindowId != null) {
      try { await chrome.windows.update(lottiWindowId, { focused: true, drawAttention: true }); return; }
      catch (_) { /* the window was closed - open a new one */ }
    }
    const current = await chrome.windows.getCurrent().catch(() => null);
    const left = current && current.left != null ? Math.max(0, current.left + current.width - WIDTH - 24) : undefined;
    const top = current && current.top != null ? current.top + 60 : undefined;
    const win = await chrome.windows.create({ url: PORTAL_MINI_URL, type: 'popup', width: WIDTH, height: HEIGHT, left, top, focused: true });
    await chrome.storage.session.set({ lottiWindowId: win.id });
  } catch (error) {
    // Last resort: a normal tab.
    chrome.tabs.create({ url: PORTAL_MINI_URL });
  }
}

chrome.runtime.onMessage.addListener((message) => { if (message && message.type === 'open-lotti') openLotti(); });
chrome.action.onClicked.addListener(openLotti);
chrome.commands.onCommand.addListener(command => { if (command === 'open-lotti') openLotti(); });
chrome.windows.onRemoved.addListener(async id => {
  const { lottiWindowId } = await chrome.storage.session.get('lottiWindowId');
  if (lottiWindowId === id) await chrome.storage.session.remove('lottiWindowId');
});
