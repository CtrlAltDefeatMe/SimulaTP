// A small writer for Excel workbooks (.xlsx), so the browser can build the file without a library.
// A workbook is a zip of XML parts. The parts are stored uncompressed, which every spreadsheet program reads.
//
// xlsxWorkbook({ sheets: [{ name, columns, rows, freeze, merges, links }] }) returns the file as bytes.
// - columns: column widths in characters, left to right.
// - rows: one array of cells per row. A cell is a number, a string, null for empty,
//   or { value, style } where style is { bold, italic, size, color, fill, border, format, indent, wrap, align }.
// - freeze: { rows, columns } kept in view while scrolling.
// - merges: ranges such as 'B5:D5'.
// - links: [{ ref: 'A8', sheet: 'United States' }] jump to another sheet.
// Every sheet prints landscape, one page wide.

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const encoder = new TextEncoder();

// Excel's built-in number formats: whole numbers with commas, two decimals, a percent with two decimals.
const FORMATS = { whole: 3, cents: 4, percent: 10 };

function xml(value) {
  return String(value ?? '')
    // Characters XML does not allow are dropped.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function columnName(index) {
  let name = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    name = String.fromCharCode(65 + (number - 1) % 26) + name;
  }
  return name;
}

// A sheet name has at most 31 characters and none of : \ / ? * [ ].
export function sheetName(name) {
  return String(name).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
}

// Fonts, fills, borders and cell formats are listed once each and referred to by position.
function styleTable() {
  const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const formats = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const find = (list, entry) => {
    const found = list.indexOf(entry);
    return found >= 0 ? found : list.push(entry) - 1;
  };
  const font = ({ bold, italic, underline, size = 11, color = '1F2A3D' }) => find(fonts,
    `<font>${bold ? '<b/>' : ''}${italic ? '<i/>' : ''}${underline ? '<u/>' : ''}<sz val="${size}"/><color rgb="FF${color}"/><name val="Calibri"/><family val="2"/></font>`);
  font({});
  const index = (style) => {
    if (!style) return 0;
    const fontId = font(style);
    const fillId = style.fill ? find(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = where => style.border === where ? `<${where} style="thin"><color rgb="FFAFBDCF"/></${where}>` : `<${where}/>`;
    const borderId = style.border ? find(borders, `<border><left/><right/>${side('top')}${side('bottom')}<diagonal/></border>`) : 0;
    const numFmtId = FORMATS[style.format] ?? 0;
    // An indent shows only on text aligned to a side.
    const align = style.align ?? (style.indent ? 'left' : null);
    const alignment = style.indent || style.wrap || align
      ? `<alignment${align ? ` horizontal="${align}"` : ''}${style.wrap ? ' vertical="top" wrapText="1"' : ''}${style.indent ? ` indent="${style.indent}"` : ''}/>` : '';
    return find(formats, `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`
      + `${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}`
      + `${alignment ? ` applyAlignment="1">${alignment}</xf>` : '/>'}`);
  };
  const toXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${MAIN}">`
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
    + `<fills count="${fills.length}">${fills.join('')}</fills>`
    + `<borders count="${borders.length}">${borders.join('')}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${formats.length}">${formats.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';
  return { index, toXml };
}

function cellXml(cell, ref, styles) {
  if (cell === null || cell === undefined) return '';
  const { value, style } = typeof cell === 'object' ? cell : { value: cell };
  const s = styles.index(style);
  const styled = s ? ` s="${s}"` : '';
  if (typeof value === 'number') {
    // A number that cannot be shown, such as a margin on no revenue, leaves the cell empty.
    return Number.isFinite(value) ? `<c r="${ref}"${styled}><v>${value}</v></c>` : (s ? `<c r="${ref}"${styled}/>` : '');
  }
  if (value === null || value === undefined || value === '') return s ? `<c r="${ref}"${styled}/>` : '';
  return `<c r="${ref}"${styled} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function sheetXml(sheet, styles, selected) {
  const { columns = [], rows = [], freeze, merges = [], links = [] } = sheet;
  let view = `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}`;
  if (freeze && (freeze.rows || freeze.columns)) {
    const pane = freeze.rows && freeze.columns ? 'bottomRight' : freeze.rows ? 'bottomLeft' : 'topRight';
    const topLeft = `${columnName(freeze.columns ?? 0)}${(freeze.rows ?? 0) + 1}`;
    view += `><pane${freeze.columns ? ` xSplit="${freeze.columns}"` : ''}${freeze.rows ? ` ySplit="${freeze.rows}"` : ''} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/><selection pane="${pane}"/></sheetView>`;
  } else {
    view += '/>';
  }
  const cols = columns.length
    ? `<cols>${columns.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>` : '';
  const data = rows.map((cells, rowIndex) => {
    const body = (cells ?? []).map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${rowIndex + 1}`, styles)).join('');
    return body ? `<row r="${rowIndex + 1}">${body}</row>` : '';
  }).join('');
  const merged = merges.length ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : '';
  const linked = links.length
    ? `<hyperlinks>${links.map(({ ref, sheet: target }) => `<hyperlink ref="${ref}" location="${xml(`'${target.replaceAll("'", "''")}'!A1`)}" display="${xml(target)}"/>`).join('')}</hyperlinks>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData>${merged}${linked}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

export function xlsxWorkbook({ sheets, created = new Date() }) {
  const styles = styleTable();
  const names = [];
  for (const sheet of sheets) {
    let name = sheetName(sheet.name);
    // Sheet names must differ, ignoring case.
    for (let copy = 2; names.some(taken => taken.toLowerCase() === name.toLowerCase()); copy += 1) name = `${sheetName(sheet.name).slice(0, 27)} (${copy})`;
    names.push(name);
  }
  const parts = sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet, styles, index === 0)]);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL}">${names.map((name, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${parts.map(([path]) => `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  // Styles are written last: the sheets above register the styles they use.
  return zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ...parts,
    ['xl/styles.xml', styles.toXml()],
  ], created);
}

// --- Zip, entries stored without compression ---

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zip(files, created) {
  const time = (created.getHours() << 11) | (created.getMinutes() << 5) | Math.floor(created.getSeconds() / 2);
  const date = ((Math.max(created.getFullYear(), 1980) - 1980) << 9) | ((created.getMonth() + 1) << 5) | created.getDate();
  const entries = files.map(([name, text]) => {
    const data = encoder.encode(text);
    return { name: encoder.encode(name), data, crc: crc32(data) };
  });
  const localSize = entries.reduce((total, entry) => total + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = entries.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const header = (signature, entry, central, offset) => {
    view.setUint32(at, signature, true); at += 4;
    if (central) { view.setUint16(at, 20, true); at += 2; } // made by
    view.setUint16(at, 20, true); at += 2; // version needed
    view.setUint16(at, 0x0800, true); at += 2; // names are UTF-8
    view.setUint16(at, 0, true); at += 2; // stored
    view.setUint16(at, time, true); at += 2;
    view.setUint16(at, date, true); at += 2;
    view.setUint32(at, entry.crc, true); at += 4;
    view.setUint32(at, entry.data.length, true); at += 4;
    view.setUint32(at, entry.data.length, true); at += 4;
    view.setUint16(at, entry.name.length, true); at += 2;
    view.setUint16(at, 0, true); at += 2; // extra
    if (central) {
      view.setUint16(at, 0, true); at += 2; // comment
      view.setUint16(at, 0, true); at += 2; // disk
      view.setUint16(at, 0, true); at += 2; // internal attributes
      view.setUint32(at, 0, true); at += 4; // external attributes
      view.setUint32(at, offset, true); at += 4;
    }
    out.set(entry.name, at); at += entry.name.length;
  };
  const offsets = [];
  for (const entry of entries) {
    offsets.push(at);
    header(0x04034B50, entry, false);
    out.set(entry.data, at); at += entry.data.length;
  }
  const centralStart = at;
  entries.forEach((entry, index) => header(0x02014B50, entry, true, offsets[index]));
  view.setUint32(at, 0x06054B50, true); at += 4;
  view.setUint16(at, 0, true); at += 2;
  view.setUint16(at, 0, true); at += 2;
  view.setUint16(at, entries.length, true); at += 2;
  view.setUint16(at, entries.length, true); at += 2;
  view.setUint32(at, centralSize, true); at += 4;
  view.setUint32(at, centralStart, true); at += 4;
  view.setUint16(at, 0, true);
  return out;
}
