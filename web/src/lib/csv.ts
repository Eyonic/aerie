/**
 * Encode a grid as RFC 4180-style CSV. Newlines inside fields are preserved,
 * and both LF and CR cause the field to be quoted.
 */
export function gridToCsv(grid: string[][]): string {
  return grid.map(row => row.map(cell => {
    if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
    return cell;
  }).join(',')).join('\n');
}

/**
 * Parse comma-separated CSV without silently accepting malformed quoting.
 * A final record separator does not create an extra empty row. Row widths are
 * deliberately left untouched; the spreadsheet editor normalizes them later.
 */
function delimitedToGrid(input: string, delimiter: ',' | '\t'): string[][] {
  const value = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;

  const finishField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === '"') {
        if (value[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (afterQuote) {
      if (ch === delimiter) finishField();
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && value[i + 1] === '\n') i++;
        finishRow();
      } else {
        throw new Error('invalid_csv');
      }
      continue;
    }

    if (ch === '"') {
      if (field !== '') throw new Error('invalid_csv');
      quoted = true;
    } else if (ch === delimiter) {
      finishField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && value[i + 1] === '\n') i++;
      finishRow();
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error('invalid_csv');
  if (field !== '' || row.length || afterQuote || rows.length === 0) finishRow();
  return rows;
}

export function csvToGrid(input: string): string[][] {
  return delimitedToGrid(input, ',');
}

/** Parse the tab-delimited text emitted by spreadsheet clipboard formats. */
export function tsvToGrid(input: string): string[][] {
  return delimitedToGrid(input, '\t');
}

/**
 * Turn text/plain clipboard data into cells. Spreadsheet apps use tabs; CSV is
 * accepted as a practical fallback for data copied from text tools.
 */
export function clipboardTextToGrid(input: string): string[][] {
  return input.includes('\t') ? tsvToGrid(input) : csvToGrid(input);
}
