import { createMessage, type Transport } from "@upyo/core";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export let transport: Transport;
let emailFrom: string;

export function configureEmail(resource: Transport, from: string): void {
  transport = resource;
  emailFrom = from;
}

export async function sendEmail(email: Email): Promise<void> {
  const receipt = await transport.send(createMessage({
    from: emailFrom,
    to: email.to,
    subject: email.subject,
    content: { text: email.text },
  }));
  if (!receipt.successful) {
    throw new Error(receipt.errorMessages.join("; "));
  }
}
