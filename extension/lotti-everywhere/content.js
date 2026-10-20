// Lotti on your work tabs: a small draggable robot in the corner. Click it (or press Alt+L) and Lotti opens in a small window next to this tab.
// It only draws the robot - it never reads or changes the page you are on.
(() => {
  if (document.getElementById('lotti-everywhere-host')) return;
  if (window.top !== window) return;
  const HOST = location.hostname;
  const ROBOT = `<svg viewBox="0 0 80 112" overflow="visible" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="lbBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4ee0a6"/><stop offset="1" stop-color="#0f9a62"/></linearGradient><linearGradient id="lbLimb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fd098"/><stop offset="1" stop-color="#1c9a68"/></linearGradient></defs><ellipse cx="40" cy="108" rx="25" ry="3.6" fill="#1b2a4a" opacity=".18"/><g stroke="#0b6b43" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><g class="lbLeg"><rect x="26" y="80" width="9" height="19" rx="4.5" fill="url(#lbLimb)"/><ellipse cx="29" cy="102" rx="9.5" ry="5" fill="#0f7a49"/></g><g class="lbLeg lbLegR"><rect x="45" y="80" width="9" height="19" rx="4.5" fill="url(#lbLimb)"/><ellipse cx="51" cy="102" rx="9.5" ry="5" fill="#0f7a49"/></g><g class="lbArm"><rect x="9" y="61" width="9" height="23" rx="4.5" fill="url(#lbLimb)"/><circle cx="13.5" cy="87" r="5.2" fill="#ffd166"/></g><g class="lbWave"><rect x="62" y="61" width="9" height="23" rx="4.5" fill="url(#lbLimb)"/><circle cx="66.5" cy="87" r="5.2" fill="#ffd166"/></g></g><rect x="21" y="58" width="38" height="32" rx="13" fill="url(#lbBody)" stroke="#0b6b43" stroke-width="2.4"/><g class="lbTag"><rect x="25" y="65" width="30" height="20" rx="3.5" fill="#fff" stroke="#0b6b43" stroke-width="1.3"/><path d="M25 68.5a3.5 3.5 0 0 1 3.5-3.5h23a3.5 3.5 0 0 1 3.5 3.5V72H25z" fill="#ff5a5f"/><text x="40" y="70.6" font-size="4.3" font-weight="800" fill="#fff" text-anchor="middle" font-family="system-ui,-apple-system,Arial,sans-serif">HELLO, I'M</text><text x="40" y="81.6" font-size="8.8" font-weight="900" fill="#0b6b43" text-anchor="middle" font-family="system-ui,-apple-system,Arial,sans-serif">LOTTI</text></g><g class="lbHead"><g class="lbAnt"><line x1="40" y1="17" x2="40" y2="8" stroke="#0b6b43" stroke-width="3" stroke-linecap="round"/><circle cx="40" cy="6" r="4.6" fill="#ffd166" stroke="#0b6b43" stroke-width="1.5"/></g><rect x="3" y="33" width="7" height="16" rx="3.5" fill="#0b6b43"/><rect x="70" y="33" width="7" height="16" rx="3.5" fill="#0b6b43"/><rect x="9" y="15" width="62" height="50" rx="19" fill="url(#lbBody)" stroke="#0b6b43" stroke-width="2.5"/><rect x="16" y="25" width="48" height="26" rx="13" fill="#10243d"/><g class="lbEyes"><ellipse cx="30" cy="37" rx="5" ry="6" fill="#7dffd0" class="lbEye"/><ellipse cx="50" cy="37" rx="5" ry="6" fill="#7dffd0" class="lbEye"/><path d="M33 45 q7 6 14 0" stroke="#7dffd0" stroke-width="2.4" fill="none" stroke-linecap="round"/></g><ellipse cx="21" cy="56" rx="4" ry="2.6" fill="#ff9aa8" opacity=".6"/><ellipse cx="59" cy="56" rx="4" ry="2.6" fill="#ff9aa8" opacity=".6"/><path d="M23 21 q8 -5 18 -4" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity=".45"/></g></svg>`;
  const store = chrome.storage.local;
  // The robot (artwork, animation CSS, tips and move timings) is data, not code: the background worker keeps a copy fetched from the portal fresh, so changing the
  // robot never needs a reinstall. What is built in below is only the fallback used before the first download or when the portal cannot be reached.
  const DEFAULT_ANIM_CSS = String.raw`/*ROBOT-ANIM-START*/
.wrap svg{overflow:visible;transform-origin:50% 50%}
.wrap .lbEye{animation:rbBlink 5s infinite;transform-box:fill-box;transform-origin:center}
.wrap .lbArm{transform-box:view-box;transform-origin:13.5px 63px;animation:rbSway 3.6s ease-in-out infinite}
.wrap .lbWave{transform-box:view-box;transform-origin:66.5px 63px;animation:rbSwayR 3.6s ease-in-out infinite;animation-delay:-1.2s}
.wrap .lbLeg{transform-box:fill-box;transform-origin:50% 0;animation:rbStep 3.6s ease-in-out infinite}.wrap .lbLegR{animation-delay:-1.8s}
.wrap .lbHead{transform-box:view-box;transform-origin:40px 62px;animation:rbTilt 9s ease-in-out infinite}
.wrap .lbAnt{transform-box:view-box;transform-origin:40px 17px;animation:rbAnt 2.8s ease-in-out infinite}
.wrap .lbEyes{animation:rbLook 8s ease-in-out infinite}
.wrap.track .lbEyes{animation:none;transform:translate(var(--ex,0px),var(--ey,0px))}
.wrap.track .lbHead{animation:none;transform:rotate(var(--hr,0deg))}
.wrap:hover .lbWave{animation:rbWave 1.6s ease-in-out infinite}
.wrap.act-wave .lbWave{animation:rbWave 2.8s ease-in-out 1}
.wrap.act-dance svg{animation:rbRock .7s ease-in-out 4}
.wrap.act-dance .lbWave{animation:rbUpR .35s ease-in-out 8}.wrap.act-dance .lbArm{animation:rbUpL .35s ease-in-out 8}
.wrap.act-dance .lbLeg{animation:rbStomp .35s ease-in-out 8}.wrap.act-dance .lbHead{animation:rbHeadBop .35s ease-in-out 8}
.wrap.act-clap .lbArm{animation:rbClapL .28s ease-in-out 7}.wrap.act-clap .lbWave{animation:rbClapR .28s ease-in-out 7}
.wrap.act-nod .lbHead{animation:rbNod .5s ease-in-out 3}
.wrap.act-spin svg{animation:rbSpin 1.2s ease-in-out 1}
.wrap.act-stretch svg{animation:rbStretch 3.2s ease-in-out 1}
.wrap.act-stretch .lbArm{animation:rbStretchL 3.2s ease-in-out 1}.wrap.act-stretch .lbWave{animation:rbStretchR 3.2s ease-in-out 1}
.wrap.act-stretch .lbEyes{animation:rbSquint 3.2s ease-in-out 1;transform-box:fill-box;transform-origin:center}
.wrap.act-hop svg{animation:rbHop 1.1s ease-in-out 1}
.wrap.act-lie svg{animation:rbLie 4.4s ease-in-out 1}.wrap.act-lie .lbEyes{animation:rbNapEyes 4.4s ease-in-out 1;transform-box:fill-box;transform-origin:center}
.wrap.act-lie .lbArm{animation:rbLieArm 4.4s ease-in-out 1}.wrap.act-lie .lbWave{animation:rbLieArmR 4.4s ease-in-out 1}.wrap.act-lie .lbHead{animation:rbNapHead 4.4s ease-in-out 1}
.wrap.act-jack svg{animation:rbJackHop .5s ease-in-out 6}
.wrap.act-jack .lbArm{animation:rbJackArmL .5s ease-in-out 6}.wrap.act-jack .lbWave{animation:rbJackArmR .5s ease-in-out 6}
.wrap.act-jack .lbLeg{animation:rbJackLegL .5s ease-in-out 6}.wrap.act-jack .lbLegR{animation:rbJackLegR .5s ease-in-out 6}
.wrap.act-tumble svg{animation:rbTumble 1.5s ease-in-out 1}.wrap.act-tumble .lbArm{animation:rbTuck .75s ease-in-out 2}.wrap.act-tumble .lbWave{animation:rbTuckR .75s ease-in-out 2}
.wrap.cheer svg{animation:rbCheer .9s ease-out 1}.wrap.cheer .lbWave{animation:rbWave .7s linear 2}
.wrap.thinking .lbEyes{animation:rbThink 1.8s ease-in-out infinite}.wrap.thinking .lbHead{animation:rbTilt 2.2s ease-in-out infinite}.wrap.thinking .lbAnt{animation:rbAnt .5s ease-in-out infinite}
.wrap.sleepy .lbEyes{animation:none;transform:scaleY(.15);transform-box:fill-box;transform-origin:center}.wrap.sleepy .lbHead{animation:rbDroop 4s ease-in-out infinite}
.wrap.dropping{animation:rbDrop 1.9s linear 1 both}
.wrap.dropping svg{animation:rbLand 1.9s linear 1}
.wrap.dropping .lbArm{animation:rbFlailL .28s ease-in-out 3}.wrap.dropping .lbWave{animation:rbFlailR .28s ease-in-out 3}
.wrap.dropping .lbLeg{animation:rbKick .24s ease-in-out 4}
.wrap.dropping .lbEyes{animation:rbWide 1.9s linear 1;transform-box:fill-box;transform-origin:center}
.wrap.walking svg{animation:rbWalkBob .36s ease-in-out infinite}
.wrap.walking .lbLeg{animation:rbWalkL .36s ease-in-out infinite}.wrap.walking .lbLegR{animation-delay:-.18s}
.wrap.walking .lbArm{animation:rbArmSwing .36s ease-in-out infinite}.wrap.walking .lbWave{animation:rbArmSwingR .36s ease-in-out infinite;animation-delay:0s}
.wrap.walking .lbHead{animation:none;transform:rotate(var(--lean,0deg))}
.wrap.walking .lbEyes{animation:none;transform:translateX(calc(var(--lean,0deg) * .5))}
.wrap.held .lbArm{animation:none;transform:rotate(155deg)}.wrap.held .lbWave{animation:none;transform:rotate(-155deg)}.wrap.held .lbLeg{animation:rbDangle .5s ease-in-out infinite}
@keyframes rbBlink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
@keyframes rbSway{0%,100%{transform:rotate(2deg)}50%{transform:rotate(-3deg)}}
@keyframes rbSwayR{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(3deg)}}
@keyframes rbStep{0%,100%{transform:rotate(1.5deg)}50%{transform:rotate(-1.5deg)}}
@keyframes rbTilt{0%,100%{transform:rotate(0)}20%{transform:rotate(-4deg)}45%{transform:rotate(0)}70%{transform:rotate(4deg)}}
@keyframes rbAnt{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}
@keyframes rbLook{0%,18%,100%{transform:translateX(0)}28%,42%{transform:translateX(-3px)}55%,70%{transform:translateX(3px)}}
@keyframes rbWave{0%,100%{transform:rotate(0)}15%{transform:rotate(-128deg)}30%{transform:rotate(-150deg)}45%{transform:rotate(-124deg)}60%{transform:rotate(-150deg)}75%{transform:rotate(-124deg)}}
@keyframes rbRock{0%,100%{transform:rotate(0) translateX(0)}25%{transform:rotate(-7deg) translateX(-3px)}75%{transform:rotate(7deg) translateX(3px)}}
@keyframes rbUpR{0%,100%{transform:rotate(-140deg)}50%{transform:rotate(-168deg)}}
@keyframes rbUpL{0%,100%{transform:rotate(140deg)}50%{transform:rotate(168deg)}}
@keyframes rbStomp{0%,100%{transform:rotate(0)}50%{transform:rotate(9deg)}}
@keyframes rbHeadBop{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(2px) rotate(4deg)}}
@keyframes rbClapL{0%,100%{transform:rotate(2deg)}50%{transform:rotate(-55deg)}}
@keyframes rbClapR{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(55deg)}}
@keyframes rbNod{0%,100%{transform:translateY(0)}50%{transform:translateY(3px)}}
@keyframes rbSpin{0%,100%{transform:scaleX(1)}25%,75%{transform:scaleX(.05)}50%{transform:scaleX(-1)}}
@keyframes rbStretch{0%,100%{transform:scale(1,1)}25%,70%{transform:scale(.97,1.08)}}
@keyframes rbStretchL{0%,100%{transform:rotate(2deg)}25%,70%{transform:rotate(160deg)}}
@keyframes rbStretchR{0%,100%{transform:rotate(-2deg)}25%,70%{transform:rotate(-160deg)}}
@keyframes rbSquint{0%,100%{transform:scaleY(1)}30%,65%{transform:scaleY(.25)}}
@keyframes rbHop{0%,100%{transform:translateY(0) scale(1,1)}20%{transform:translateY(0) scale(1.07,.9)}45%{transform:translateY(-18px) scale(.96,1.06)}70%{transform:translateY(0) scale(1.07,.9)}}
@keyframes rbCheer{0%{transform:translateY(0) scale(1)}30%{transform:translateY(-22px) scale(.95,1.08)}60%{transform:translateY(0) scale(1.08,.9)}100%{transform:translateY(0) scale(1)}}
@keyframes rbThink{0%,100%{transform:translate(0,-2px)}50%{transform:translate(3px,-2px)}}
@keyframes rbDroop{0%,100%{transform:rotate(6deg) translateY(1px)}50%{transform:rotate(9deg) translateY(2px)}}
@keyframes rbDrop{0%{transform:translateY(var(--dropFrom,-400px));animation-timing-function:cubic-bezier(.55,0,1,.45)}44%{transform:translateY(0);animation-timing-function:cubic-bezier(0,.55,.45,1)}62%{transform:translateY(-26px);animation-timing-function:cubic-bezier(.55,0,1,.45)}78%{transform:translateY(0);animation-timing-function:cubic-bezier(0,.55,.45,1)}88%{transform:translateY(-9px);animation-timing-function:cubic-bezier(.55,0,1,.45)}100%{transform:translateY(0)}}
@keyframes rbLand{0%,43%{transform:scale(.92,1.12)}46%{transform:scale(1.2,.76)}54%{transform:scale(.96,1.07)}62%{transform:scale(.97,1.05)}78%{transform:scale(1.12,.86)}84%{transform:scale(.98,1.03)}92%,100%{transform:scale(1,1)}}
@keyframes rbFlailL{0%,100%{transform:rotate(130deg)}50%{transform:rotate(165deg)}}
@keyframes rbFlailR{0%,100%{transform:rotate(-130deg)}50%{transform:rotate(-165deg)}}
@keyframes rbKick{0%,100%{transform:rotate(-14deg)}50%{transform:rotate(14deg)}}
@keyframes rbWide{0%,44%{transform:scale(1.25)}46%,100%{transform:scale(1)}}
@keyframes rbLie{0%,100%{transform:translateY(0) rotate(0)}14%,86%{transform:translateY(-34px) rotate(-90deg)}}
@keyframes rbNapEyes{0%,12%,90%,100%{transform:scaleY(1)}18%,84%{transform:scaleY(.12)}}
@keyframes rbLieArm{0%,100%{transform:rotate(2deg)}14%,86%{transform:rotate(12deg)}}
@keyframes rbLieArmR{0%,100%{transform:rotate(-2deg)}14%,86%{transform:rotate(-12deg)}}
@keyframes rbNapHead{0%,100%{transform:rotate(0)}25%,75%{transform:rotate(-5deg)}50%{transform:rotate(-3deg)}}
@keyframes rbJackHop{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
@keyframes rbJackArmL{0%,100%{transform:rotate(2deg)}50%{transform:rotate(165deg)}}
@keyframes rbJackArmR{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(-165deg)}}
@keyframes rbJackLegL{0%,100%{transform:rotate(1.5deg)}50%{transform:rotate(26deg)}}
@keyframes rbJackLegR{0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(-26deg)}}
@keyframes rbTumble{0%{transform:translateY(0) rotate(0) scale(1,1)}12%{transform:translateY(2px) rotate(0) scale(1.1,.9)}38%{transform:translateY(-24px) rotate(140deg) scale(1,1)}64%{transform:translateY(-26px) rotate(270deg)}86%{transform:translateY(0) rotate(360deg) scale(1.1,.88)}100%{transform:translateY(0) rotate(360deg) scale(1,1)}}
@keyframes rbTuck{0%,100%{transform:rotate(2deg)}50%{transform:rotate(-70deg)}}
@keyframes rbTuckR{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(70deg)}}
@keyframes rbWalkBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}
@keyframes rbWalkL{0%,100%{transform:rotate(22deg)}50%{transform:rotate(-22deg)}}
@keyframes rbArmSwing{0%,100%{transform:rotate(28deg)}50%{transform:rotate(-28deg)}}
@keyframes rbArmSwingR{0%,100%{transform:rotate(-28deg)}50%{transform:rotate(28deg)}}
@keyframes rbDangle{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}
@media (prefers-reduced-motion:reduce){.wrap,.wrap *{animation:none!important}}
/*ROBOT-ANIM-END*/`;
  const DEFAULT_TIPS = [
    'Need a hand with a cancellation or refund? Ask me.',
    'Not sure which SOP applies? I check the announcements too.',
    'Paste a screenshot and I will read it for you.',
    'Ask me about PTO, attendance or other HR policy.',
    'Looking for how a ticket was handled before? I can find it.'
  ];
  const DEFAULT_ACTS = { wave: 2900, dance: 3000, clap: 2100, nod: 1700, spin: 1300, stretch: 3300, hop: 1200, lie: 4500, jack: 3100, tumble: 1600, wander: 0 };
  const VERSION = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '0';
  let cfg = { svg: ROBOT, css: DEFAULT_ANIM_CSS, tips: DEFAULT_TIPS, acts: DEFAULT_ACTS, minExtensionVersion: '0' };
  const versionLess = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };

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
      .tip{position:absolute;right:72px;top:14px;background:#fff;color:#20243a;border:1px solid #dfe2ea;border-radius:12px;padding:6px 12px;font-size:12.5px;font-weight:700;
        box-shadow:0 6px 16px rgba(32,36,55,.16);white-space:nowrap;pointer-events:none;opacity:0;transform:translateX(6px);transition:opacity .15s,transform .15s}
      .wrap:hover .tip{opacity:1;transform:none}
      .bubble{position:absolute;right:74px;bottom:46px;width:210px;background:#fff;color:#20243a;border:1px solid #dfe2ea;border-radius:14px 14px 4px 14px;padding:9px 12px;font-size:12.5px;line-height:1.4;font-weight:600;box-shadow:0 8px 22px rgba(32,36,55,.2);opacity:0;pointer-events:none}
      .bubble.show{animation:pop 6s ease-in-out 1 forwards}
      .hide{all:unset;position:absolute;top:-4px;left:-6px;width:18px;height:18px;border-radius:50%;background:#444;color:#fff;font-size:11px;line-height:18px;text-align:center;cursor:pointer;opacity:0;transition:opacity .15s}
      .wrap:hover .hide{opacity:.85}.hide:hover{opacity:1}
      @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
      @keyframes pop{0%{opacity:0;transform:translateY(6px) scale(.96)}12%,88%{opacity:1;transform:none}100%{opacity:0;transform:translateY(6px) scale(.96)}}
      @media print{:host{display:none}}
    </style>
    <style id="anim"></style>
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
  let tipCount = 0, updateNoted = false;
  function pickTip() {
    if (!updateNoted && versionLess(VERSION, cfg.minExtensionVersion)) { updateNoted = true; return 'A newer Lotti extension is available - download it from the Lotti page in the portal.'; }
    const t = cfg.tips && cfg.tips.length ? cfg.tips : DEFAULT_TIPS;
    return t[Math.floor(Math.random() * t.length)];
  }
  function showTip() {
    if (document.hidden || tipCount >= 4 || bubble.classList.contains('show')) return;
    bubble.textContent = pickTip(); tipCount += 1;
    bubble.classList.remove('show'); void bubble.offsetWidth; bubble.classList.add('show');
    cheer();
  }
  setTimeout(() => { showTip(); setInterval(showTip, 90000); }, 25000);

  // Personality: every so often she waves, dances, claps, nods, spins, stretches or hops; her eyes follow the pointer while it is near; she dozes off if the page is left alone.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let lastMove = Date.now(), trackTimer = 0, walkTimer = 0, wandering = false, lastWander = Date.now() - 30000;
    const busy = () => document.hidden || wandering || ['held', 'cheer', 'sleepy', 'dropping'].some(c => wrapEl.classList.contains(c)) || bubble.classList.contains('show');
    // She sometimes strolls (a sideways shuffle, still facing you) to another spot along her row, then walks back home. A click or drag stops it.
    function walkTo(left, done) {
      const r = host.getBoundingClientRect();
      host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.right = 'auto'; host.style.bottom = 'auto'; void host.offsetWidth;
      const secs = Math.max(1.2, Math.abs(left - r.left) / 70);
      wrapEl.style.setProperty('--lean', (left > r.left ? 6 : -6) + 'deg'); wrapEl.classList.add('walking');
      host.style.transition = `left ${secs}s linear`; host.style.left = left + 'px';
      walkTimer = setTimeout(() => { wrapEl.classList.remove('walking'); host.style.transition = ''; done && done(); }, secs * 1000 + 80);
    }
    function stopWalking() {
      clearTimeout(walkTimer); if (!wandering) return;
      const r = host.getBoundingClientRect(); host.style.transition = ''; host.style.left = r.left + 'px'; wrapEl.classList.remove('walking'); wandering = false; schedule();
    }
    function wander() {
      const home = host.getBoundingClientRect().left, minX = 24, maxX = innerWidth - 88;
      let target = minX + Math.random() * Math.max(0, maxX - minX);
      if (Math.abs(target - home) < 220) target = home > innerWidth / 2 ? minX + Math.random() * Math.max(0, home - 300 - minX) : Math.min(maxX, home + 300 + Math.random() * 200);
      target = Math.min(Math.max(target, minX), maxX); wandering = true;
      walkTo(target, () => { walkTimer = setTimeout(() => { if (wandering) walkTo(Math.min(Math.max(home, minX), maxX), () => { wandering = false; schedule(); }); }, 4000 + Math.random() * 5000); });
    }
    bot.addEventListener('pointerdown', stopWalking);
    wrapEl.addEventListener('lotti-wander', () => { if (!busy()) wander(); });
    const schedule = () => setTimeout(() => {
      if (busy()) { schedule(); return; }
      const ACTS = cfg.acts || DEFAULT_ACTS, others = Object.keys(ACTS).filter(k => k !== 'wander'), every = cfg.wanderEveryMs || 40000;
      const n = ('wander' in ACTS && Date.now() - lastWander > every) ? 'wander' : others[Math.floor(Math.random() * others.length)];
      if (n === 'wander') { lastWander = Date.now(); wander(); return; }
      wrapEl.classList.add('act-' + n);
      setTimeout(() => { wrapEl.classList.remove('act-' + n); schedule(); }, (ACTS[n] || 2000) + 100);
    }, (cfg.actGapMs ? cfg.actGapMs[0] : 4000) + Math.random() * (cfg.actGapMs ? cfg.actGapMs[1] - cfg.actGapMs[0] : 4500));
    schedule();
    document.addEventListener('pointermove', e => {
      lastMove = Date.now(); wrapEl.classList.remove('sleepy');
      if (wrapEl.classList.contains('held')) return;
      const r = wrapEl.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.33;
      const dx = e.clientX - cx, dy = e.clientY - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 260);
      wrapEl.style.setProperty('--ex', (dx / d * 3 * k).toFixed(2) + 'px'); wrapEl.style.setProperty('--ey', (dy / d * 2 * k).toFixed(2) + 'px'); wrapEl.style.setProperty('--hr', (dx / d * 4 * k).toFixed(2) + 'deg');
      wrapEl.classList.add('track'); clearTimeout(trackTimer); trackTimer = setTimeout(() => wrapEl.classList.remove('track'), 2500);
    }, { passive: true });
    setInterval(() => { if (!document.hidden && Date.now() - lastMove > 150000) wrapEl.classList.add('sleepy'); }, 10000);
  }
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
    if (!moved) wrapEl.classList.add('held');
    moved = true; place(drag.left + dx, drag.top + dy);
  });
  bot.addEventListener('pointerup', e => {
    if (!drag) return;
    bot.releasePointerCapture(e.pointerId); wrapEl.classList.remove('held');
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

  // First appearance on a page: she drops in from above the top of the screen, lands with a squash, bounces and waves hello.
  let dropped = false;
  function entrance() {
    if (dropped || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    dropped = true;
    setTimeout(() => {
      const r = host.getBoundingClientRect(); if (!r.height) return;
      wrapEl.style.setProperty('--dropFrom', -(r.top + r.height + 40) + 'px');
      wrapEl.classList.add('dropping');
      setTimeout(() => { wrapEl.classList.remove('dropping'); wrapEl.classList.add('act-wave'); setTimeout(() => wrapEl.classList.remove('act-wave'), 3000); }, 2000);
    }, 500);
  }
  function applyConfig(c) {
    if (!c || typeof c.svg !== 'string' || typeof c.css !== 'string') return;
    cfg = { ...cfg, ...c, tips: Array.isArray(c.tips) ? c.tips : cfg.tips, acts: c.acts && typeof c.acts === 'object' ? c.acts : cfg.acts };
    root.querySelector('#anim').textContent = cfg.css;
    bot.innerHTML = cfg.svg;
  }
  root.querySelector('#anim').textContent = cfg.css;
  store.get('lottiRobot').then(({ lottiRobot }) => applyConfig(lottiRobot)).catch(() => {});
  try { chrome.runtime.sendMessage({ type: 'robot-check' }); } catch (_) { /* extension was reloaded; the next page load will check */ }
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.lottiRobot && changes.lottiRobot.newValue) applyConfig(changes.lottiRobot.newValue); });

  store.get(['lottiHiddenHosts', 'lottiPos']).then(({ lottiHiddenHosts = [], lottiPos }) => {
    if (lottiHiddenHosts.includes(HOST)) return;
    document.documentElement.appendChild(host);
    entrance();
    if (lottiPos) place(lottiPos.left * (innerWidth / (lottiPos.vw || innerWidth)), lottiPos.top * (innerHeight / (lottiPos.vh || innerHeight)));
  }).catch(() => { document.documentElement.appendChild(host); entrance(); });
})();
