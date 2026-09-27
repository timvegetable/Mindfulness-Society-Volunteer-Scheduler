// Types for the staging probe host.
export declare function createProbeServer(options?: { port?: number; stagingDirectory?: string }): { server: import("node:http").Server; port: number; stagingDirectory: string };
