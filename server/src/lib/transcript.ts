// Whisper can return any writing system. Treat a transcript as meaningful when
// it contains at least one Unicode letter or number; punctuation/noise-only
// output is not useful as a subtitle cue.
export function isUsableTranscript(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : '';
  return !!text && /[\p{L}\p{N}]/u.test(text);
}
