"use client";

import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./icon";
import { FieldLabelContext } from "./field-context";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <FieldLabelContext.Provider value={label}><label className="account-field"><span className="field-label">{label}</span>{children}</label></FieldLabelContext.Provider>;
}

export function PasswordInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return <span className="password-field"><input {...props} className={`input ${className}`} type={visible ? "text" : "password"} maxLength={128} /><button type="button" className="password-reveal" onClick={() => setVisible(value => !value)} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible}><Icon name={visible ? "hide" : "eye"} size={17.325} /></button></span>;
}

export function CodeInput({ recovery = false, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { recovery?: boolean }) {
  const id = useId();
  return <input id={id} aria-label={recovery ? "Recovery code" : "Verification code"} {...props} className={`input code-input ${className}`} name={props.name ?? "code"} type="text" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} pattern={recovery ? undefined : "[0-9]{6}"} minLength={recovery ? 1 : 6} maxLength={recovery ? 64 : 6} placeholder={recovery ? "Recovery code" : "000000"} spellCheck={false} autoCapitalize="none" required />;
}

export function FormFeedback({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <p className="form-feedback form-feedback-error" role="alert">{error}</p>}{notice && <p className="form-feedback" role="status">{notice}</p>}</>;
}
