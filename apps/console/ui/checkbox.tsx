import type { InputHTMLAttributes } from "react";

type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children" | "dangerouslySetInnerHTML"
> & {
  children?: never;
  dangerouslySetInnerHTML?: never;
};

export function Checkbox({ className = "", ...props }: CheckboxProps) {
  return <input {...props} type="checkbox" className={`checkbox ${className}`} />;
}
