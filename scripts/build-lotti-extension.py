#!/usr/bin/env python3
"""Zips extension/lotti-everywhere (+ README) into shared/downloads/Lotti-Everywhere.zip, which the portal serves to signed-in users."""
import os, zipfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, 'extension', 'lotti-everywhere')
out = os.path.join(root, 'shared', 'downloads', 'Lotti-Everywhere.zip')
os.makedirs(os.path.dirname(out), exist_ok=True)
skip = {'robot.svg', 'robot-full.svg'}  # artwork sources; the content script already embeds the robot
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(src):
        for f in sorted(files):
            if f in skip or f.startswith('.'): continue
            p = os.path.join(base, f)
            z.write(p, os.path.join('lotti-everywhere', os.path.relpath(p, src)))
print('built', out, os.path.getsize(out), 'bytes')
