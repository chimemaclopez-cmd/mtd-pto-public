#!/usr/bin/env python3
"""Builds the downloadable extension: shared/downloads/Lotti-Everywhere-<version>.zip (+ latest.json that the portal's download route reads).

The version comes from extension/lotti-everywhere/manifest.json. If the extension's own CODE changed since the last build (content.js outside the robot art/animation blocks,
background.js, manifest.json - the robot artwork is downloaded separately and does not count) and the version was not raised, the patch number is raised for you
(1.4.0 -> 1.4.1), so every zip people can download has its own number. Use --bump minor or --bump major for bigger releases.
"""
import hashlib, json, os, re, sys, zipfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, 'extension', 'lotti-everywhere')
out_dir = os.path.join(root, 'shared', 'downloads')
manifest_path = os.path.join(src, 'manifest.json')
latest_path = os.path.join(out_dir, 'latest.json')
os.makedirs(out_dir, exist_ok=True)

def code_hash():
    h = hashlib.sha1()
    for name in ('manifest.json', 'background.js', 'content.js'):
        t = open(os.path.join(src, name)).read()
        if name == 'manifest.json':
            t = re.sub(r'"version(_name)?":\s*"[^"]*"', '"version":"x"', t)
        if name == 'content.js':   # the art and animation CSS are data, not code
            t = re.sub(r'/\*ROBOT-ANIM-START\*/.*?/\*ROBOT-ANIM-END\*/', '', t, flags=re.S)
            t = re.sub(r'const ROBOT = `.*?`;', 'const ROBOT = ``;', t, flags=re.S)
        h.update(t.encode())
    return h.hexdigest()[:12]

def bump(version, part):
    a, b, c = [int(x) for x in version.split('.')]
    return {'major': f'{a+1}.0.0', 'minor': f'{a}.{b+1}.0', 'patch': f'{a}.{b}.{c+1}'}[part]

manifest = json.load(open(manifest_path))
latest = json.load(open(latest_path)) if os.path.exists(latest_path) else {}
now_hash = code_hash()
explicit = sys.argv[sys.argv.index('--bump') + 1] if '--bump' in sys.argv else None
if explicit:
    manifest['version'] = bump(manifest['version'], explicit)
elif latest and latest.get('codeHash') != now_hash and latest.get('version') == manifest['version']:
    manifest['version'] = bump(manifest['version'], 'patch')
    print('extension code changed -> version raised automatically to', manifest['version'])
manifest['version_name'] = manifest['version']
json.dump(manifest, open(manifest_path, 'w'), indent=2); open(manifest_path, 'a').write('\n')
version = manifest['version']

# README carries the version too
readme = os.path.join(src, 'README.txt'); r = open(readme).read()
r = re.sub(r'^LOTTI EVERYWHERE[^\n]*', f'LOTTI EVERYWHERE v{version} - Lotti on your other tabs (Chrome or Edge)', r, count=1)
open(readme, 'w').write(r)

for f in os.listdir(out_dir):
    if re.match(r'Lotti-Everywhere(-[\d.]+)?\.zip$', f): os.remove(os.path.join(out_dir, f))
name = f'Lotti-Everywhere-{version}.zip'
skip = {'robot.svg', 'robot-full.svg'}  # artwork sources; the content script already embeds the robot
with zipfile.ZipFile(os.path.join(out_dir, name), 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(src):
        for f in sorted(files):
            if f in skip or f.startswith('.'): continue
            p = os.path.join(base, f)
            z.write(p, os.path.join('lotti-everywhere', os.path.relpath(p, src)))
json.dump({'version': version, 'file': name, 'codeHash': now_hash}, open(latest_path, 'w'))

# the portal's download link shows which version it hands out
page_path = os.path.join(root, 'pto-public.html'); page = open(page_path).read()
page = re.sub(r'(<a href="/api/my/lotti-extension\.zip" download>)[^<]*(</a>)', rf'\g<1>Download the extension (v{version})\g<2>', page)
open(page_path, 'w').write(page)
print('built', name, os.path.getsize(os.path.join(out_dir, name)), 'bytes - version', version)
