// Types for the staging deploy tool, so the Node suite can pin the URL parser.
export declare function deployedUrl(output: string): string | undefined;
export declare function parseArguments(argv: string[]): Record<string, unknown>;
