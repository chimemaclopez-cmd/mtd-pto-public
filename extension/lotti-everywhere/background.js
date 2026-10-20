// Opens Lotti (the portal's compact "mini" page, which shows the same chat panel as the floating Lotti) in a small window beside the robot, and re-uses that window on later clicks.
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

// Outer size of the window: the portal's floating chat panel (370 x 520) plus the window's own title bar and border.
const WIDTH = 392, HEIGHT = 580;

// Lotti opens in a small window shaped like the portal's floating chat, placed right next to the robot (above her, or below if she is near the top,
// on the side of the robot that has room). The content script works out the spot from the robot's position on screen and sends it as "anchor".
// Later clicks re-use the same window and move it back beside the robot.
async function openLotti(anchor) {
  try {
    const { lottiWindowId } = await chrome.storage.session.get('lottiWindowId');
    const spot = anchor && Number.isFinite(anchor.left) ? { left: Math.round(anchor.left), top: Math.round(anchor.top) } : {};
    if (lottiWindowId != null) {
      try { await chrome.windows.update(lottiWindowId, { focused: true, drawAttention: true, ...spot }); return; }
      catch (_) { /* the window was closed - open a new one */ }
    }
    if (spot.left == null) {
      const current = await chrome.windows.getCurrent().catch(() => null);
      if (current && current.left != null) { spot.left = Math.max(0, current.left + current.width - WIDTH - 24); spot.top = current.top + 60; }
    }
    const win = await chrome.windows.create({ url: PORTAL_MINI_URL, type: 'popup', width: WIDTH, height: HEIGHT, ...spot, focused: true });
    await chrome.storage.session.set({ lottiWindowId: win.id });
  } catch (error) {
    // Last resort: a normal tab.
    chrome.tabs.create({ url: PORTAL_MINI_URL });
  }
}

// Toolbar button and Alt+L carry no robot position, so ask the tab's robot where she is.
async function openFromTab(tab) {
  let anchor = null;
  try { if (tab && tab.id != null) anchor = await chrome.tabs.sendMessage(tab.id, { type: 'lotti-anchor' }); } catch (_) { /* no robot on this page */ }
  openLotti(anchor);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'open-lotti') openLotti(message.anchor);
  if (message.type === 'robot-check') refreshRobot(false);
});
chrome.action.onClicked.addListener(tab => openFromTab(tab));
chrome.commands.onCommand.addListener((command, tab) => { if (command === 'open-lotti') openFromTab(tab); });
chrome.windows.onRemoved.addListener(async id => {
  const { lottiWindowId } = await chrome.storage.session.get('lottiWindowId');
  if (lottiWindowId === id) await chrome.storage.session.remove('lottiWindowId');
});
