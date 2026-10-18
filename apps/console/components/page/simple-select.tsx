"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

export function SimpleSelect({
  value,
  defaultValue,
  name,
  required,
  disabled,
  onValueChange,
  options,
  placeholder,
  id,
  className,
  size = "default",
  "aria-label": ariaLabel,
}: {
  value?: string;
  defaultValue?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  className?: string;
  size?: "default" | "sm";
  "aria-label"?: string;
}) {
  return (
    <Select
      {...(value === undefined ? { defaultValue } : { value })}
      name={name}
      required={required}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next);
      }}
      items={options}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        className={cn("w-full sm:w-fit", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-44">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
