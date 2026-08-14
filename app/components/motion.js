// Shared animation constants. Lives outside any component file so Fast
// Refresh can hot-swap components without full page reloads (a component
// file exporting plain values disables it for every importer).
export const SPRING = { type: "spring", stiffness: 480, damping: 44 };
