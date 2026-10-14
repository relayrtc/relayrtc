import { Resend } from "resend";

export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
  subjectUserId?: string;
  deliveryId?: string;
  expiresInSeconds?: number;
}
export type AccountEmailSender = (email: AccountEmail) => Promise<void>;

export const createAccountEmailSender = (options: { apiKey: string; from: string }): AccountEmailSender => {
  const resend = new Resend(options.apiKey);
  return async (message) => {
    const result = await resend.emails.send({ to: message.to, subject: message.subject, text: message.text, from: options.from },
      message.deliveryId ? { idempotencyKey: message.deliveryId } : undefined);
    if (result.error) throw new Error("Account email delivery failed");
  };
};
