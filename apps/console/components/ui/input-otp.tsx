"use client";

import { useContext, type ComponentProps } from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export function InputOTP({
  className,
  containerClassName,
  ...props
}: ComponentProps<typeof OTPInput>) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn("flex items-center gap-2 has-disabled:opacity-50", containerClassName)}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}
export function InputOTPGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="input-otp-group" className={cn("flex items-center", className)} {...props} />
  );
}
export function InputOTPSlot({
  index,
  className,
  ...props
}: ComponentProps<"div"> & { index: number }) {
  const context = useContext(OTPInputContext);
  const slot = context.slots[index];
  return (
    <div
      data-slot="input-otp-slot"
      data-active={slot?.isActive}
      className={cn(
        "relative flex size-11 items-center justify-center border-y border-r border-input text-base first:rounded-l-xl first:border-l last:rounded-r-xl data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:ring-3 data-[active=true]:ring-ring/30",
        className,
      )}
      {...props}
    >
      {slot?.char}
      {slot?.hasFakeCaret ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-pulse bg-foreground" />
        </div>
      ) : null}
    </div>
  );
}
export function InputOTPSeparator({ ...props }: ComponentProps<"div">) {
  return (
    <div role="separator" {...props}>
      <Minus className="size-4 text-muted-foreground" />
    </div>
  );
}
