// Composant Separator minimal (shadcn look, sans dépendance).
import * as React from "react";
import { cn } from "../../lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}) {
  return (
    <div
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "ui-separator",
        orientation === "horizontal" ? "ui-separator-h" : "ui-separator-v",
        className
      )}
      {...props}
    />
  );
}

export { Separator };
