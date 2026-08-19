// Formatters shared by the dashboard pages. Run attributes arrive as strings
// ($eve.cost_usd is "0.0011166"), so the numeric ones take unknown and coerce.

export const money = (n: unknown): string => "$" + (Number(n) || 0).toFixed(4);

export const kt = (n: unknown): string => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "K" : String(v);
};

export const dur = (ms: number | null | undefined): string => {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  return (s < 10 ? s.toFixed(2).replace(/\.?0+$/, "") : Math.round(s)) + "s";
};

// Relative time. Timestamps come as ISO strings from the local store, Date
// objects from the analytics client, and epoch millis from a few UI spots.
export const ago = (t: string | number | Date, days: "short" | "long" = "short"): string => {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const d = Math.floor(s / 86400);
  return days === "long" ? `${d} day${d === 1 ? "" : "s"} ago` : `${d}d ago`;
};
