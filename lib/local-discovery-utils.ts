import { isAgentName } from "./agent-name.ts";

export type PackageJson = {
  name?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export function isEveAgentPackage(pkg: PackageJson): boolean {
  return Boolean(pkg.dependencies?.eve || pkg.devDependencies?.eve);
}

export function discoveredAgentName(
  pkg: PackageJson,
  folderName: string,
  linkedName?: unknown,
): string | null {
  for (const value of [linkedName, pkg.name, folderName])
    if (typeof value === "string" && isAgentName(value)) return value;
  return null;
}
