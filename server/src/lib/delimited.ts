export const DELIMITED_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 2_000,
  maxCells: 500_000,
} as const;

export function parseDelimited(raw: string, delimiter: ',' | '\t'): string[][] {
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cells = 0;
  const tooLarge = () => Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
  const pushCell = () => {
    row.push(cell);
    cell = '';
    cells++;
    if (row.length > DELIMITED_LIMITS.maxColumns || cells > DELIMITED_LIMITS.maxCells) throw tooLarge();
  };
  const pushRow = () => {
    pushCell();
    grid.push(row);
    row = [];
    if (grid.length > DELIMITED_LIMITS.maxRows) throw tooLarge();
  };
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quoted) {
      if (char === '"' && raw[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === delimiter) pushCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && raw[index + 1] === '\n') index++;
      pushRow();
    } else cell += char;
  }
  if (quoted) throw Object.assign(new Error('invalid_csv'), { status: 400 });
  if (cell || row.length || !grid.length) pushRow();
  return grid;
}
