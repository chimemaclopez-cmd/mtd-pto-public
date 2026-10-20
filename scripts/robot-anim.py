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
{P}.cheer svg{{animation:rbCheer .9s ease-out 1}}{P}.cheer .lbWave{{animation:rbWave .7s linear 2}}
{P}.thinking .lbEyes{{animation:rbThink 1.8s ease-in-out infinite}}{P}.thinking .lbHead{{animation:rbTilt 2.2s ease-in-out infinite}}{P}.thinking .lbAnt{{animation:rbAnt .5s ease-in-out infinite}}
{P}.sleepy .lbEyes{{animation:none;transform:scaleY(.15);transform-box:fill-box;transform-origin:center}}{P}.sleepy .lbHead{{animation:rbDroop 4s ease-in-out infinite}}
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
