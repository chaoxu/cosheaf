import * as React from "react";
import { cn } from "../../lib/utils";

function Input({
  className,
  type = "text",
  ref,
  ...props
}: React.ComponentPropsWithoutRef<"input"> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-3 py-1 text-sm text-[var(--cf-fg)]",
        "placeholder:text-[var(--cf-muted)]",
        "focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
