export interface ParsedInput {
    type: 'npm' | 'git' | 'file';
    identifier: string; // package name or git URL or file content
    version?: string;
}

export function parseInput(input: string): ParsedInput {
    input = input.trim();

    // Handle npmjs.com URLs
    if (input.includes('npmjs.com/package/')) {
        const match = input.match(/npmjs\.com\/package\/([^/]+(?:\/[^/]+)?)/);
        if (match && match[1]) {
            // match[1] might be react or @types/react
            let pkg = match[1];
            // strip version from end of URL if present (e.g. /v/1.0.0)
            if (pkg.includes('/v/')) {
                pkg = pkg.split('/v/')[0];
            }
            return { type: 'npm', identifier: pkg };
        }
    }

    // Handle github/gitlab URLs
    if (input.startsWith('http') && (input.includes('github.com') || input.includes('gitlab.com'))) {
        return { type: 'git', identifier: input };
    }

    // Otherwise, assume it's a direct package name (e.g., react, @xyflow/react, lodash@4.17.21)
    let version;
    let identifier = input;

    // Handle scoped packages with versions e.g., @types/react@18
    if (identifier.startsWith('@')) {
        const parts = identifier.split('@');
        if (parts.length > 2) { // @scope/pkg@version
            version = parts.pop();
            identifier = parts.join('@');
        }
    } else if (identifier.includes('@')) {
        const parts = identifier.split('@');
        version = parts[1];
        identifier = parts[0];
    }

    return { type: 'npm', identifier, version };
}
