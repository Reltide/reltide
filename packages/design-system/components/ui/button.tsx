import * as React from "react";

import { cn } from "@repo/design-system/lib/utils";

const buttonClassName =
  "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-transparent bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";

const Button = ({ className, ...props }: React.ComponentProps<"button">) => (
  <button data-slot="button" className={cn(buttonClassName, className)} type="button" {...props} />
);

const ButtonLink = ({ className, children, ...props }: React.ComponentProps<"a">) => (
  <a data-slot="button-link" className={cn(buttonClassName, className)} {...props}>
    {children}
  </a>
);

export { Button, ButtonLink };
