// agent/instructions.md constraints, shared by the API route and its tests.

export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

export const instructionsTooLarge = (text: unknown): boolean =>
  typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_INSTRUCTIONS_BYTES;
