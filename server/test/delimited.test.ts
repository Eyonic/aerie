import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIMITED_LIMITS, parseDelimited } from '../src/lib/delimited.js';

test('CSV parser handles escaped quotes, delimiters, and newlines inside quoted cells', () => {
  assert.deepEqual(parseDelimited('name,notes\r\nAlice,"one, two"\r\nBob,"said ""hello""\nand left"\r\n', ','), [
    ['name', 'notes'],
    ['Alice', 'one, two'],
    ['Bob', 'said "hello"\nand left'],
  ]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
});

test('CSV parser rejects malformed or pathologically wide data', () => {
  assert.throws(() => parseDelimited('a,"unterminated', ','), (error: any) => error.message === 'invalid_csv' && error.status === 400);
  const tooWide = Array.from({ length: DELIMITED_LIMITS.maxColumns + 1 }, () => '').join(',');
  assert.throws(() => parseDelimited(tooWide, ','), (error: any) => error.message === 'spreadsheet_too_large' && error.status === 413);
});
