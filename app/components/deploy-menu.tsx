"use client";

// The deploy entry point: a button with a tooltip and a two-row menu. Used by
// the main app header and the agent card — the window itself is self-contained
// (deploy-modal.tsx) and never navigates away from where you are.

import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { MenuList, MenuRow } from "./menu";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import DeployModal from "./deploy-modal";
import type { DeployTarget } from "@/lib/deploy-command";
import { I } from "./icons";

export default function DeployMenu({ project, tip = "Deploy" }: { project: string; tip?: string }) {
  const [target, setTarget] = useState<DeployTarget | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipProvider delay={300}>
          {/* One button, two behaviors hooked onto it: hover explains it,
              click opens the menu. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger className="devbtn" aria-label={tip} title={undefined}>
                  {I.upload}
                </PopoverTrigger>
              }
            />
            <TooltipContent>{tip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <PopoverContent align="end" className="menu-pop">
          <MenuList>
            <MenuRow
              onSelect={() => {
                setOpen(false);
                setTarget("deploy");
              }}
            >
              Production
            </MenuRow>
            <MenuRow
              onSelect={() => {
                setOpen(false);
                setTarget("deploy-preview");
              }}
            >
              Preview
            </MenuRow>
          </MenuList>
        </PopoverContent>
      </Popover>
      {target && (
        <DeployModal
          project={project}
          initialTarget={target}
          open
          onOpenChange={() => setTarget(null)}
        />
      )}
    </>
  );
}
