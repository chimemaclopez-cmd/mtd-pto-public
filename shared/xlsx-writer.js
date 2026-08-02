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
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="3">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="13"/><color rgb="FF1F3864"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="5">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFBDD7EE"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="5">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

const STYLE_TITLE = 1, STYLE_HEADER = 2, STYLE_BANDED = 3, STYLE_PLAIN = 4;

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
function computeColWidths(rows, colCount, skipRows) {
  const widths = new Array(colCount).fill(8);
  rows.forEach((row, r) => {
    if (skipRows.includes(r)) return;
    for (let c = 0; c < colCount; c++) {
      const value = row[c];
      if (value == null || value === '') continue;
      const text = typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value);
      if (text.length > widths[c]) widths[c] = text.length;
    }
  });
  return widths.map(w => Math.min(46, Math.max(9, w + 2)));
}

function sheetXml(sheet) {
  const rows = sheet.rows;
  const headerRows = Array.isArray(sheet.headerRowIndex) ? sheet.headerRowIndex : [sheet.headerRowIndex ?? 0];
  const titleRows = sheet.titleRowIndex == null ? [] : (Array.isArray(sheet.titleRowIndex) ? sheet.titleRowIndex : [sheet.titleRowIndex]);
  const colCount = Math.max(1, ...rows.map(row => row.length));
  const rowXml = rows.map((row, r) => {
    const style = styleForRow(r, { headerRows, titleRows });
    const cellCount = titleRows.includes(r) ? colCount : row.length;
    const cells = [];
    for (let c = 0; c < cellCount; c++) {
      const value = row[c];
      const ref = `${colLetter(c)}${r + 1}`;
      const styleAttr = style ? ` s="${style}"` : '';
      if (value == null || value === '') cells.push(`<c r="${ref}"${styleAttr}/>`);
      else if (typeof value === 'number' && Number.isFinite(value)) cells.push(`<c r="${ref}"${styleAttr}><v>${Math.round(value * 100) / 100}</v></c>`);
      else cells.push(`<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`);
    }
    const heightAttr = style === STYLE_HEADER ? ' ht="20" customHeight="1"' : '';
    return `<row r="${r + 1}"${heightAttr}>${cells.join('')}</row>`;
  }).join('');
  const merges = titleRows.length && colCount > 1
    ? `<mergeCells count="${titleRows.length}">${titleRows.map(tr => `<mergeCell ref="A${tr + 1}:${colLetter(colCount - 1)}${tr + 1}"/>`).join('')}</mergeCells>`
    : '';
  const colWidths = computeColWidths(rows, colCount, titleRows);
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
