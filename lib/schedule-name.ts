// Schedule ids eve accepts in its dev dispatch route: file-derived names,
// so word characters, dots, dashes. Validated before any fetch leaves.

const NAME_RE = /^[\w.-]{1,64}$/;
export const isValidScheduleName = (name: unknown): name is string =>
  typeof name === "string" && NAME_RE.test(name);

// The dispatch route answers {sessionIds} but a server version may omit or
// mangle it — normalize rather than trust.
export const normalizeSessionIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
