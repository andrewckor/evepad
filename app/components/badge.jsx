// Geist Badge, built to the spec measured from vercel.com/geist/badge:
// pill radius, 24px tall (md) / 20px (sm), 12px/11px Geist 500, 12px x-pad,
// 5px content gap. Solid variant colors are the page's computed values;
// subtle variants pair the measured text color with a 14% tint bg — the
// treatment Vercel's dashboard uses for status ("Ready").
export function Badge({ variant = "gray", size = "md", dot = false, className = "", children, ...rest }) {
  return (
    <span className={`gbadge ${variant} ${size} ${className}`} {...rest}>
      {dot && <i className="gbadge-dot" />}
      {children}
    </span>
  );
}
