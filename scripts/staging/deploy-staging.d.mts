// Types for the staging deploy tool, so the Node suite can pin the URL parser,
// the repeatable `--var` bindings and what the deployment report records.
export type DeployVariable = { name: string; value: string };

export type DeployOptions = {
  tokenFile: string;
  key: string;
  workbook?: string;
  environment: string;
  target: string;
  variables: DeployVariable[];
  report?: string;
  benchmarkEnabled?: boolean;
  confirm: boolean;
  plan: boolean;
  help?: boolean;
};

export declare function parseArguments(argv: string[]): DeployOptions;

export declare function parseVariable(argument: string, raw: string): DeployVariable;

export declare function deployVariables(options: DeployOptions, deployedAt: string): DeployVariable[];

export declare function deploymentReport(options: DeployOptions, context: {
  deployedAt: string;
  url?: string | null;
  serviceAccountEmail?: string | null;
}): {
  deployedAt: string;
  accountId: string;
  environment: string;
  target: string;
  workerUrl: string | null;
  execUrl?: string;
  benchmarkUrl?: string;
  serviceAccountEmail: string | null;
  workbookOverride: string | null;
  benchmarkEnabled: boolean;
  variables: DeployVariable[];
  sanitized: true;
};

export declare function deployedUrl(output: string): string | undefined;
