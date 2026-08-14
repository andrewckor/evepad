import "./globals.css";

export const metadata = { title: "eve cockpit", description: "Agent runs, local and remote" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
