#!/usr/bin/env python3
"""Generates Lotti's robot animation CSS for a given selector prefix (portal: .lottiFloatBtn, extension: .wrap) and writes it between the
/*ROBOT-ANIM-START*/ and /*ROBOT-ANIM-END*/ markers of pto-public.html and extension/lotti-everywhere/content.js."""
import os, re, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def css(P):
    return f"""/*ROBOT-ANIM-START*/
{P} svg{{overflow:visible;transform-origin:50% 50%}}
{P} .lbEye{{animation:rbBlink 5s infinite;transform-box:fill-box;transform-origin:center}}
{P} .lbArm{{transform-box:view-box;transform-origin:13.5px 63px;animation:rbSway 3.6s ease-in-out infinite}}
{P} .lbWave{{transform-box:view-box;transform-origin:66.5px 63px;animation:rbSwayR 3.6s ease-in-out infinite;animation-delay:-1.2s}}
{P} .lbLeg{{transform-box:fill-box;transform-origin:50% 0;animation:rbStep 3.6s ease-in-out infinite}}{P} .lbLegR{{animation-delay:-1.8s}}
{P} .lbHead{{transform-box:view-box;transform-origin:40px 62px;animation:rbTilt 9s ease-in-out infinite}}
{P} .lbAnt{{transform-box:view-box;transform-origin:40px 17px;animation:rbAnt 2.8s ease-in-out infinite}}
{P} .lbEyes{{animation:rbLook 8s ease-in-out infinite}}
{P}.track .lbEyes{{animation:none;transform:translate(var(--ex,0px),var(--ey,0px))}}
{P}.track .lbHead{{animation:none;transform:rotate(var(--hr,0deg))}}
{P}:hover .lbWave{{animation:rbWave 1.6s ease-in-out infinite}}
{P}.act-wave .lbWave{{animation:rbWave 2.8s ease-in-out 1}}
{P}.act-dance svg{{animation:rbRock .7s ease-in-out 4}}
{P}.act-dance .lbWave{{animation:rbUpR .35s ease-in-out 8}}{P}.act-dance .lbArm{{animation:rbUpL .35s ease-in-out 8}}
{P}.act-dance .lbLeg{{animation:rbStomp .35s ease-in-out 8}}{P}.act-dance .lbHead{{animation:rbHeadBop .35s ease-in-out 8}}
{P}.act-clap .lbArm{{animation:rbClapL .28s ease-in-out 7}}{P}.act-clap .lbWave{{animation:rbClapR .28s ease-in-out 7}}
{P}.act-nod .lbHead{{animation:rbNod .5s ease-in-out 3}}
{P}.act-spin svg{{animation:rbSpin 1.2s ease-in-out 1}}
{P}.act-stretch svg{{animation:rbStretch 3.2s ease-in-out 1}}
{P}.act-stretch .lbArm{{animation:rbStretchL 3.2s ease-in-out 1}}{P}.act-stretch .lbWave{{animation:rbStretchR 3.2s ease-in-out 1}}
{P}.act-stretch .lbEyes{{animation:rbSquint 3.2s ease-in-out 1;transform-box:fill-box;transform-origin:center}}
{P}.act-hop svg{{animation:rbHop 1.1s ease-in-out 1}}
{P}.act-lie svg{{animation:rbLie 4.4s ease-in-out 1}}{P}.act-lie .lbEyes{{animation:rbNapEyes 4.4s ease-in-out 1;transform-box:fill-box;transform-origin:center}}
{P}.act-lie .lbArm{{animation:rbLieArm 4.4s ease-in-out 1}}{P}.act-lie .lbWave{{animation:rbLieArmR 4.4s ease-in-out 1}}{P}.act-lie .lbHead{{animation:rbNapHead 4.4s ease-in-out 1}}
{P}.act-jack svg{{animation:rbJackHop .5s ease-in-out 6}}
{P}.act-jack .lbArm{{animation:rbJackArmL .5s ease-in-out 6}}{P}.act-jack .lbWave{{animation:rbJackArmR .5s ease-in-out 6}}
{P}.act-jack .lbLeg{{animation:rbJackLegL .5s ease-in-out 6}}{P}.act-jack .lbLegR{{animation:rbJackLegR .5s ease-in-out 6}}
{P}.act-tumble svg{{animation:rbTumble 1.5s ease-in-out 1}}{P}.act-tumble .lbArm{{animation:rbTuck .75s ease-in-out 2}}{P}.act-tumble .lbWave{{animation:rbTuckR .75s ease-in-out 2}}
{P}.cheer svg{{animation:rbCheer .9s ease-out 1}}{P}.cheer .lbWave{{animation:rbWave .7s linear 2}}
{P}.thinking .lbEyes{{animation:rbThink 1.8s ease-in-out infinite}}{P}.thinking .lbHead{{animation:rbTilt 2.2s ease-in-out infinite}}{P}.thinking .lbAnt{{animation:rbAnt .5s ease-in-out infinite}}
{P}.sleepy .lbEyes{{animation:none;transform:scaleY(.15);transform-box:fill-box;transform-origin:center}}{P}.sleepy .lbHead{{animation:rbDroop 4s ease-in-out infinite}}
{P}.dropping{{animation:rbDrop 1.9s linear 1 both}}
{P}.dropping svg{{animation:rbLand 1.9s linear 1}}
{P}.dropping .lbArm{{animation:rbFlailL .28s ease-in-out 3}}{P}.dropping .lbWave{{animation:rbFlailR .28s ease-in-out 3}}
{P}.dropping .lbLeg{{animation:rbKick .24s ease-in-out 4}}
{P} .lbPuff{{opacity:0;transform-box:fill-box;transform-origin:center}}
{P}.dropping .lbPuff{{animation:rbPuffDrop 1.9s ease-out 1}}{P}.act-hop .lbPuff{{animation:rbPuffHop 1.1s ease-out 1}}
{P}.act-tumble .lbPuff{{animation:rbPuffTumble 1.5s ease-out 1}}{P}.cheer .lbPuff{{animation:rbPuffCheer .9s ease-out 1}}
{P}.dropping .lbEyes{{animation:rbWide 1.9s linear 1;transform-box:fill-box;transform-origin:center}}
{P}.walking svg{{animation:rbWalkBob .36s ease-in-out infinite}}
{P}.walking .lbLeg{{animation:rbWalkL .36s ease-in-out infinite}}{P}.walking .lbLegR{{animation-delay:-.18s}}
{P}.walking .lbArm{{animation:rbArmSwing .36s ease-in-out infinite}}{P}.walking .lbWave{{animation:rbArmSwingR .36s ease-in-out infinite;animation-delay:0s}}
{P}.walking .lbHead{{animation:none;transform:rotate(var(--lean,0deg))}}
{P}.walking .lbEyes{{animation:none;transform:translateX(calc(var(--lean,0deg) * .5))}}
{P}.held .lbArm{{animation:none;transform:rotate(155deg)}}{P}.held .lbWave{{animation:none;transform:rotate(-155deg)}}{P}.held .lbLeg{{animation:rbDangle .5s ease-in-out infinite}}
@keyframes rbBlink{{0%,92%,100%{{transform:scaleY(1)}}95%{{transform:scaleY(.1)}}}}
@keyframes rbSway{{0%,100%{{transform:rotate(2deg)}}50%{{transform:rotate(-3deg)}}}}
@keyframes rbSwayR{{0%,100%{{transform:rotate(-2deg)}}50%{{transform:rotate(3deg)}}}}
@keyframes rbStep{{0%,100%{{transform:rotate(1.5deg)}}50%{{transform:rotate(-1.5deg)}}}}
@keyframes rbTilt{{0%,100%{{transform:rotate(0)}}20%{{transform:rotate(-4deg)}}45%{{transform:rotate(0)}}70%{{transform:rotate(4deg)}}}}
@keyframes rbAnt{{0%,100%{{transform:rotate(-7deg)}}50%{{transform:rotate(7deg)}}}}
@keyframes rbLook{{0%,18%,100%{{transform:translateX(0)}}28%,42%{{transform:translateX(-3px)}}55%,70%{{transform:translateX(3px)}}}}
@keyframes rbWave{{0%,100%{{transform:rotate(0)}}15%{{transform:rotate(-128deg)}}30%{{transform:rotate(-150deg)}}45%{{transform:rotate(-124deg)}}60%{{transform:rotate(-150deg)}}75%{{transform:rotate(-124deg)}}}}
@keyframes rbRock{{0%,100%{{transform:rotate(0) translateX(0)}}25%{{transform:rotate(-7deg) translateX(-3px)}}75%{{transform:rotate(7deg) translateX(3px)}}}}
@keyframes rbUpR{{0%,100%{{transform:rotate(-140deg)}}50%{{transform:rotate(-168deg)}}}}
@keyframes rbUpL{{0%,100%{{transform:rotate(140deg)}}50%{{transform:rotate(168deg)}}}}
@keyframes rbStomp{{0%,100%{{transform:rotate(0)}}50%{{transform:rotate(9deg)}}}}
@keyframes rbHeadBop{{0%,100%{{transform:translateY(0) rotate(0)}}50%{{transform:translateY(2px) rotate(4deg)}}}}
@keyframes rbClapL{{0%,100%{{transform:rotate(2deg)}}50%{{transform:rotate(-55deg)}}}}
@keyframes rbClapR{{0%,100%{{transform:rotate(-2deg)}}50%{{transform:rotate(55deg)}}}}
@keyframes rbNod{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(3px)}}}}
@keyframes rbSpin{{0%,100%{{transform:scaleX(1)}}25%,75%{{transform:scaleX(.05)}}50%{{transform:scaleX(-1)}}}}
@keyframes rbStretch{{0%,100%{{transform:scale(1,1)}}25%,70%{{transform:scale(.97,1.08)}}}}
@keyframes rbStretchL{{0%,100%{{transform:rotate(2deg)}}25%,70%{{transform:rotate(160deg)}}}}
@keyframes rbStretchR{{0%,100%{{transform:rotate(-2deg)}}25%,70%{{transform:rotate(-160deg)}}}}
@keyframes rbSquint{{0%,100%{{transform:scaleY(1)}}30%,65%{{transform:scaleY(.25)}}}}
@keyframes rbHop{{0%,100%{{transform:translateY(0) scale(1,1)}}20%{{transform:translateY(0) scale(1.07,.9)}}45%{{transform:translateY(-18px) scale(.96,1.06)}}70%{{transform:translateY(0) scale(1.07,.9)}}}}
@keyframes rbCheer{{0%{{transform:translateY(0) scale(1)}}30%{{transform:translateY(-22px) scale(.95,1.08)}}60%{{transform:translateY(0) scale(1.08,.9)}}100%{{transform:translateY(0) scale(1)}}}}
@keyframes rbThink{{0%,100%{{transform:translate(0,-2px)}}50%{{transform:translate(3px,-2px)}}}}
@keyframes rbDroop{{0%,100%{{transform:rotate(6deg) translateY(1px)}}50%{{transform:rotate(9deg) translateY(2px)}}}}
@keyframes rbDrop{{0%{{transform:translateY(var(--dropFrom,-400px));animation-timing-function:cubic-bezier(.55,0,1,.45)}}44%{{transform:translateY(0);animation-timing-function:cubic-bezier(0,.55,.45,1)}}62%{{transform:translateY(-26px);animation-timing-function:cubic-bezier(.55,0,1,.45)}}78%{{transform:translateY(0);animation-timing-function:cubic-bezier(0,.55,.45,1)}}88%{{transform:translateY(-9px);animation-timing-function:cubic-bezier(.55,0,1,.45)}}100%{{transform:translateY(0)}}}}
@keyframes rbLand{{0%,43%{{transform:scale(.92,1.12)}}46%{{transform:scale(1.2,.76)}}54%{{transform:scale(.96,1.07)}}62%{{transform:scale(.97,1.05)}}78%{{transform:scale(1.12,.86)}}84%{{transform:scale(.98,1.03)}}92%,100%{{transform:scale(1,1)}}}}
@keyframes rbFlailL{{0%,100%{{transform:rotate(130deg)}}50%{{transform:rotate(165deg)}}}}
@keyframes rbFlailR{{0%,100%{{transform:rotate(-130deg)}}50%{{transform:rotate(-165deg)}}}}
@keyframes rbKick{{0%,100%{{transform:rotate(-14deg)}}50%{{transform:rotate(14deg)}}}}
@keyframes rbWide{{0%,44%{{transform:scale(1.25)}}46%,100%{{transform:scale(1)}}}}
@keyframes rbLie{{0%,100%{{transform:translateY(0) rotate(0)}}14%,86%{{transform:translateY(-34px) rotate(-90deg)}}}}
@keyframes rbNapEyes{{0%,12%,90%,100%{{transform:scaleY(1)}}18%,84%{{transform:scaleY(.12)}}}}
@keyframes rbLieArm{{0%,100%{{transform:rotate(2deg)}}14%,86%{{transform:rotate(12deg)}}}}
@keyframes rbLieArmR{{0%,100%{{transform:rotate(-2deg)}}14%,86%{{transform:rotate(-12deg)}}}}
@keyframes rbNapHead{{0%,100%{{transform:rotate(0)}}25%,75%{{transform:rotate(-5deg)}}50%{{transform:rotate(-3deg)}}}}
@keyframes rbJackHop{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(-10px)}}}}
@keyframes rbJackArmL{{0%,100%{{transform:rotate(2deg)}}50%{{transform:rotate(165deg)}}}}
@keyframes rbJackArmR{{0%,100%{{transform:rotate(-2deg)}}50%{{transform:rotate(-165deg)}}}}
@keyframes rbJackLegL{{0%,100%{{transform:rotate(1.5deg)}}50%{{transform:rotate(26deg)}}}}
@keyframes rbJackLegR{{0%,100%{{transform:rotate(-1.5deg)}}50%{{transform:rotate(-26deg)}}}}
@keyframes rbTumble{{0%{{transform:translateY(0) rotate(0) scale(1,1)}}12%{{transform:translateY(2px) rotate(0) scale(1.1,.9)}}38%{{transform:translateY(-24px) rotate(140deg) scale(1,1)}}64%{{transform:translateY(-26px) rotate(270deg)}}86%{{transform:translateY(0) rotate(360deg) scale(1.1,.88)}}100%{{transform:translateY(0) rotate(360deg) scale(1,1)}}}}
@keyframes rbTuck{{0%,100%{{transform:rotate(2deg)}}50%{{transform:rotate(-70deg)}}}}
@keyframes rbTuckR{{0%,100%{{transform:rotate(-2deg)}}50%{{transform:rotate(70deg)}}}}
@keyframes rbPuffDrop{{0%,43%{{opacity:0;transform:translate(0,0) scale(.3)}}46%{{opacity:1}}60%{{opacity:.9}}74%{{opacity:0;transform:translate(var(--dx),-14px) scale(1.9)}}77%{{opacity:0;transform:translate(0,0) scale(.3)}}79%{{opacity:.7}}93%{{opacity:0;transform:translate(calc(var(--dx) * .6),-6px) scale(1.1)}}100%{{opacity:0}}}}
@keyframes rbPuffHop{{0%,68%{{opacity:0;transform:translate(0,0) scale(.3)}}71%{{opacity:.8}}100%{{opacity:0;transform:translate(calc(var(--dx) * .7),-8px) scale(1.3)}}}}
@keyframes rbPuffTumble{{0%,84%{{opacity:0;transform:translate(0,0) scale(.3)}}87%{{opacity:.9}}100%{{opacity:0;transform:translate(var(--dx),-10px) scale(1.5)}}}}
@keyframes rbPuffCheer{{0%,57%{{opacity:0;transform:translate(0,0) scale(.3)}}61%{{opacity:.8}}100%{{opacity:0;transform:translate(calc(var(--dx) * .8),-8px) scale(1.4)}}}}
@keyframes rbWalkBob{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(-2.5px)}}}}
@keyframes rbWalkL{{0%,100%{{transform:rotate(22deg)}}50%{{transform:rotate(-22deg)}}}}
@keyframes rbArmSwing{{0%,100%{{transform:rotate(28deg)}}50%{{transform:rotate(-28deg)}}}}
@keyframes rbArmSwingR{{0%,100%{{transform:rotate(-28deg)}}50%{{transform:rotate(28deg)}}}}
@keyframes rbDangle{{0%,100%{{transform:rotate(-6deg)}}50%{{transform:rotate(6deg)}}}}
@media (prefers-reduced-motion:reduce){{{P},{P} *{{animation:none!important}}}}
/*ROBOT-ANIM-END*/"""

def patch(path, prefix, strip_old):
    s = open(path).read()
    if '/*ROBOT-ANIM-START*/' in s:
        s = re.sub(r'/\*ROBOT-ANIM-START\*/.*?/\*ROBOT-ANIM-END\*/', lambda m: css(prefix), s, flags=re.S)
    else:
        s = strip_old(s)
        s = s.replace('@keyframes lottiBob{', css(prefix) + '\n@keyframes lottiBob{', 1) if '@keyframes lottiBob{' in s else s
    open(path, 'w').write(s)

def strip_portal(s):
    s = re.sub(r"\.lottiFloatBtn svg\{animation:lottiHop[^\n]*\n", "", s)
    s = re.sub(r"\.lottiFloatBtn \.lb(Head|Ant|Eyes|Wave|Arm|Leg|Pulse|Eye)[^\n]*\n", "", s)
    s = re.sub(r"\.lottiFloatBtn:hover \.lbWave[^\n]*\n", "", s)
    s = re.sub(r"\.lottiFloatBtn\.cheer[^\n]*\n", "", s)
    s = re.sub(r"@keyframes lotti(Hop|Tilt|Ant|Look|Cheer|Wave|Sway|Step|Pulse|Blink)\{[^\n]*\n", "", s)
    s = re.sub(r"@media \(prefers-reduced-motion:reduce\)\{\.lottiFloatBtn,[^\n]*\n", "", s)
    return s

if __name__ == '__main__':
    patch(os.path.join(root, 'pto-public.html'), '.lottiFloatBtn', strip_portal)
    print('portal css written')
