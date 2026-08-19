// The two client-side fetch shapes, shared instead of redeclared per file.

// SWR fetcher: parse and hand back, errors surface as SWR errors.
export const getJson = (url: string) => fetch(url).then((r) => r.json());

// Imperative calls: throw on non-2xx with the server's own message. Reads the
// body as text first — a non-JSON error page must become an Error, not a
// JSON.parse throw inside a render.
export async function fetchJson<T = any>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text || r.statusText };
  }
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
