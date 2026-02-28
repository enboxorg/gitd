/**
 * CLI flag parsing tests — flagValue, hasFlag, and parsePort helpers.
 */
import { describe, expect, it } from 'bun:test';

import { flagValue } from '../src/cli/flags.js';
import { hasFlag } from '../src/cli/flags.js';
import { parsePort } from '../src/cli/flags.js';

// ---------------------------------------------------------------------------
// flagValue
// ---------------------------------------------------------------------------

describe('flagValue', () => {
  it('should return the value following a space-separated flag', () => {
    expect(flagValue(['--port', '8080'], '--port')).toBe('8080');
  });

  it('should return the value from an equals-separated flag', () => {
    expect(flagValue(['--port=8080'], '--port')).toBe('8080');
  });

  it('should return undefined when the flag is absent', () => {
    expect(flagValue(['--host', 'localhost'], '--port')).toBeUndefined();
  });

  it('should return undefined when the flag is last with no value', () => {
    expect(flagValue(['--port'], '--port')).toBeUndefined();
  });

  it('should handle empty equals value', () => {
    expect(flagValue(['--port='], '--port')).toBe('');
  });

  it('should return the first occurrence when flag appears multiple times', () => {
    expect(flagValue(['--port', '3000', '--port', '8080'], '--port')).toBe('3000');
  });

  it('should prefer space-separated if it appears before equals', () => {
    expect(flagValue(['--port', '3000', '--port=8080'], '--port')).toBe('3000');
  });

  it('should prefer equals if it appears before space-separated', () => {
    expect(flagValue(['--port=8080', '--port', '3000'], '--port')).toBe('8080');
  });

  it('should not match a flag that is a prefix of another', () => {
    expect(flagValue(['--port-name', '8080'], '--port')).toBeUndefined();
  });

  it('should not match equals form of a prefix flag', () => {
    expect(flagValue(['--port-name=8080'], '--port')).toBeUndefined();
  });

  it('should work with short flags', () => {
    expect(flagValue(['-p', '8080'], '-p')).toBe('8080');
  });

  it('should handle values that contain equals signs', () => {
    expect(flagValue(['--config=key=value'], '--config')).toBe('key=value');
  });

  it('should return undefined for an empty args array', () => {
    expect(flagValue([], '--port')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hasFlag
// ---------------------------------------------------------------------------

describe('hasFlag', () => {
  it('should return true when the flag is present', () => {
    expect(hasFlag(['--verbose', '--port', '8080'], '--verbose')).toBe(true);
  });

  it('should return false when the flag is absent', () => {
    expect(hasFlag(['--port', '8080'], '--verbose')).toBe(false);
  });

  it('should return false for an empty args array', () => {
    expect(hasFlag([], '--verbose')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parsePort
// ---------------------------------------------------------------------------

describe('parsePort', () => {
  it('should parse a valid port number', () => {
    expect(parsePort('8080')).toBe(8080);
  });

  it('should accept port 1 (minimum)', () => {
    expect(parsePort('1')).toBe(1);
  });

  it('should accept port 65535 (maximum)', () => {
    expect(parsePort('65535')).toBe(65535);
  });

  it('should exit on port 0', () => {
    const exit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number): never => { exitCode = code; throw new Error('exit'); }) as never;
    try {
      expect(() => parsePort('0')).toThrow('exit');
      expect(exitCode).toBe(1);
    } finally {
      process.exit = exit;
    }
  });

  it('should exit on port above 65535', () => {
    const exit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number): never => { exitCode = code; throw new Error('exit'); }) as never;
    try {
      expect(() => parsePort('99999')).toThrow('exit');
      expect(exitCode).toBe(1);
    } finally {
      process.exit = exit;
    }
  });

  it('should exit on non-numeric input', () => {
    const exit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number): never => { exitCode = code; throw new Error('exit'); }) as never;
    try {
      expect(() => parsePort('abc')).toThrow('exit');
      expect(exitCode).toBe(1);
    } finally {
      process.exit = exit;
    }
  });

  it('should exit on negative port', () => {
    const exit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number): never => { exitCode = code; throw new Error('exit'); }) as never;
    try {
      expect(() => parsePort('-1')).toThrow('exit');
      expect(exitCode).toBe(1);
    } finally {
      process.exit = exit;
    }
  });
});
