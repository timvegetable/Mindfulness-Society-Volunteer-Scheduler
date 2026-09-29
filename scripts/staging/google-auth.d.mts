// Service-account access tokens for the staging scripts (see google-auth.mjs).
export declare function readServiceAccountKey(path: string): Promise<{ clientEmail: string; privateKey: string }>;
export declare function accessTokenFor(keyPath: string, scope?: string, nowMs?: () => number): Promise<string>;
