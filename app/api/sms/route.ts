import { NextResponse } from "next/server";
import OpenAI from "openai";
import twilio from "twilio";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const incomingMessage = (formData.get("Body") as string) || "";
    const fromNumber = (formData.get("From") as string) || "";

    const systemPrompt = `
You are Primetime Golf AI assistant.

You are:
- welcoming
- confident
- premium
- helpful
- concise

Your job:
- understand the customer message
- answer clearly
- guide the conversation toward booking when appropriate
- if it is complex, ask the next best qualifying question
- if it is a large event, custom pricing issue, complaint, or refund, say a team member will follow up

Never say "I don't know".
Do not be robotic.
Keep the reply natural and text-friendly.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Customer phone: ${fromNumber}\nCustomer message: ${incomingMessage}`,
        },
      ],
    });

    const reply =
      completion.choices[0].message.content ||
      "Appreciate you reaching out. How can I help you today?";

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    return new NextResponse(twiml.toString(), {
      headers: {
        "Content-Type": "text/xml",
      },
    });
  } catch (error) {
    console.error("Inbound SMS error:", error);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(
      "Appreciate you reaching out. We’re having a small issue on our end right now, but someone will follow up shortly."
    );

    return new NextResponse(twiml.toString(), {
      headers: {
        "Content-Type": "text/xml",
      },
    });
  }
}