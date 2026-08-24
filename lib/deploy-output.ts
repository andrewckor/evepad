// Reading a finished deploy from its pty transcript. Pure: the modal owns the
// bytes, this owns their meaning.

// CSI sequences including private modes (?25h cursor show/hide) that plain
// SGR strippers leave behind.
// oxlint-disable-next-line no-control-regex -- \x1b IS the subject
const ANSI_RE = /\x1b\[[?0-9;]*[A-Za-z]/g;

// Fold a pty chunk the way a terminal would: \r returns to column 0 so the
// NEXT text overwrites the line, \n commits it. Spinner frames collapse to
// their final text instead of piling up as thousands of lines — and a pty's
// \r\n line ending is just a newline, not a wipe. (Treating \r as an eager
// wipe erased every terminated line and kept only the spinner's tail.)
export function foldLines(lines: string[], chunk: string, cap = 400): string[] {
  const out = lines.slice();
  let cur = out.pop() ?? "";
  let atStart = false;
  const clean = chunk.replace(ANSI_RE, "");
  for (const ch of clean) {
    if (ch === "\r") atStart = true;
    else if (ch === "\n") {
      out.push(cur);
      cur = "";
      atStart = false;
      if (out.length > cap) out.splice(0, out.length - cap);
    } else {
      if (atStart) {
        cur = "";
        atStart = false;
      }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export type DeployVerdict = {
  state: "running" | "success" | "failed";
  // The stable production alias when the CLI printed one ("Aliased …").
  url: string | null;
};

export function readDeployOutput(lines: string[]): DeployVerdict {
  const text = lines.join("\n");
  const exited = /\[process exited (\d+)\]/.exec(text);
  if (!exited) return { state: "running", url: null };
  const url =
    /Aliased\s+(https:\/\/\S+)/.exec(text)?.[1] ??
    text.match(/https:\/\/[^\s]*vercel\.app/)?.[0] ??
    null;
  return exited[1] === "0" ? { state: "success", url } : { state: "failed", url };
}
