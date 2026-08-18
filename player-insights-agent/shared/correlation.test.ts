import { describe, expect, it } from 'vitest';

import { CORRELATION_HEADER, CORRELATION_PREFIX, mintCorrelationId, usableCorrelationId } from './correlation';

describe('mintCorrelationId', () => {
  it('mints a value it will accept back', () => {
    const id = mintCorrelationId();
    expect(usableCorrelationId(id)).toBe(id);
  });

  it('mints a different value every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintCorrelationId()));
    expect(ids.size).toBe(50);
  });

  it('is prefixed, so a log line carrying platform ids too stays readable', () => {
    expect(mintCorrelationId().startsWith(CORRELATION_PREFIX)).toBe(true);
  });
});

describe('usableCorrelationId', () => {
  it('accepts a well-formed id, trimming the whitespace a header picks up', () => {
    const id = 'req-deadbeef-0000-4000-8000-000000000001';
    expect(usableCorrelationId(` ${id} `)).toBe(id);
  });

  it.each([
    ['no prefix', 'deadbeef-0000-4000-8000-000000000001'],
    ['the wrong prefix', 'run-deadbeef-0000-4000-8000-000000000001'],
    ['uppercase hex', 'req-DEADBEEF-0000-4000-8000-000000000001'],
    ['a short group', 'req-deadbeef-0000-4000-8000-00000000001'],
    ['a trailing suffix', 'req-deadbeef-0000-4000-8000-000000000001-2'],
    ['empty', ''],
  ])('refuses %s', (_case, value) => {
    expect(usableCorrelationId(value)).toBeNull();
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an array, which is what a repeated header arrives as', ['req-deadbeef-0000-4000-8000-000000000001']],
    ['an object', { id: 'req-deadbeef-0000-4000-8000-000000000001' }],
  ])('refuses %s rather than coercing it', (_case, value) => {
    expect(usableCorrelationId(value)).toBeNull();
  });

  /**
   * The reason the shape is checked at all. Each of these would be printed into
   * a server log line and stored in a column if the value were taken on trust.
   */
  it.each([
    ['a newline, which forges a second log line', 'req-deadbeef-0000-4000-8000-000000000001\n[identity] REFUSED'],
    ['a question, which is the one thing traces must not carry', 'req-which players churned in June'],
    ['a quote, for anything that builds a string', `req-x' OR '1'='1`],
    ['a very long value', `req-${'a'.repeat(5000)}`],
  ])('refuses %s', (_case, value) => {
    expect(usableCorrelationId(value)).toBeNull();
  });
});

describe('CORRELATION_HEADER', () => {
  it('is lowercase, because that is how Node presents a request header', () => {
    expect(CORRELATION_HEADER).toBe(CORRELATION_HEADER.toLowerCase());
  });

  it('is app-specific, so the Apps proxy has no reason to rewrite it', () => {
    expect(CORRELATION_HEADER).toContain('pia');
  });
});
