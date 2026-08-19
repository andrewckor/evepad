"use client";

// What the toast's Reconnect button opens.
//
// It runs no auth of its own: CliSignIn (welcome.jsx) already owns the "watch
// for the CLI's credentials and confirm who turned up" flow, and /api/account
// already reports loggedIn:false when the token exists but the API rejects it —
// which is exactly the state we're in here. So this is the first-run screen
// pointed at a mid-session failure, and a token that has been re-issued flips
// it to the confirmation on its own within ~1.5s.

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { CliSignIn } from "./welcome";

// Reconnecting cannot help a plan limit, so `plan` never reaches this dialog —
// see authFailure() in lib/data.js.
const COPY = {
  expired:
    "Your Vercel sign-in has expired. Sign in again below and evepad picks it up on its own — nothing else to do.",
  missing:
    "There's no Vercel sign-in on this Mac yet. Sign in below and your agents will show up here.",
  forbidden:
    "Vercel turned down the request. Usually that just means the sign-in expired, though it can also be a scope this account can't see.",
};

export default function ReconnectDialog({
  open,
  onOpenChange,
  kind = "forbidden",
  onReconnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind?: string;
  onReconnected?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="set-dialog">
        {/* .set-dialog is padding:0 — the settings rows are full-bleed and
            inset themselves — so the content needs .set-body just like
            settings does. Without it every line sat flush against the dialog's
            left edge. Same wrapper, same Geist inset, one modal look. */}
        <div className="set-body">
          <DialogHeader>
            <DialogTitle>Reconnect to Vercel</DialogTitle>
            <DialogDescription>
              {COPY[kind as keyof typeof COPY] ?? COPY.forbidden}
            </DialogDescription>
          </DialogHeader>
          {/* CliSignIn's children get their spacing from .wc's 12px column
              gap on the Welcome page. In a dialog there's no .wc, so they
              collapse against each other — this supplies the same rhythm
              without the page layout's centring. */}
          <div className="rc-signin">
            <CliSignIn
              terminal
              onContinue={() => {
                onReconnected?.();
                onOpenChange(false);
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
