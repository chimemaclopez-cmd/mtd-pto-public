'use strict';

const HOME = 'https://help.lofty.com/hc/en-us';
const STOP_WORDS = new Set('what which where when how why can does do is are the a an to for of in on with my i you it this that and about please'.split(' '));

function articleText(html) {
  return String(html || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    })
    .replace(/&(nbsp|amp|quot|apos|lt|gt|ndash|mdash);/gi, (_, key) => ({nbsp:' ',amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',ndash:'–',mdash:'—'}[key.toLowerCase()]))
    .split('\n').map(line => line.replace(/[\t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Keep short articles in full. For longer ones, retain the introduction and the
// most relevant passage rather than discarding all text after the first 900 chars.
function articleExcerpt(text, query, limit = 6000) {
  if (text.length <= limit) return text;
  const intro = 1200, windowSize = limit - intro - 30;
  const words = [...new Set(String(query || '').toLowerCase().match(/[a-z0-9]+/g) || [])].filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const lower = text.toLowerCase();
  let bestStart = intro, bestScore = 0;
  const starts = new Set([intro, Math.max(intro, text.length - windowSize)]);
  for (const word of words) {
    let at = lower.indexOf(word, intro), seen = 0;
    while (at >= 0 && seen++ < 40) {
      starts.add(Math.max(intro, Math.min(at - 400, text.length - windowSize)));
      at = lower.indexOf(word, at + word.length);
    }
  }
  for (const start of starts) {
    const passage = lower.slice(start, start + windowSize);
    const score = words.reduce((n, word) => n + (passage.includes(word) ? 1 : 0), 0);
    if (score > bestScore) { bestStart = start; bestScore = score; }
  }
  return `${text.slice(0, intro)}\n[... excerpt ...]\n${text.slice(bestStart, bestStart + windowSize)}`;
}

function buildHelpArticleSources(articles, query, fetchedAt = new Date().toISOString()) {
  return (articles || []).filter(article => {
    if (article.draft) return false;
    try { const url = new URL(article.html_url); return url.protocol === 'https:' && url.hostname === 'help.lofty.com' && url.pathname.startsWith('/hc/en-us/articles/'); }
    catch { return false; }
  }).slice(0, 3).map(article => {
    const text = articleText(article.body);
    return { title: article.title, url: article.html_url, category: 'Lofty Help Center — official product source of truth', sourceHome: HOME, updatedAt: article.updated_at || null, fetchedAt, excerpted: text.length > 6000, snippet: articleExcerpt(text, query) };
  });
}

module.exports = { HOME, articleText, articleExcerpt, buildHelpArticleSources };
