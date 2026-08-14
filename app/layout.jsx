import "./globals.css";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import Shell from "./components/shell.jsx";

export const metadata = { title: "eve cockpit", description: "Agent runs, local and remote" };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {/* The Shell (topbar, pickers, chat, terminal) mounts once and survives
            all route changes — pages below it only swap their content. */}
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
