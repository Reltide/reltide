import * as React from "react";
import { Slot as SlotPrimitive } from "radix-ui";

import { cn } from "@repo/design-system/lib/utils";

const buttonClassName =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive h-9 px-4 py-2 has-[>svg]:px-3 bg-primary text-primary-foreground hover:bg-primary/90";

const Button = ({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
}) => {
  const Comp = asChild ? SlotPrimitive.Slot : "button";

  return <Comp data-slot="button" className={cn(buttonClassName, className)} {...props} />;
};

export { Button };
