"use client";

// The deploy entry point: a topbar button in the Chat/CLI family, opening a
// two-row menu. The window itself is self-contained (deploy-modal.tsx) and
// never navigates away from where you are.

import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { MenuList, MenuRow } from "./menu";
import DeployModal from "./deploy-modal";
import type { DeployTarget } from "@/lib/deploy-command";
import { I } from "./icons";

export default function DeployMenu({ project }: { project: string }) {
  const [target, setTarget] = useState<DeployTarget | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* First among the topbar actions, bare icon, active state when open. */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="chatbtn"
          title="Deploy"
          data-on={open ? "1" : "0"}
          onClick={(e) => e.stopPropagation()}
        >
          {I.upload}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="menu-pop w-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuList>
            <MenuRow
              onSelect={() => {
                setOpen(false);
                setTarget("deploy");
              }}
            >
              Deploy to Production
            </MenuRow>
            <MenuRow
              onSelect={() => {
                setOpen(false);
                setTarget("deploy-preview");
              }}
            >
              Deploy to Preview
            </MenuRow>
          </MenuList>
        </PopoverContent>
      </Popover>
      {target && (
        <DeployModal project={project} target={target} open onOpenChange={() => setTarget(null)} />
      )}
    </>
  );
}
