import "./globals.css";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import Shell from "./components/shell.jsx";
export const metadata = { title: "eve cockpit", description: "Agent runs, local and remote" };

// Resolve the theme before the first paint. React can't do this — its first
// render happens after the browser has already painted the document's default
// colours, which is the white flash every themed app has to design around.
// "system" is resolved here too, so the CSS only ever sees an explicit
// data-theme and there's no media query duplicating the stored preference.
const THEME_BOOT = `
try {
  var p = localStorage.getItem("eve-cockpit:theme") || "system";
  var dark = p === "dark" || (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = p;
  // Tailwind's dark: variant here is (&:is(.dark *)), so shadcn's own
  // dark-mode utilities need the class as well as the attribute.
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.classList.add("dark");
}
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        {/* The Shell (topbar, pickers, chat, terminal) mounts once and survives
            all route changes — pages below it only swap their content. */}
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
