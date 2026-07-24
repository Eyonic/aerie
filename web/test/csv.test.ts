import { describe, expect, it } from 'vitest';
import { clipboardTextToGrid, csvToGrid, gridToCsv, tsvToGrid } from '../src/lib/csv';

describe('CSV recovery round-tripping', () => {
  it('round-trips commas, quotes, line endings, and empty cells', () => {
    const grid = [
      ['plain', 'comma,value', 'say "hello"', 'line\nfeed'],
      ['carriage\rreturn', 'windows\r\nline', '', 'tail'],
    ];

    expect(csvToGrid(gridToCsv(grid))).toEqual(grid);
  });

  it('accepts a UTF-8 BOM and all common record separators', () => {
    expect(csvToGrid('\ufeffa,b\r\nc,d\re,f\ng,h\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('preserves newlines inside quoted fields', () => {
    expect(csvToGrid('"one\r\ntwo",three')).toEqual([['one\r\ntwo', 'three']]);
  });

  it('rejects unterminated and structurally invalid quoted fields', () => {
    expect(() => csvToGrid('"unfinished')).toThrow('invalid_csv');
    expect(() => csvToGrid('"closed"trailing')).toThrow('invalid_csv');
    expect(() => csvToGrid('unquoted"quote')).toThrow('invalid_csv');
  });

  it('parses spreadsheet clipboard TSV including quoted tabs and newlines', () => {
    expect(tsvToGrid('Name\tValue\r\nAlpha\t1\r\n"two\tparts"\t"line\nvalue"')).toEqual([
      ['Name', 'Value'],
      ['Alpha', '1'],
      ['two\tparts', 'line\nvalue'],
    ]);
  });

  it('chooses TSV for spreadsheet clipboard data and CSV as a fallback', () => {
    expect(clipboardTextToGrid('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(clipboardTextToGrid('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});
