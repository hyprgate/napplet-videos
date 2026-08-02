import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Videos napplet manifest capabilities', () => {
  it('declares outbox because profile metadata uses outbox.query', () => {
    const source = readFileSync('vite.config.ts', 'utf8');
    expect(source).toContain("requires: ['relay', 'outbox', 'media', 'resource', 'theme']");
  });
});
