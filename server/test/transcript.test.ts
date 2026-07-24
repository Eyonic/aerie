import assert from 'node:assert/strict';
import test from 'node:test';
import { isUsableTranscript } from '../src/lib/transcript.js';

test('subtitle transcript filtering accepts writing systems beyond Latin', () => {
  for (const text of [
    '日本語の字幕です',
    '这是中文字幕',
    'هذه ترجمة عربية',
    'Это русские субтитры',
    'คำบรรยายภาษาไทย',
    '123',
  ]) assert.equal(isUsableTranscript(text), true, text);
});

test('subtitle transcript filtering rejects empty and punctuation-only noise', () => {
  for (const text of ['', '   ', '…', '?! --', '♪♫']) assert.equal(isUsableTranscript(text), false, text);
  assert.equal(isUsableTranscript(null), false);
});
