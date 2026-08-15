"use client";

// CODE BLOCK — beautifului.dev's, wired to real streamed code.
//
// Replaces Streamdown's default block: that one wrapped every line (its body
// is sans-serif with white-space:normal until shiki loads) and shiki is not
// installed here, so it never loaded — every block rendered as flat wrapped
// prose inside two nested boxes.
//
// Highlighting is a small regex pass rather than shiki: the reference design
// only distinguishes five token classes, and a real grammar engine is a
// megabyte of lazily-loaded WASM on a page whose stated #1 goal is speed.
// Unknown languages simply fall through as plain text.

import { useCallback, useMemo, useState } from "react";

const KEYWORDS = new Set([
  "const", "let", "var", "function", "async", "await", "return", "if", "else",
  "for", "while", "do", "break", "continue", "new", "class", "extends", "super",
  "import", "export", "from", "default", "try", "catch", "finally", "throw",
  "typeof", "instanceof", "in", "of", "this", "null", "undefined", "true",
  "false", "interface", "type", "enum", "implements", "public", "private",
  "protected", "readonly", "static", "as", "satisfies", "yield", "delete",
  "void", "def", "elif", "lambda", "pass", "raise", "with", "then", "fi", "esac",
  "case", "esle", "echo", "local", "select", "where", "and", "or", "not",
]);

// One pass, longest-match-first. Order matters: comments and strings swallow
// anything that looks like code inside them.
const TOKEN = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([^\w\s$]+)|(\s+)/g;

function tokenize(line) {
  const out = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line))) {
    const [text, comment, str, num, word, punct] = m;
    if (comment) out.push(["cm", text]);
    else if (str) out.push(["str", text]);
    else if (num) out.push(["num", text]);
    else if (word) {
      // A name immediately followed by "(" is a call — the one piece of
      // context worth tracking, and what makes the reference block read as
      // code rather than as coloured words.
      const next = line[m.index + text.length];
      out.push([KEYWORDS.has(word) ? "kw" : next === "(" ? "fn" : "id", text]);
    } else if (punct) out.push(["dim", text]);
    else out.push(["id", text]);
  }
  return out;
}

// Fence info strings carry the filename in the shapes agents actually emit:
// ```ts title="agent/tools/x.ts", ```ts agent/tools/x.ts, ```ts:agent/x.ts
function parseMeta(meta) {
  if (!meta) return null;
  const quoted = meta.match(/(?:title|file|filename)\s*=\s*["']([^"']+)["']/);
  if (quoted) return quoted[1];
  const bare = meta.trim().match(/^[:\s]?([\w./@-]+\.\w+)/);
  return bare ? bare[1] : null;
}

const LANG_NAMES = {
  ts: "TypeScript", tsx: "TypeScript", typescript: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", javascript: "JavaScript",
  json: "JSON", css: "CSS", html: "HTML", md: "Markdown", markdown: "Markdown",
  sh: "Shell", bash: "Shell", zsh: "Shell", shell: "Shell",
  py: "Python", python: "Python", sql: "SQL", yaml: "YAML", yml: "YAML",
  diff: "Diff", text: "Text",
};

const CopyIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export default function CodeBlock({ code, language = "", meta, isIncomplete = false }) {
  const [copied, setCopied] = useState(false);
  const raw = code.replace(/\n+$/, "");
  const lines = useMemo(() => raw.split("\n").map(tokenize), [raw]);
  const filename = parseMeta(meta);
  const langName = LANG_NAMES[language.toLowerCase()] ?? (language || null);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(raw);
    } catch {
      // clipboard API refuses on an unfocused document (and any non-secure
      // context); the selection fallback still works there.
      const ta = document.createElement("textarea");
      ta.value = raw;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); } finally { ta.remove(); }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [raw]);

  return (
    <div className="cb">
      <div className="cb-bar">
        <span className="cb-id">
          {/* Primary label is the filename when the fence names one; with no
              filename the language IS the identity, so it moves up rather
              than inventing a name. */}
          <span className="cb-name mono">{filename ?? langName ?? "code"}</span>
          {filename && langName && <span className="cb-lang">{langName}</span>}
        </span>
        <button className={"cb-copy" + (copied ? " done" : "")} aria-label="Copy code" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="cb-code">
        {lines.map((toks, i) => (
          <div className="cb-line" key={i}>
            <span className="cb-n">{i + 1}</span>
            <span className="cb-t">
              {toks.map(([kind, text], j) => (
                <span key={j} className={"t-" + kind}>{text}</span>
              ))}
              {isIncomplete && i === lines.length - 1 && <span className="cb-caret" />}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
