import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--cf-accent)] text-[var(--cf-accent-fg)] hover:opacity-90",
        outline:
          "border border-[var(--cf-border)] bg-transparent text-[var(--cf-fg)] hover:bg-[var(--cf-hover)]",
        ghost: "text-[var(--cf-fg)] hover:bg-[var(--cf-hover)]",
        destructive:
          "bg-red-600 text-white hover:bg-red-700",
        link: "text-[var(--cf-accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-xs",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, asChild = false, ...props }, ref) {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);

export { Button, buttonVariants };
