// The user input that started a session, recovered from its folded event
// log. A re-run seeds a new session with this; runs with no recoverable
// prompt offer nothing to re-run from.

import type { Turn } from "./types";

export function firstPromptOf(turns: Turn[]): string | null {
  for (const t of turns)
    for (const m of t.messages) if (m.type === "message.received" && m.text?.trim()) return m.text;
  return null;
}
