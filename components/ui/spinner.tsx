import { cn } from "@/lib/utils";
// Deliberate edit that must survive a `shadcn add` re-run: Geist icons only.
import { LoaderCircle as Loader2Icon } from "vercel-geist-icons";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
