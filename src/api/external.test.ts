import { describe, expect, it } from 'vitest';
import { extractGithubRepo } from './external';

describe('extractGithubRepo', () => {
    it('parses standard https URLs', () => {
        expect(extractGithubRepo('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('strips .git suffix and git+ prefix', () => {
        expect(extractGithubRepo('git+https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
        expect(extractGithubRepo('git://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses shorthand and ssh-style URLs', () => {
        expect(extractGithubRepo('github:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
        expect(extractGithubRepo('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('ignores extra path segments and fragments', () => {
        expect(extractGithubRepo('https://github.com/owner/repo/tree/main#readme')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('returns null for non-GitHub and empty URLs', () => {
        expect(extractGithubRepo('https://gitlab.com/owner/repo')).toBeNull();
        expect(extractGithubRepo(undefined)).toBeNull();
        expect(extractGithubRepo('')).toBeNull();
    });
});
