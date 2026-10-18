"use client";
import { useId } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StreamSectionCard({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <Card
      role="region"
      aria-labelledby={id}
      className={cn(
        "min-w-0 gap-4 rounded-xl border border-border/70 bg-card/30 ring-0 [--card-spacing:--spacing(4)] sm:[--card-spacing:--spacing(5)]",
        className,
      )}
    >
      <CardHeader className="gap-2 max-sm:flex max-sm:flex-col">
        <CardTitle id={id} role="heading" aria-level={2} className="text-sm font-semibold">
          {title}
        </CardTitle>
        {description && (
          <CardDescription className="text-xs leading-relaxed">{description}</CardDescription>
        )}
        {actions && <CardAction className="max-sm:mt-2 max-sm:self-start">{actions}</CardAction>}
      </CardHeader>
      <CardContent className="min-w-0 space-y-4 [&_input]:rounded-lg [&_button]:rounded-lg [&_form>button[type=submit]]:mt-2">
        {children}
      </CardContent>
    </Card>
  );
}
