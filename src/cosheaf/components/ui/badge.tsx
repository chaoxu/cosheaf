import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-1.5 py-0 text-[10px] uppercase tracking-wider font-medium",
  {
    variants: {
      variant: {
        default: "border-[var(--cf-border)] text-[var(--cf-fg)]",
        outline: "border-[var(--cf-border)] text-[var(--cf-muted)]",
        golden: "border-[var(--cf-fg)] bg-[var(--cf-fg)] text-[var(--cf-bg)]",
        unreviewed: "border-[var(--cf-fg)] text-[var(--cf-fg)]",
        rejected:
          "border-[var(--cf-fg)] text-[var(--cf-fg)] line-through decoration-[1px]",
        draft: "border-[var(--cf-border)] text-[var(--cf-muted)]",
        archived: "border-[var(--cf-border)] text-[var(--cf-muted)] opacity-60",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
