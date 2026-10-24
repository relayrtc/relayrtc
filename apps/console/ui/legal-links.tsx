export const legalLinks = { privacy: "https://relayrtc.com/legal/privacy", terms: "https://relayrtc.com/legal/terms-of-use" };

export function LegalLinks() {
  return <><a href={legalLinks.privacy} target="_blank" rel="noreferrer">Privacy</a><span className="footer-separator" aria-hidden="true">·</span><a href={legalLinks.terms} target="_blank" rel="noreferrer">Terms</a></>;
}

export function LegalAgreement() {
  return <p className="login-legal">By continuing, you agree to our <a href={legalLinks.privacy} target="_blank" rel="noreferrer"><strong>Privacy Policy</strong></a> and <a href={legalLinks.terms} target="_blank" rel="noreferrer"><strong>Terms of Use</strong></a>.</p>;
}
