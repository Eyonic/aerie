import { describe, expect, it } from 'vitest';
import { normalizeInternalRoute } from '../src/lib/internal-route';

const ORIGIN = 'https://cloud.example.test:8443';

describe('normalizeInternalRoute', () => {
  it('accepts and normalizes root-relative application routes', () => {
    expect(normalizeInternalRoute('/tv/../movies?item=42#details', ORIGIN))
      .toBe('/movies?item=42#details');
    expect(normalizeInternalRoute('/', ORIGIN)).toBe('/');
    expect(normalizeInternalRoute('/search?q=100%25', ORIGIN)).toBe('/search?q=100%25');
  });

  it('accepts an absolute URL only when its origin matches exactly', () => {
    expect(normalizeInternalRoute(`${ORIGIN}/jobs?state=failed`, ORIGIN))
      .toBe('/jobs?state=failed');
    expect(normalizeInternalRoute('https://cloud.example.test/jobs', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute('https://other.example.test:8443/jobs', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute('http://cloud.example.test:8443/jobs', ORIGIN)).toBeNull();
  });

  it('rejects network-path, relative and non-http navigation targets', () => {
    expect(normalizeInternalRoute('//evil.example/jobs', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute('//cloud.example.test:8443/jobs', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute('jobs', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute('?tab=jobs', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute('javascript:alert(1)', ORIGIN)).toBeNull();
  });

  it.each([
    '/\\evil.example/jobs',
    '/safe\\..\\admin',
    '/%2fevil.example/jobs',
    '/%2Fevil.example/jobs',
    '/%5cevil.example/jobs',
    '/next?to=%2f%2fevil.example',
    '/%252f%252fevil.example/jobs',
    '/%255cevil.example/jobs',
  ])('rejects raw, encoded and nested-encoded separators: %s', value => {
    expect(normalizeInternalRoute(value, ORIGIN)).toBeNull();
  });

  it.each([
    '/jobs\n/admin',
    '/jobs\u0085admin',
    '/jobs%00admin',
    '/jobs%0aadmin',
    '/jobs%C2%85admin',
    '/jobs%250dadmin',
  ])('rejects raw and encoded control characters: %s', value => {
    expect(normalizeInternalRoute(value, ORIGIN)).toBeNull();
  });

  it('rejects malformed, excessive, padded and oversized input', () => {
    expect(normalizeInternalRoute('/jobs%', ORIGIN)).toBeNull();
    let excessivelyEncodedSeparator = '%2f';
    for (let depth = 0; depth < 9; depth += 1) excessivelyEncodedSeparator = encodeURIComponent(excessivelyEncodedSeparator);
    expect(normalizeInternalRoute(`/jobs?next=${excessivelyEncodedSeparator}`, ORIGIN)).toBeNull();
    expect(normalizeInternalRoute(' /jobs', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute('/jobs ', ORIGIN)).toBeNull();
    expect(normalizeInternalRoute(`/${'a'.repeat(2048)}`, ORIGIN)).toBeNull();
  });
});
