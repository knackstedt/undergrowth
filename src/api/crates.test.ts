import { describe, expect, it } from 'vitest';
import { resolveCargoVersion } from './crates';

describe('resolveCargoVersion', () => {
    const versions = ['0.1.0', '0.2.3', '0.2.9', '0.3.0', '1.0.0', '1.2.0', '1.9.0', '2.0.0'];

    it('returns the latest version for wildcard/empty requirements', () => {
        expect(resolveCargoVersion('*', versions)).toBe('2.0.0');
        expect(resolveCargoVersion('', versions)).toBe('2.0.0');
        expect(resolveCargoVersion('latest', versions)).toBe('2.0.0');
    });

    it('treats bare versions as caret requirements (Cargo semantics)', () => {
        // "1.2" means ^1.2 -> max satisfying is 1.9.0, not 1.2.0
        expect(resolveCargoVersion('1.2', versions)).toBe('1.9.0');
        // "1.0" -> ^1.0 -> 1.9.0
        expect(resolveCargoVersion('1.0', versions)).toBe('1.9.0');
    });

    it('pins 0.x caret requirements to the same minor (Cargo 0.x rule)', () => {
        // ^0.2 must NOT match 0.3.0 — Cargo caret on 0.x is stricter
        expect(resolveCargoVersion('0.2', versions)).toBe('0.2.9');
        expect(resolveCargoVersion('^0.2', versions)).toBe('0.2.9');
        expect(resolveCargoVersion('0.1', versions)).toBe('0.1.0');
    });

    it('resolves >= requirements to the maximum, not minimum', () => {
        // The old bug returned the lowest satisfying version
        expect(resolveCargoVersion('>=1.0.0', versions)).toBe('2.0.0');
        expect(resolveCargoVersion('>=1.0.0, <2.0.0', versions)).toBe('1.9.0');
    });

    it('handles = exact pins', () => {
        expect(resolveCargoVersion('=1.2.0', versions)).toBe('1.2.0');
    });

    it('handles ~ tilde requirements', () => {
        expect(resolveCargoVersion('~1.2.0', versions)).toBe('1.2.0');
    });

    it('handles compound comma-separated clauses', () => {
        expect(resolveCargoVersion('>=0.2.0,<0.3.0', versions)).toBe('0.2.9');
    });

    it('returns an existing fully-qualified version directly', () => {
        expect(resolveCargoVersion('1.0.0', versions)).toBe('1.0.0');
    });

    it('falls back to latest when nothing satisfies', () => {
        expect(resolveCargoVersion('>=99.0.0', versions)).toBe('2.0.0');
    });
});
