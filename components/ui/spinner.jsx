import { cn } from "@/lib/utils"
import { LoaderCircle } from "vercel-geist-icons"

function Spinner({
  className,
  ...props
}) {
  return (
    <LoaderCircle
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props} />
  );
}

export { Spinner }
