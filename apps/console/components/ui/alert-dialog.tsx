"use client";

import { AlertDialog as Primitive } from "@base-ui/react/alert-dialog";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const AlertDialog = Primitive.Root;
export const AlertDialogTitle = Primitive.Title;
export const AlertDialogDescription = Primitive.Description;
export function AlertDialogHeader(props: ComponentProps<"div">) {
  return <div {...props} className={cn("space-y-2", props.className)} />;
}
export function AlertDialogFooter(props: ComponentProps<"div">) {
  return <div {...props} className={cn("flex justify-end gap-2", props.className)} />;
}
export function AlertDialogContent({ children, className, ...props }: Primitive.Popup.Props) {
  return (
    <Primitive.Portal>
      <Primitive.Backdrop className="fixed inset-0 z-50 bg-black/30 backdrop-blur-xs" />
      <Primitive.Popup
        {...props}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border bg-popover p-6 text-popover-foreground shadow-lg outline-none",
          className,
        )}
      >
        {children}
      </Primitive.Popup>
    </Primitive.Portal>
  );
}
