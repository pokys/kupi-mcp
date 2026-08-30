import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLocality, loadConfig } from '../src/config.js';

/**
 * Cleared before as well as after each test: the real environment may already hold
 * KUPI_LOCALITIES, and a test that silently reads the operator's own configuration is
 * both testing the wrong thing and liable to print their locality IDs into a CI log.
 */
beforeEach(() => {
  delete process.env.KUPI_LOCALITIES;
});

afterEach(() => {
  delete process.env.KUPI_LOCALITIES;
});

describe('configured localities', () => {
  it('defaults to none', () => {
    expect(loadConfig().localities).toEqual([]);
  });

  it('parses several localities with an optional sublocality', () => {
    process.env.KUPI_LOCALITIES = 'Testov:11:12, Tretimesto:31';
    expect(loadConfig().localities).toEqual([
      { label: 'Testov', id: '11', sublocalityId: '12' },
      { label: 'Tretimesto', id: '31', sublocalityId: null },
    ]);
  });

  it('rejects malformed entries instead of silently dropping them', () => {
    process.env.KUPI_LOCALITIES = 'Testov';
    expect(() => loadConfig()).toThrow(/must be "Label:id"/u);

    process.env.KUPI_LOCALITIES = 'Testov:not-a-number';
    expect(() => loadConfig()).toThrow(/numeric IDs/u);

    process.env.KUPI_LOCALITIES = 'Testov:1, testov:2';
    expect(() => loadConfig()).toThrow(/repeats the label/u);
  });

  it('never guesses a locality it was not given', () => {
    process.env.KUPI_LOCALITIES = 'Testov:11';
    const config = loadConfig();
    expect(findLocality(config, 'TESTOV')?.id).toBe('11');
    expect(findLocality(config, 'Jine mesto')).toBeNull();
    expect(findLocality(config, undefined)).toBeNull();
  });
});
