import nodemailer from "nodemailer";

const SENDERS = [
  { user: process.env.GMAIL_USER,  pass: process.env.GMAIL_APP_PASS  },
  { user: process.env.GMAIL_USER2, pass: process.env.GMAIL_APP_PASS2 },
].filter(s => s.user && s.pass);

// Round-robin sender index
let idx = 0;

export function hasSenders() { return SENDERS.length > 0; }

export async function sendEmail({ to, subject, body }) {
  if (!SENDERS.length) throw new Error("No Gmail senders configured in .env");
  const sender = SENDERS[idx % SENDERS.length];
  idx++;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: sender.user, pass: sender.pass },
  });

  await transporter.sendMail({
    from: `"Realman" <${sender.user}>`,
    to,
    subject,
    text: body,
    html: body.replace(/\n/g, "<br>"),
  });

  return sender.user;
}
