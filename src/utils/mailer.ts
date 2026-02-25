import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = "noreply@aryantechie.in";

// ─── Welcome Email ─────────────────────────────────────────────────────────────
export async function sendWelcomeEmail(
  to: string,
  name: string,
): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM,
      to: [to],
      subject: "Welcome to Stock Labs 🚀",
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f0f1a;color:#e2e8f0;padding:32px;border-radius:12px;">
          <h1 style="font-size:24px;font-weight:800;color:#6366f1;margin-bottom:4px;">Stock Labs</h1>
          <p style="color:#94a3b8;font-size:14px;margin-bottom:32px;">Paper Trading Platform</p>

          <h2 style="font-size:20px;font-weight:700;margin-bottom:8px;">Welcome aboard, ${name}! 🎉</h2>
          <p style="color:#cbd5e1;line-height:1.6;margin-bottom:24px;">
            Your account is ready. You've been credited with <strong style="color:#6366f1;">₹1 Crore</strong>
            of virtual cash to start paper trading stocks, crypto, and commodities — completely risk-free.
          </p>

          <div style="background:#1e1b4b;border-radius:8px;padding:20px;margin-bottom:24px;">
            <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;">YOUR VIRTUAL BALANCE</p>
            <p style="margin:0;font-size:28px;font-weight:800;color:#34d399;">₹1,00,00,000</p>
            <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">= 1 Crore INR</p>
          </div>

          <p style="color:#94a3b8;font-size:13px;line-height:1.6;">
            Trade stocks, go long or short on commodities, and track your portfolio —
            all without risking real money.
          </p>

          <hr style="border:none;border-top:1px solid #1e293b;margin:32px 0;" />
          <p style="font-size:12px;color:#475569;text-align:center;">
            Stock Labs · Paper Trading Platform · <a href="https://stocklabs.aryantechie.in" style="color:#6366f1;text-decoration:none;">stocklabs.aryantechie.in</a>
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[Mailer] sendWelcomeEmail failed:", err);
  }
}

// ─── OTP Email ─────────────────────────────────────────────────────────────────
export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM,
      to: [to],
      subject: "Password Reset OTP – Stock Labs",
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f0f1a;color:#e2e8f0;padding:32px;border-radius:12px;">
          <h1 style="font-size:24px;font-weight:800;color:#6366f1;margin-bottom:4px;">Stock Labs</h1>
          <p style="color:#94a3b8;font-size:14px;margin-bottom:32px;">Paper Trading Platform</p>

          <h2 style="font-size:20px;font-weight:700;margin-bottom:8px;">Password Reset</h2>
          <p style="color:#cbd5e1;line-height:1.6;margin-bottom:24px;">
            Use the OTP below to reset your password. It expires in <strong>10 minutes</strong>.
          </p>

          <div style="background:#1e1b4b;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px;">
            <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;letter-spacing:2px;">YOUR ONE-TIME PASSWORD</p>
            <p style="margin:0;font-size:40px;font-weight:900;letter-spacing:12px;color:#6366f1;">${otp}</p>
          </div>

          <p style="color:#94a3b8;font-size:13px;line-height:1.6;">
            If you didn't request this, please ignore this email. Your password will remain unchanged.
          </p>

          <hr style="border:none;border-top:1px solid #1e293b;margin:32px 0;" />
          <p style="font-size:12px;color:#475569;text-align:center;">
            Stock Labs · Paper Trading Platform
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[Mailer] sendOtpEmail failed:", err);
  }
}
