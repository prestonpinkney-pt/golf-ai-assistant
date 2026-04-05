declare const process: {
  env: {
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_PHONE_NUMBER?: string;
  };
};

import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
const authToken = process.env.TWILIO_AUTH_TOKEN || "";
const fromPhone = process.env.TWILIO_PHONE_NUMBER || "";

const client = twilio(accountSid, authToken);

export async function sendSMS(to: string, body: string) {
  if (!accountSid || !authToken || !fromPhone) {
    throw new Error("Missing Twilio environment variables");
  }

  const message = await client.messages.create({
    body,
    from: fromPhone,
    to,
  });

  return message;
}