'use strict';
// Loads the Moatable Employee Handbook PDF into the shared cloud store so that
//   (1) the Company > Employee Handbook tab can show it (served only to signed-in users - the handbook is confidential, so the PDF is
//       deliberately NOT committed to this public repository), and
//   (2) Lotti can search it by section and cite the page.
// Usage: set -a && source .env && set +a && node scripts/ingest-handbook.js "<path to Handbook.pdf>" ["edition label"]
// Re-run it with a newer PDF to replace the old one.
const fs = require('fs');
const { execFileSync } = require('child_process');
const kv = require('../server/kv-store.js');

const file = process.argv[2];
const edition = process.argv[3] || 'June 2020 edition';
if (!file || !fs.existsSync(file)) { console.error('Pass the path to the handbook PDF.'); process.exit(1); }

const STOP = new Set('the and for are but not you your with this that from have has was were will can how what when where who why does did into onto out off any all more most other some such than then them they their there these those its also just like get got make made use used using need needs per via one two new add see following below above please note each about over under between within without shall may must employee employees company moatable'.split(/\s+/));
function keywords(title, text) {
  const freq = new Map();
  for (const w of `${title} ${title} ${text}`.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || w.length > 24 || STOP.has(w) || /^\d+$/.test(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(e => e[0]).join(' ');
}

(async () => {
  const text = execFileSync('pdftotext', ['-layout', file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const pages = execFileSync('pdfinfo', [file]).toString().match(/Pages:\s+(\d+)/)?.[1] || '';
  // Table of contents: "TITLE ______ 12" lines at the start.
  const lines = text.split('\n');
  const toc = [];
  for (const l of lines.slice(0, 400)) {
    const m = l.match(/^(\s*)(.+?)\s*_{3,}\s*(\d+)\s*$/);
    if (m) toc.push({ title: m[2].trim().replace(/\s+/g, ' '), page: Number(m[3]), level: Math.min(3, Math.floor(m[1].length / 4)) });
  }
  if (toc.length < 10) throw new Error('Could not read the table of contents.');
  // Body: everything after the TOC, without page headers/footers.
  const bodyStart = lines.findIndex((l, i) => i > 60 && /INTRODUCTION/i.test(l) && !/_{3,}/.test(l));
  const clean = lines.slice(bodyStart < 0 ? 0 : bodyStart).filter(l => !/Proprietary and Confidential Employee Handbook/i.test(l) && !/^\s*Moatable Inc\.\s*$/.test(l) && !/^\s*Employee Handbook\s*$/i.test(l)).map(l => l.replace(/\s+$/, ''));
  // Split at each TOC title, in order.
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let cursor = 0;
  const marks = [];
  for (const t of toc) {
    for (let i = cursor; i < clean.length; i += 1) {
      if (norm(clean[i]) === norm(t.title)) { marks.push({ ...t, at: i }); cursor = i + 1; break; }
    }
  }
  const sections = [];
  marks.forEach((m, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].at : clean.length;
    const body = clean.slice(m.at + 1, end).join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, '  ').trim();
    if (body.length < 80) return;
    // The chapter ("V. WORK CONDITIONS") gives each section its context, for the reader and for the search.
    const isChapter = t => /^[IVX]+\.\s/.test(t);
    const parent = isChapter(m.title) ? null : [...marks.slice(0, idx)].reverse().find(p => isChapter(p.title));
    const base = parent ? `${parent.title.replace(/^[IVX]+\.\s*/, '')} - ${m.title}` : m.title.replace(/^[IVX]+\.\s*/, '');
    for (let o = 0, part = 1; o < body.length; o += 5000, part += 1) {
      sections.push({ title: body.length > 5000 ? `${base} (part ${part})` : base, page: m.page, text: body.slice(o, o + 5000) });
    }
  });
  const label = 'Moatable Employee Handbook';
  const index = sections.map((s, i) => ({ i, t: s.title.slice(0, 140), p: s.page, k: keywords(s.title, s.text) }));
  for (let i = 0; i < sections.length; i += 8) {
    await Promise.all(sections.slice(i, i + 8).map((s, j) => kv.kvSetJson(`mtdkpi:handbook:s:${i + j}`, { id: i + j, title: s.title, page: s.page, text: s.text, label, edition })));
  }
  const oldMeta = await kv.kvGetJson('mtdkpi:handbook:meta', null);
  const pdf = fs.readFileSync(file).toString('base64');
  const CHUNK = 350 * 1024, chunks = Math.ceil(pdf.length / CHUNK);
  for (let c = 0; c < chunks; c += 1) await kv.kvSetJson(`mtdkpi:handbook:pdf:${c}`, { data: pdf.slice(c * CHUNK, (c + 1) * CHUNK) });
  for (let c = chunks; oldMeta && c < (oldMeta.chunks || 0); c += 1) await kv.kvDel(`mtdkpi:handbook:pdf:${c}`);
  for (let i = sections.length; oldMeta && i < (oldMeta.sectionCount || 0); i += 1) await kv.kvDel(`mtdkpi:handbook:s:${i}`);
  await kv.kvSetJson('mtdkpi:handbook:index', index);
  await kv.kvSetJson('mtdkpi:handbook:meta', { title: label, edition, pages: Number(pages) || 0, bytes: fs.statSync(file).size, chunks, sectionCount: sections.length, toc, uploadedAt: new Date().toISOString() });
  console.log(`handbook stored: ${pages} pages, ${toc.length} TOC entries, ${sections.length} searchable sections, ${chunks} PDF chunks`);
  const cl = sections.filter(s => /cleans|prescript/i.test(s.title + s.text)).map(s => `${s.title} (p.${s.page})`);
  console.log('sections mentioning cleansing:', cl.slice(0, 5).join(' | '));
  process.exit(0);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
