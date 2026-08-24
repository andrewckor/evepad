// The deploy commands, one place: the card's menu and the pty spawn must
// agree on what "production" and "preview" mean. The CLI prefix comes in —
// resolving it touches PATH, which is the caller's concern, not this one.

export type DeployTarget = "deploy" | "deploy-preview";

export function deployArgs(variant: DeployTarget, cli: readonly string[] = ["vercel"]): string[] {
  return [...cli, "deploy", ...(variant === "deploy" ? ["--prod"] : [])];
}

export const deployTermKey = (project: string, variant: DeployTarget): string =>
  `${project}:${variant}`;

export const isDeployVariant = (variant: string | null | undefined): variant is DeployTarget =>
  variant === "deploy" || variant === "deploy-preview";
