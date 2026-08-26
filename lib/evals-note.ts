// What the evals list API says when `eve eval --list` fails. Exit-2 with
// "No evals found" is eve saying the folder has none — a state for the pane
// to explain, not an error. Anything else is real breakage worth showing.

export type EvalsNote = { kind: "empty" | "error"; message: string };

export function evalsNoteFromFailure(stderr: string | undefined, fallback: string): EvalsNote {
  const text = String(stderr ?? "");
  if (/no evals found/i.test(text))
    return {
      kind: "empty",
      message: "No evals yet — create *.eval.ts files under evals/, beside agent/.",
    };
  return { kind: "error", message: text.trim().slice(-200) || fallback };
}
