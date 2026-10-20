// Opens Lotti (the portal's compact "mini" page) in the browser side panel so it stays with you across tabs (popup window as a fallback).
// The page is the normal Lofty Support Portal, so you sign in there once (like any website) and everything Lotti knows works the same.
const PORTAL_MINI_URL = 'https://loftysupportportal.com/?lotti=mini';
// The robot (art, animation CSS, tips, move timings) lives on the portal as a small public JSON file. This worker keeps a copy in chrome.storage and the content
// script on every tab swaps it in live, so updating the robot is just a portal deploy - nobody reinstalls the extension. (Only changes to this extension's own
// code or manifest need a new download; the portal tells people when that is the case.)
const ROBOT_URL = 'https://loftysupportportal.com/shared/lotti-robot.json';
const CHECK_EVERY_MS = 60 * 60 * 1000;

async function refreshRobot(force) {
  try {
    const { lottiRobotCheckedAt = 0, lottiRobot } = await chrome.storage.local.get(['lottiRobotCheckedAt', 'lottiRobot']);
    if (!force && lottiRobot && Date.now() - lottiRobotCheckedAt < CHECK_EVERY_MS) return;
    const res = await fetch(`${ROBOT_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const next = await res.json();
    if (!next || typeof next.svg !== 'string' || typeof next.css !== 'string') return;
    const changed = !lottiRobot || lottiRobot.version !== next.version;
    await chrome.storage.local.set(changed ? { lottiRobot: next, lottiRobotCheckedAt: Date.now() } : { lottiRobotCheckedAt: Date.now() });
  } catch (_) { /* offline or off the network: keep the copy we have */ }
}
chrome.runtime.onInstalled.addListener(() => { refreshRobot(true); chrome.alarms.create('lotti-robot', { periodInMinutes: 360 }); });
chrome.runtime.onStartup.addListener(() => { refreshRobot(false); chrome.alarms.create('lotti-robot', { periodInMinutes: 360 }); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'lotti-robot') refreshRobot(true); });

const WIDTH = 440, HEIGHT = 740;

// Lotti opens in Chrome's side panel, which stays open as you switch tabs (so the chat follows you). If the side panel is not available (older browser) or
// cannot open, she falls back to a small popup window that is re-used on later clicks.
async function openPopup() {
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

// sidePanel.open must run straight from the click / key press, so it is called before anything is awaited.
function openLotti(windowId) {
  if (!chrome.sidePanel || !chrome.sidePanel.open) return openPopup();
  const go = id => chrome.sidePanel.open({ windowId: id }).catch(() => openPopup());
  if (windowId != null) return go(windowId);
  return chrome.windows.getCurrent().then(w => go(w.id), () => openPopup());
}
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) { /* no side panel: the toolbar click falls through to openLotti below */ }

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;
  if (message.type === 'open-lotti') openLotti(sender && sender.tab ? sender.tab.windowId : undefined);
  if (message.type === 'robot-check') refreshRobot(false);
});
chrome.action.onClicked.addListener(tab => openLotti(tab && tab.windowId));
chrome.commands.onCommand.addListener((command, tab) => { if (command === 'open-lotti') openLotti(tab && tab.windowId); });
chrome.windows.onRemoved.addListener(async id => {
  const { lottiWindowId } = await chrome.storage.session.get('lottiWindowId');
  if (lottiWindowId === id) await chrome.storage.session.remove('lottiWindowId');
});
