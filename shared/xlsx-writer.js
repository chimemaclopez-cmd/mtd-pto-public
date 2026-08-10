// Minimal .xlsx (Office Open XML) writer, browser-side, zero dependencies.
// An .xlsx is just a ZIP of XML parts - we build the ZIP as STORE-only (no
// compression), which needs nothing more than CRC32 and careful byte layout.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function textBytes(str) { return new TextEncoder().encode(str); }

function zip(files) {
  // files: [{name, data: Uint8Array}]
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = textBytes(file.name), data = file.data, crc = crc32(data), size = data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(eocd.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function escXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function colLetter(index) {
  let n = index + 1, s = '';
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Fixed style palette (cellXfs indices below match this order exactly):
//   0 default · 1 title band (navy fill, bold white, merged across the header width)
//   2 header row (light-blue fill, bold) · 3 banded data row (very light blue fill) · 4 plain data row
//   5 highlighted header (green fill, bold white) · 6 highlighted data (light-green fill, bold dark green)
//   7 component header (gold fill, bold white) · 8 component data (light-gold fill, bold brown)
// 5/6 call out THE final number (e.g. Final KPI); 7/8 call out the individual weighted scores
// that sum into it (e.g. CSAT Points, Calls Points) - two tiers so the sheet reads at a glance
// as "these feed into that", not just one flat "important columns" treatment.
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="6">` +
  `<font><sz val="11"/><name val="Arial"/></font>` +
  `<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>` +
  `<font><b/><sz val="13"/><color rgb="FF1F3864"/><name val="Arial"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FF375623"/><name val="Arial"/></font>` +
  `<font><b/><sz val="13"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FF7F6000"/><name val="Arial"/></font>` +
  `</fonts>` +
  `<fills count="9">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFBDD7EE"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFC6E0B4"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF548235"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFBF8F00"/><bgColor indexed="64"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="9">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="3" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="4" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="5" fillId="7" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="4" fillId="8" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

const STYLE_TITLE = 1, STYLE_HEADER = 2, STYLE_BANDED = 3, STYLE_PLAIN = 4, STYLE_HIGHLIGHT_DATA = 5, STYLE_HIGHLIGHT_HEADER = 6, STYLE_COMPONENT_DATA = 7, STYLE_COMPONENT_HEADER = 8;

// sheet: {name, rows, headerRowIndex=0, titleRowIndex=null}
// headerRowIndex/titleRowIndex each accept either a single row number or an array of row
// numbers - the array form lets one sheet hold several stacked blocks (e.g. one per KPI
// type), each with its own title band and header row; banded-row shading restarts after
// each header so every block reads as its own mini-table.
// Rows before the first header (other than a title row) render unstyled (style 0) - e.g.
// the "Period"/"Generated" meta lines some tabs print above their header row.
function styleForRow(r, { headerRows, titleRows }) {
  if (titleRows.includes(r)) return STYLE_TITLE;
  if (headerRows.includes(r)) return STYLE_HEADER;
  let nearestHeader = -1;
  for (const h of headerRows) if (h < r && h > nearestHeader) nearestHeader = h;
  if (nearestHeader < 0) return 0;
  return (r - nearestHeader) % 2 === 1 ? STYLE_BANDED : STYLE_PLAIN;
}

// Column widths are sized from the actual content (title/merge rows excluded, since those
// overflow across the merge rather than needing column A itself to be wide) - this is what
// makes a hand-built sheet read as deliberately formatted instead of one flat 20-wide grid.
// Header text renders bold at 13pt, noticeably wider per character than the 11pt regular data
// font a plain character count assumes - without the 1.25x cushion below, a header sized to
// "just fit" its own text at the data font's metrics wraps in Excel anyway, and at the fixed
// header row height that wrap clips instead of just wrapping cleanly.
function computeColWidths(rows, colCount, skipRows, headerRows = []) {
  const widths = new Array(colCount).fill(8);
  rows.forEach((row, r) => {
    if (skipRows.includes(r)) return;
    const isHeader = headerRows.includes(r);
    for (let c = 0; c < colCount; c++) {
      const value = row[c];
      if (value == null || value === '') continue;
      const text = typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value);
      const effectiveLength = isHeader ? text.length * 1.25 : text.length;
      if (effectiveLength > widths[c]) widths[c] = effectiveLength;
    }
  });
  return widths.map(w => Math.min(46, Math.max(9, Math.ceil(w) + 2)));
}

function sheetXml(sheet) {
  const rows = sheet.rows;
  const headerRows = Array.isArray(sheet.headerRowIndex) ? sheet.headerRowIndex : [sheet.headerRowIndex ?? 0];
  const titleRows = sheet.titleRowIndex == null ? [] : (Array.isArray(sheet.titleRowIndex) ? sheet.titleRowIndex : [sheet.titleRowIndex]);
  const highlightCols = new Set(sheet.highlightCols || []);
  const componentCols = new Set(sheet.componentCols || []);
  const colCount = Math.max(1, ...rows.map(row => row.length));
  const rowXml = rows.map((row, r) => {
    const baseStyle = styleForRow(r, { headerRows, titleRows });
    const isTitleRow = titleRows.includes(r), isHeaderRow = headerRows.includes(r);
    const cellCount = isTitleRow ? colCount : row.length;
    const cells = [];
    for (let c = 0; c < cellCount; c++) {
      const value = row[c];
      const ref = `${colLetter(c)}${r + 1}`;
      // highlightCols (e.g. Final KPI) and componentCols (the individual weighted scores that
      // sum into it, e.g. CSAT Points) each override the row's own header/banded/plain style
      // so they read consistently down their whole column - highlight wins if a column were
      // ever in both, since the final number is the stronger call-out of the two.
      const style = !isTitleRow && highlightCols.has(c) ? (isHeaderRow ? STYLE_HIGHLIGHT_HEADER : STYLE_HIGHLIGHT_DATA)
        : !isTitleRow && componentCols.has(c) ? (isHeaderRow ? STYLE_COMPONENT_HEADER : STYLE_COMPONENT_DATA)
        : baseStyle;
      const styleAttr = style ? ` s="${style}"` : '';
      if (value == null || value === '') cells.push(`<c r="${ref}"${styleAttr}/>`);
      else if (typeof value === 'number' && Number.isFinite(value)) cells.push(`<c r="${ref}"${styleAttr}><v>${Math.round(value * 100) / 100}</v></c>`);
      else cells.push(`<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`);
    }
    const heightAttr = (baseStyle === STYLE_HEADER || isHeaderRow) ? ' ht="32" customHeight="1"' : '';
    return `<row r="${r + 1}"${heightAttr}>${cells.join('')}</row>`;
  }).join('');
  const merges = titleRows.length && colCount > 1
    ? `<mergeCells count="${titleRows.length}">${titleRows.map(tr => `<mergeCell ref="A${tr + 1}:${colLetter(colCount - 1)}${tr + 1}"/>`).join('')}</mergeCells>`
    : '';
  const colWidths = computeColWidths(rows, colCount, titleRows, headerRows);
  const cols = `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const freezeAt = headerRows.length ? Math.min(...headerRows) : null;
  const sheetViews = freezeAt != null
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeAt + 1}" topLeftCell="A${freezeAt + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetViews}<sheetFormatPr defaultColWidth="12" defaultRowHeight="15"/>${cols}<sheetData>${rowXml}</sheetData>${merges}</worksheet>`;
}

// sheets: [{name, rows, headerRowIndex=0, titleRowIndex=null}] where rows[headerRowIndex] is the header row.
export function buildXlsxBlob(sheets) {
  const files = [];
  files.push({ name: '[Content_Types].xml', data: textBytes(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `</Types>`
  )});
  files.push({ name: '_rels/.rels', data: textBytes(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  )});
  files.push({ name: 'xl/workbook.xml', data: textBytes(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets.map((s, i) => `<sheet name="${escXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 2}"/>`).join('')}</sheets>` +
    `</workbook>`
  )});
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: textBytes(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `</Relationships>`
  )});
  files.push({ name: 'xl/styles.xml', data: textBytes(STYLES_XML) });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: textBytes(sheetXml(s)) }));
  return zip(files);
}

export function downloadXlsx(filename, sheets) {
  const blob = buildXlsxBlob(sheets);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
