// The domain model, shared by lib, the API routes and the UI. Wire shapes the
// SDKs own are derived from them, not redeclared.

import type { AnalyticsRun } from "@workflow/world";

// A running `eve dev` server found by the port scan.
export type LocalServer = {
  port: number;
  url: string;
  agentName: string;
  model: string | null;
  projectRoot: string | null;
  vercelProjectId: string | null;
  vercelOrgId: string | null;
  vercelProjectName: string | null;
};

// Where a project entry came from: the Vercel API, a live local server with
// no Vercel link, or the on-disk registry of previously-seen checkouts.
export type ProjectSource = "vercel" | "local" | "registry";

export type Project = {
  id: string | null;
  name: string;
  accountId?: string | null;
  framework: string | null;
  productionUrl: string | null;
  avatarUrl?: string | null;
  iconUrl?: string | null;
  updatedAt: number | null;
  source: ProjectSource;
  live: boolean;
  localPath: string | null;
  localUrl: string | null;
  localPort: number | null;
  agentName: string | null;
  model: string | null;
};

export type Environment = "local" | "preview" | "production";

export type RunStatus = AnalyticsRun["status"];

// One raw run record. The analytics client returns AnalyticsRun (dates as
// Date objects); the local .eve store holds the same record as written JSON
// (dates as ISO strings) — so the date fields are the honest union, and
// everything else comes straight from the SDK's type.
export type RawRun = Pick<AnalyticsRun, "runId" | "status"> & {
  workflowName?: AnalyticsRun["workflowName"];
  attributes?: AnalyticsRun["attributes"];
  createdAt: string | Date;
  completedAt?: string | Date | null;
};

// One row of the runs table — a session run with its children rolled up.
export type RunSession = {
  runId: string;
  title: string;
  trigger: string;
  status: RunStatus;
  createdAt: string | Date;
  durationMs: number | null;
  model: string | null;
  turns: number;
  subagents: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  environment?: string;
};

// The event log folded for the run detail: turns own steps, steps own the
// tool calls (calls exist only here — they are never workflow steps).
export type ToolCall = {
  callId: string;
  toolName: string;
  kind?: string;
  input: unknown;
  output: unknown;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};

export type TurnStep = {
  stepIndex: number;
  calls: ToolCall[];
  usage: Record<string, number> | null;
  finishReason: string | null;
  generationId: string | null;
};

export type TurnMessage = { type: string; at: string | null; text: string | null };

export type Turn = {
  turnId: string;
  steps: TurnStep[];
  messages: TurnMessage[];
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};

export type RunDetail = {
  environment: string;
  session: {
    runId: string;
    status: RunStatus;
    createdAt: string | Date;
    attributes: Record<string, unknown>;
  };
  childRuns: Array<{
    runId: string;
    workflowName?: string;
    status: string;
    attributes: Record<string, unknown>;
  }>;
  turns: Turn[];
  events: Array<{ type: string; at?: string | null; data?: unknown }>;
  note: string | null;
};

// Why a data request came back empty-handed, classified for the UI: `env` is
// null when the failure is account-wide rather than one environment's.
export type AuthFailure = {
  env: Environment | null;
  kind: "expired" | "missing" | "forbidden" | "plan";
  canReconnect: boolean;
  message: string;
};

// What /api/account answers with; the header, welcome and settings all read it.
export type AccountScope = {
  id: string | null;
  slug?: string;
  name?: string;
  avatarUrl?: string | null;
  personal?: boolean;
};

export type Account = {
  loggedIn: boolean;
  tokenSource?: string;
  user?: { username?: string; name?: string; email?: string; avatarUrl?: string | null };
  scope?: AccountScope;
  teams?: AccountScope[];
  hint?: string;
  error?: string;
};

// ---- shared UI vocabulary --------------------------------------------------

// Where a docked panel (terminal, chat) sits; the shell owns the geometry.
export type Dock = "right" | "bottom";

// What the per-project dev controls can do, everywhere they appear: the
// project switcher, the Agents grid, and the /api/dev route they call.
export type DevAction = "start" | "stop" | "locate";
