// Lotti on your work tabs: a small draggable robot in the corner. Click it (or press Alt+L) and Lotti opens in a small window next to this tab.
// It only draws the robot - it never reads or changes the page you are on.
(() => {
  if (document.getElementById('lotti-everywhere-host')) return;
  if (window.top !== window) return;
  const HOST = location.hostname;
  const ROBOT = `<svg viewBox="0 0 80 112" overflow="visible" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="lbBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4ee0a6"/><stop offset="1" stop-color="#0f9a62"/></linearGradient><linearGradient id="lbLimb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fd098"/><stop offset="1" stop-color="#1c9a68"/></linearGradient></defs><ellipse cx="40" cy="108" rx="25" ry="3.6" fill="#1b2a4a" opacity=".18"/><g stroke="#0b6b43" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><g class="lbLeg"><rect x="26" y="80" width="9" height="19" rx="4.5" fill="url(#lbLimb)"/><ellipse cx="29" cy="102" rx="9.5" ry="5" fill="#0f7a49"/></g><g class="lbLeg lbLegR"><rect x="45" y="80" width="9" height="19" rx="4.5" fill="url(#lbLimb)"/><ellipse cx="51" cy="102" rx="9.5" ry="5" fill="#0f7a49"/></g><g class="lbArm"><rect x="9" y="61" width="9" height="23" rx="4.5" fill="url(#lbLimb)"/><circle cx="13.5" cy="87" r="5.2" fill="#ffd166"/></g><g class="lbWave"><rect x="62" y="61" width="9" height="23" rx="4.5" fill="url(#lbLimb)"/><circle cx="66.5" cy="87" r="5.2" fill="#ffd166"/></g></g><rect x="21" y="58" width="38" height="32" rx="13" fill="url(#lbBody)" stroke="#0b6b43" stroke-width="2.4"/><g class="lbTag"><rect x="25" y="65" width="30" height="20" rx="3.5" fill="#fff" stroke="#0b6b43" stroke-width="1.3"/><path d="M25 68.5a3.5 3.5 0 0 1 3.5-3.5h23a3.5 3.5 0 0 1 3.5 3.5V72H25z" fill="#ff5a5f"/><text x="40" y="70.6" font-size="4.3" font-weight="800" fill="#fff" text-anchor="middle" font-family="system-ui,-apple-system,Arial,sans-serif">HELLO, I'M</text><text x="40" y="81.6" font-size="8.8" font-weight="900" fill="#0b6b43" text-anchor="middle" font-family="system-ui,-apple-system,Arial,sans-serif">LOTTI</text></g><g class="lbHead"><g class="lbAnt"><line x1="40" y1="17" x2="40" y2="8" stroke="#0b6b43" stroke-width="3" stroke-linecap="round"/><circle cx="40" cy="6" r="4.6" fill="#ffd166" stroke="#0b6b43" stroke-width="1.5"/></g><rect x="3" y="33" width="7" height="16" rx="3.5" fill="#0b6b43"/><rect x="70" y="33" width="7" height="16" rx="3.5" fill="#0b6b43"/><rect x="9" y="15" width="62" height="50" rx="19" fill="url(#lbBody)" stroke="#0b6b43" stroke-width="2.5"/><rect x="16" y="25" width="48" height="26" rx="13" fill="#10243d"/><g class="lbEyes"><ellipse cx="30" cy="37" rx="5" ry="6" fill="#7dffd0" class="lbEye"/><ellipse cx="50" cy="37" rx="5" ry="6" fill="#7dffd0" class="lbEye"/><path d="M33 45 q7 6 14 0" stroke="#7dffd0" stroke-width="2.4" fill="none" stroke-linecap="round"/></g><ellipse cx="21" cy="56" rx="4" ry="2.6" fill="#ff9aa8" opacity=".6"/><ellipse cx="59" cy="56" rx="4" ry="2.6" fill="#ff9aa8" opacity=".6"/><path d="M23 21 q8 -5 18 -4" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity=".45"/></g></svg>`;
  const store = chrome.storage.local;

  const host = document.createElement('div');
  host.id = 'lotti-everywhere-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:24px;bottom:24px;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial}
      .wrap{position:relative;width:64px;height:90px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
      button.bot{all:unset;display:block;width:64px;height:90px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;
        filter:drop-shadow(0 10px 14px rgba(15,122,73,.35));animation:bob 3.6s ease-in-out infinite;transition:transform .12s}
      button.bot:hover{transform:scale(1.07);animation-play-state:paused}
      button.bot:active{cursor:grabbing}
      button.bot:focus-visible{outline:3px solid #3b5cde;outline-offset:3px;border-radius:12px}
      svg{width:100%;height:100%;display:block;pointer-events:none}
      .lbEye{animation:blink 5s infinite;transform-box:fill-box;transform-origin:center}
      .lbWave{transform-box:view-box;transform-origin:66.5px 63px;animation:wave 7s ease-in-out infinite}
      button.bot:hover .lbWave{animation-duration:1.6s}
      .lbArm{transform-box:view-box;transform-origin:13.5px 63px;animation:sway 3.6s ease-in-out infinite}
      .lbLeg{transform-box:fill-box;transform-origin:50% 0;animation:step 3.6s ease-in-out infinite}.lbLegR{animation-delay:-1.8s}
      svg{animation:hop 11s ease-in-out infinite;transform-origin:50% 100%}
      .lbHead{transform-box:view-box;transform-origin:40px 62px;animation:tilt 9s ease-in-out infinite}
      .lbAnt{transform-box:view-box;transform-origin:40px 17px;animation:ant 2.8s ease-in-out infinite}
      .lbEyes{animation:look 8s ease-in-out infinite}
      .cheer svg{animation:cheer .9s ease-out 1}.cheer .lbWave{animation:wave .7s linear 2}
      .tip{position:absolute;right:72px;top:14px;background:#fff;color:#20243a;border:1px solid #dfe2ea;border-radius:12px;padding:6px 12px;font-size:12.5px;font-weight:700;
        box-shadow:0 6px 16px rgba(32,36,55,.16);white-space:nowrap;pointer-events:none;opacity:0;transform:translateX(6px);transition:opacity .15s,transform .15s}
      .wrap:hover .tip{opacity:1;transform:none}
      .bubble{position:absolute;right:74px;bottom:46px;width:210px;background:#fff;color:#20243a;border:1px solid #dfe2ea;border-radius:14px 14px 4px 14px;padding:9px 12px;font-size:12.5px;line-height:1.4;font-weight:600;box-shadow:0 8px 22px rgba(32,36,55,.2);opacity:0;pointer-events:none}
      .bubble.show{animation:pop 6s ease-in-out 1 forwards}
      .hide{all:unset;position:absolute;top:-4px;left:-6px;width:18px;height:18px;border-radius:50%;background:#444;color:#fff;font-size:11px;line-height:18px;text-align:center;cursor:pointer;opacity:0;transition:opacity .15s}
      .wrap:hover .hide{opacity:.85}.hide:hover{opacity:1}
      @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
      @keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
      @keyframes wave{0%,62%,100%{transform:rotate(0)}67%{transform:rotate(-128deg)}72%{transform:rotate(-150deg)}77%{transform:rotate(-124deg)}82%{transform:rotate(-150deg)}87%{transform:rotate(-124deg)}93%{transform:rotate(0)}}
      @keyframes sway{0%,100%{transform:rotate(2deg)}50%{transform:rotate(-3deg)}}
      @keyframes step{0%,100%{transform:rotate(1.5deg)}50%{transform:rotate(-1.5deg)}}
      @keyframes hop{0%,84%,100%{transform:translateY(0) scale(1,1)}86%{transform:translateY(0) scale(1.07,.9)}90%{transform:translateY(-16px) scale(.96,1.06)}94%{transform:translateY(0) scale(1.07,.9)}97%{transform:translateY(0) scale(1,1)}}
      @keyframes tilt{0%,100%{transform:rotate(0)}20%{transform:rotate(-4deg)}45%{transform:rotate(0)}70%{transform:rotate(4deg)}}
      @keyframes ant{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}
      @keyframes look{0%,18%,100%{transform:translateX(0)}28%,42%{transform:translateX(-3px)}55%,70%{transform:translateX(3px)}}
      @keyframes cheer{0%{transform:translateY(0) scale(1)}30%{transform:translateY(-22px) scale(.95,1.08)}60%{transform:translateY(0) scale(1.08,.9)}100%{transform:translateY(0) scale(1)}}
      @keyframes pop{0%{opacity:0;transform:translateY(6px) scale(.96)}12%,88%{opacity:1;transform:none}100%{opacity:0;transform:translateY(6px) scale(.96)}}
      @media (prefers-reduced-motion:reduce){*{animation:none!important}}
      @media print{:host{display:none}}
    </style>
    <div class="wrap">
      <button class="bot" type="button" aria-label="Ask Lotti (Alt+L)">${ROBOT}</button>
      <div class="tip">Ask Lotti · Alt+L · drag me</div>
      <div class="bubble" role="status"></div>
      <button class="hide" type="button" title="Hide Lotti on ${HOST}" aria-label="Hide Lotti on this site">×</button>
    </div>`;
  const bot = root.querySelector('.bot');
  const wrapEl = root.querySelector('.wrap');
  const bubble = root.querySelector('.bubble');
  function cheer() { wrapEl.classList.remove('cheer'); void wrapEl.offsetWidth; wrapEl.classList.add('cheer'); setTimeout(() => wrapEl.classList.remove('cheer'), 1000); }
  // A short tip now and then (never more than a few per page, only while this tab is in view) so she feels alive without nagging.
  const TIPS = [
    'Need a hand with a cancellation or refund? Ask me.',
    'Not sure which SOP applies? I check the announcements too.',
    'Paste a screenshot and I will read it for you.',
    'Ask me about PTO, attendance or other HR policy.',
    'Looking for how a ticket was handled before? I can find it.'
  ];
  let tipCount = 0;
  function showTip() {
    if (document.hidden || tipCount >= 4 || bubble.classList.contains('show')) return;
    bubble.textContent = TIPS[Math.floor(Math.random() * TIPS.length)]; tipCount += 1;
    bubble.classList.remove('show'); void bubble.offsetWidth; bubble.classList.add('show');
    cheer();
  }
  setTimeout(() => { showTip(); setInterval(showTip, 90000); }, 25000);
  const hideBtn = root.querySelector('.hide');

  // Position: remembered across sites and visits.
  function place(left, top) {
    const w = 64, h = 90;
    left = Math.min(Math.max(left, 4), innerWidth - w - 4);
    top = Math.min(Math.max(top, 4), innerHeight - h - 4);
    host.style.left = left + 'px'; host.style.top = top + 'px'; host.style.right = 'auto'; host.style.bottom = 'auto';
    return { left, top };
  }
  let drag = null, moved = false;
  bot.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, left: host.getBoundingClientRect().left, top: host.getBoundingClientRect().top };
    moved = false; bot.setPointerCapture(e.pointerId);
  });
  bot.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true; place(drag.left + dx, drag.top + dy);
  });
  bot.addEventListener('pointerup', e => {
    if (!drag) return;
    bot.releasePointerCapture(e.pointerId);
    if (moved) { const r = host.getBoundingClientRect(); store.set({ lottiPos: { left: r.left, top: r.top, vw: innerWidth, vh: innerHeight } }); }
    else { cheer(); chrome.runtime.sendMessage({ type: 'open-lotti' }); }
    drag = null;
  });
  bot.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cheer(); chrome.runtime.sendMessage({ type: 'open-lotti' }); } });
  hideBtn.addEventListener('click', async () => {
    const { lottiHiddenHosts = [] } = await store.get('lottiHiddenHosts');
    if (!lottiHiddenHosts.includes(HOST)) lottiHiddenHosts.push(HOST);
    await store.set({ lottiHiddenHosts });
    host.remove();
  });
  addEventListener('resize', () => { const r = host.getBoundingClientRect(); if (host.style.left) place(r.left, r.top); });

  store.get(['lottiHiddenHosts', 'lottiPos']).then(({ lottiHiddenHosts = [], lottiPos }) => {
    if (lottiHiddenHosts.includes(HOST)) return;
    document.documentElement.appendChild(host);
    if (lottiPos) place(lottiPos.left * (innerWidth / (lottiPos.vw || innerWidth)), lottiPos.top * (innerHeight / (lottiPos.vh || innerHeight)));
  }).catch(() => document.documentElement.appendChild(host));
})();
