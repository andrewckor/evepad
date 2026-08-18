// Vercel's project-name rules, quoted from the API's own 400:
//   "Project names can be up to 100 characters long and must be lowercase.
//    They can include letters, digits, and the following characters: '.', '_',
//    '-'. However, they cannot contain the sequence '---'."
//
// Shared by the dialog and the create route so the form can never accept a
// name that `vercel link` will reject a minute later, in a terminal, after the
// scaffold has already been written to disk.

export const MAX_AGENT_NAME = 100;

export function agentNameError(name) {
  const v = name ?? "";
  if (!v) return "Required.";
  if (v.length > MAX_AGENT_NAME) return `Up to ${MAX_AGENT_NAME} characters.`;
  if (/[A-Z]/.test(v)) return "Must be lowercase.";
  if (!/^[a-z0-9._-]+$/.test(v)) return "Only letters, digits, and . _ -";
  if (v.includes("---")) return "Can't contain ---";
  // Not Vercel's rule, ours: the name is also a directory and a URL segment,
  // and a leading dot hides the folder.
  if (!/^[a-z0-9]/.test(v)) return "Start with a letter or digit.";
  return null;
}

export const isAgentName = (name) => agentNameError(name) === null;
