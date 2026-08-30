// Client-side shapes for the OpenCode surfaces (Build chat, thinking trace),
// derived from the SDK's own types rather than redeclared. They are looser
// than the SDK's on purpose: parts stream in half-built, and the client mints
// synthetic entries (optimistic sends, notes) the wire never carries.

import type { Part, Message, Session, Permission, ToolState } from "@opencode-ai/sdk";

// The SDK's ToolState is a discriminated union per status; mid-stream the UI
// holds whichever fields have arrived, so this is that union flattened.
export type OcToolState = {
  status?: ToolState["status"];
  input?: Record<string, unknown>;
  output?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type OcPart = {
  id: string;
  type: Part["type"];
  messageID?: string;
  sessionID?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: OcToolState;
  time?: { start?: number; end?: number };
  files?: string[];
  synthetic?: boolean;
};

export type OcMessageInfo = {
  id: Message["id"];
  role: Message["role"];
  sessionID?: string;
  time?: { created?: number; completed?: number };
  // Stamped on client-minted entries (optimistic sends, notes) so the
  // time-ordered transcript has a key for them too.
  localAt?: number;
};

export type OcMessage = {
  info: OcMessageInfo;
  parts: Map<string, OcPart>;
  rev?: number;
};

// The wire shape of one hydrated message, as /api/oc/messages returns it:
// parts still an array, not yet keyed.
export type OcWireMessage = { info: OcMessageInfo; parts: OcPart[] };

// A session row as /api/oc/state summarizes it for the picker.
export type OcSession = {
  id: Session["id"];
  title?: Session["title"];
  updated?: number;
};

// A pending permission ask. Live ones are SDK Permissions off the event bus;
// log-recovered ones (see /api/oc/pending) carry only id and patterns.
export type OcPermission = Partial<Permission> & {
  id: string;
  patterns?: string[];
  permission?: string;
};

// A pending question (elicitation) — the agent's AskUserQuestion-style tool.
// The pinned SDK client predates these, so the shape is declared here; it
// mirrors the server's QuestionRequest.
export type OcQuestionOption = { label: string; description?: string };
export type OcQuestionInfo = {
  question: string;
  header?: string;
  options: OcQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};
export type OcQuestionRequest = {
  id: string;
  sessionID?: string;
  questions: OcQuestionInfo[];
  tool?: { messageID: string; callID: string };
};
