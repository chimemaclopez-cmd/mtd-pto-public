#!/usr/bin/env python3
"""One command to publish a robot change.

Edit the robot art (extension/lotti-everywhere/robot-full.svg), the moves (scripts/robot-anim.py) or the tips/timings below, then run:
    python3 scripts/build-robot.py
It regenerates the animation CSS inside the portal page and the extension's built-in fallback, writes shared/lotti-robot.json (the file every installed
extension re-downloads on its own), and rebuilds the download zip. Commit and push; installed extensions pick the change up within about an hour.
"""
import hashlib, importlib.util, json, os, subprocess, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('robot_anim', os.path.join(root, 'scripts', 'robot-anim.py'))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

TIPS = [
    'Need a hand with a cancellation or refund? Ask me.',
    'Not sure which SOP applies? I check the announcements too.',
    'Paste a screenshot and I will read it for you.',
    'Ask me about PTO, attendance or other HR policy.',
    'Looking for how a ticket was handled before? I can find it.',
]
ACTS = {'wave': 2900, 'dance': 3000, 'clap': 2100, 'nod': 1700, 'spin': 1300, 'stretch': 3300, 'hop': 1200, 'lie': 4500, 'jack': 3100, 'tumble': 1600, 'wander': 0}
MIN_EXTENSION_VERSION = '1.2.0'   # raise this only when the extension's own code changes and people must download it again

# 1. animation CSS into the portal page and the extension's built-in copy
ra.patch(os.path.join(root, 'pto-public.html'), '.lottiFloatBtn', ra.strip_portal)
ra.patch(os.path.join(root, 'extension', 'lotti-everywhere', 'content.js'), '.wrap', lambda s: s)

# 1b. the artwork into the portal's floating robot and the extension's built-in fallback copy
svg_src = open(os.path.join(root, 'extension', 'lotti-everywhere', 'robot-full.svg')).read().strip()
page = open(os.path.join(root, 'pto-public.html')).read()
i = page.index('id="lottiFloatBtn"'); a = page.index('<svg', i); b2 = page.index('</svg>', a) + 6
page = page[:a] + svg_src.replace('<svg ', '<svg aria-hidden="true" ', 1) + page[b2:]
open(os.path.join(root, 'pto-public.html'), 'w').write(page)
cj = open(os.path.join(root, 'extension', 'lotti-everywhere', 'content.js')).read()
a = cj.index('const ROBOT = `') + len('const ROBOT = `'); b3 = cj.index('`;', a)
cj = cj[:a] + svg_src.replace('`', '\\`').replace('${', '\\${') + cj[b3:]
open(os.path.join(root, 'extension', 'lotti-everywhere', 'content.js'), 'w').write(cj)

# 2. the file the extensions download
svg = open(os.path.join(root, 'extension', 'lotti-everywhere', 'robot-full.svg')).read().strip()
css = ra.css('.wrap')
body = {'svg': svg, 'css': css, 'tips': TIPS, 'acts': ACTS, 'wanderEveryMs': 40000, 'actGapMs': [4000, 8500], 'minExtensionVersion': MIN_EXTENSION_VERSION}
version = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:10]
out = os.path.join(root, 'shared', 'lotti-robot.json')
json.dump({'version': version, **body}, open(out, 'w'), separators=(',', ':'))
print('robot config', version, os.path.getsize(out), 'bytes ->', out)

# 3. the download zip
subprocess.check_call([sys.executable, os.path.join(root, 'scripts', 'build-lotti-extension.py')])
