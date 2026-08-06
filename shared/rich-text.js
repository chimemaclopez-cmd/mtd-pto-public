import {api} from './ui-utils.js';

export const draftAssist=(text)=>api('/api/my/draft-assist',{method:'POST',body:JSON.stringify({text})});

// Minimal rich-text support for content pasted from Word/PDF (SOP/process docs, announcements):
// a contenteditable field keeps whatever basic formatting the browser carries over on paste
// (bold, italic, lists, headings, paragraphs), and sanitizeRichHtml() strips everything else
// (scripts, event handlers, styles, non-http links, images) via an allow-list walk over a
// DOMParser-parsed, inert document - no npm dependency, consistent with the rest of this app.
// Sanitize on both the way in (before saving) and the way out (right before rendering), since
// stored content should never be trusted blindly at render time either.
const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'P', 'BR', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'A', 'DIV', 'SPAN']);
const ALLOWED_ATTRS = { A: ['href'] };

export function sanitizeRichHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const walk = node => {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (!ALLOWED_TAGS.has(child.tagName)) {
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        parent.removeChild(child);
        return;
      }
      [...child.attributes].forEach(attr => {
        const allowed = ALLOWED_ATTRS[child.tagName] || [];
        if (!allowed.includes(attr.name) || (attr.name === 'href' && !/^https?:/i.test(attr.value))) child.removeAttribute(attr.name);
      });
      walk(child);
    });
  };
  walk(doc.body);
  return doc.body.innerHTML.trim();
}

export function plainTextFromHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return (doc.body.textContent || '').trim();
}

// Toolbar + contenteditable body, wired to document.execCommand - deprecated but still the only
// dependency-free way to get basic rich editing (bold/italic/list/heading) in a Chromium browser,
// which is what this app already targets (README: "Open the other HTML files in Chrome").
export function richTextFieldHtml(fieldId) {
  return `<div class="richTextToolbar" data-rt-toolbar="${fieldId}">
<button type="button" class="btn compact" data-rt-cmd="bold" title="Bold"><b>B</b></button>
<button type="button" class="btn compact" data-rt-cmd="italic" title="Italic"><i>I</i></button>
<button type="button" class="btn compact" data-rt-cmd="underline" title="Underline"><u>U</u></button>
<button type="button" class="btn compact" data-rt-cmd="formatBlock" data-rt-value="H3" title="Heading">H</button>
<button type="button" class="btn compact" data-rt-cmd="insertUnorderedList" title="Bullet List">&bull; List</button>
<button type="button" class="btn compact" data-rt-cmd="insertOrderedList" title="Numbered List">1. List</button>
<button type="button" class="btn compact" data-rt-cmd="formatBlock" data-rt-value="P" title="Clear formatting">Clear</button>
<button type="button" class="btn compact" data-rt-ai="rephrase" title="Fix grammar, spelling, and awkward wording">&#10024; Rephrase</button>
</div><div class="richTextBody" id="${fieldId}" contenteditable="true" data-placeholder="Paste from your Word/PDF SOP, or type here..."></div>`;
}

// onAiAssist(fieldId) is provided by the page (not this module) since showing the suggestion
// and accepting/discarding it needs a modal that's specific to that page's layout - this
// module only knows about the field itself, not the surrounding UI.
export function wireRichTextToolbar(root = document, { onAiAssist } = {}) {
  root.querySelectorAll('[data-rt-toolbar]').forEach(toolbar => {
    const fieldId = toolbar.dataset.rtToolbar;
    toolbar.querySelectorAll('button[data-rt-cmd]').forEach(btn => {
      btn.onclick = () => {
        document.getElementById(fieldId)?.focus();
        document.execCommand(btn.dataset.rtCmd, false, btn.dataset.rtValue || null);
      };
    });
    toolbar.querySelectorAll('button[data-rt-ai]').forEach(btn => {
      btn.onclick = () => onAiAssist?.(fieldId);
    });
  });
}

export function getRichTextValue(fieldId) {
  return sanitizeRichHtml(document.getElementById(fieldId)?.innerHTML || '');
}

export function setRichTextValue(fieldId, html) {
  const el = document.getElementById(fieldId);
  if (el) el.innerHTML = sanitizeRichHtml(html || '');
}
