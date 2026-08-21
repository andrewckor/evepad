// Where eve's authored modules live inside a checkout. The graph's edit and
// scaffold prompts and its connection naming must agree with each other.

export const connectionPathOf = (name: string): string => {
  // Own connections live in agent/connections; an extension's are namespaced
  // <ext>__<name> and live under that extension.
  const [ext, conn] = name.includes("__") ? name.split("__") : [null, name];
  return ext ? `agent/extensions/${ext}/connections/${conn}.ts` : `agent/connections/${name}.ts`;
};

export const toolPathOf = (name: string): string => `agent/tools/${name}.ts`;
export const schedulePathOf = (name: string): string => `agent/schedules/${name}.ts`;
