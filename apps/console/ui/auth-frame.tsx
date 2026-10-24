import type { ReactNode } from "react";
import { Logo } from "./icon";
import { LegalAgreement, LegalLinks } from "./legal-links";

export function AuthFrame({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return <main className="login-page" id="main-content">
    <section className="login-center" aria-label={title}>
      <Logo className="login-logo" /><h1>{title}</h1>
      {description && <p className="login-subheading">{description}</p>}
      {children}
    </section>
    <footer className="login-footer"><LegalAgreement /><div className="footer-links"><a href="https://docs.relayrtc.com" target="_blank" rel="noreferrer">Docs</a><span className="footer-separator" aria-hidden="true">·</span><LegalLinks /></div></footer>
  </main>;
}
