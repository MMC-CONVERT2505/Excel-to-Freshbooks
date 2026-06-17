// @ts-ignore — xlsx-js-style has no bundled type declarations
import XLSXStyle from 'xlsx-js-style';
import type { TplCol } from '../data/entities';

const REQ_FILL  = { fgColor: { rgb: 'FFF2CC' } }; // soft amber
const REQ_FONT  = { bold: true,  color: { rgb: '7C5E00' } };
const OPT_FILL  = { fgColor: { rgb: 'F2F2F2' } }; // light grey
const OPT_FONT  = { bold: false, color: { rgb: '595959' } };
const EX_FONT   = { italic: true, color: { rgb: '8C8C8C' } };

const BORDER = {
  top:    { style: 'thin', color: { rgb: 'D0D0D0' } },
  bottom: { style: 'thin', color: { rgb: 'D0D0D0' } },
  left:   { style: 'thin', color: { rgb: 'D0D0D0' } },
  right:  { style: 'thin', color: { rgb: 'D0D0D0' } },
};

export function buildStyledSheet(cols: TplCol[], sheetName: string): unknown {
  const headers  = cols.map(c => c.col);
  const examples = cols.map(c => c.ex);

  const ws = XLSXStyle.utils.aoa_to_sheet([headers, examples]);
  ws['!cols'] = cols.map(() => ({ wch: 24 }));

  // Style header row (row 0)
  cols.forEach((c, i) => {
    const addr = XLSXStyle.utils.encode_cell({ r: 0, c: i });
    if (!ws[addr]) return;
    ws[addr].s = {
      fill:   c.req ? REQ_FILL  : OPT_FILL,
      font:   c.req ? REQ_FONT  : OPT_FONT,
      border: BORDER,
      alignment: { horizontal: 'left', vertical: 'center', wrapText: false },
    };
  });

  // Style example row (row 1)
  cols.forEach((_c, i) => {
    const addr = XLSXStyle.utils.encode_cell({ r: 1, c: i });
    if (!ws[addr]) return;
    ws[addr].s = {
      font:   EX_FONT,
      border: BORDER,
      alignment: { horizontal: 'left', vertical: 'center' },
    };
  });

  // Add a legend row (row 2)
  const legendAddr = XLSXStyle.utils.encode_cell({ r: 2, c: 0 });
  ws[legendAddr] = {
    v: '* Yellow = Required   |   Grey = Optional',
    t: 's',
    s: { font: { italic: true, color: { rgb: 'A0A0A0' }, sz: 9 } },
  };
  // Expand the ref range to include the legend row
  const range = XLSXStyle.utils.decode_range(ws['!ref']);
  if (range.e.r < 2) range.e.r = 2;
  ws['!ref'] = XLSXStyle.utils.encode_range(range);

  return ws;
}

export function downloadStyledTemplate(cols: TplCol[], fileName: string, sheetName: string): void {
  const ws = buildStyledSheet(cols, sheetName);
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSXStyle.writeFile(wb, fileName);
}

export function downloadAllStyledTemplates(
  sheets: Array<{ cols: TplCol[]; sheetName: string }>,
  fileName: string,
): void {
  const wb = XLSXStyle.utils.book_new();
  sheets.forEach(({ cols, sheetName }) => {
    const ws = buildStyledSheet(cols, sheetName);
    XLSXStyle.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  });
  XLSXStyle.writeFile(wb, fileName);
}
