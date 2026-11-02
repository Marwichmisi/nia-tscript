// Composant Button style shadcn/ui (cva + Radix Slot).
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "ui-btn",
  {
    variants: {
      variant: {
        default: "ui-btn-default",
        secondary: "ui-btn-secondary",
        outline: "ui-btn-outline",
        ghost: "ui-btn-ghost",
      },
      size: {
        default: "ui-btn-md",
        sm: "ui-btn-sm",
        icon: "ui-btn-icon",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
