import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// The message out of an unknown catch, without assuming it was an Error.
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
