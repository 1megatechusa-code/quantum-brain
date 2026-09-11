import type { Env } from "../env";

/**
 * The activation email, over Resend's REST API (POST /emails). One template,
 * rendered as HTML with a plain-text twin so it reads in every client.
 */

const RESEND_API = "https://api.resend.com/emails";

export class EmailError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ActivationEmailInput {
  to: string;
  connectorUrl: string;
  apiKey: string;
  plan: "monthly" | "yearly" | string;
  /** The activation link to include for a lost-key resend; defaults to none. */
  supportEmail?: string;
}

export function renderActivationEmail(input: ActivationEmailInput): { subject: string; text: string; html: string } {
  const planLabel = input.plan === "yearly" ? "Yearly ($25/year)" : "Monthly ($3/month)";
  const support = input.supportEmail ?? "";
  const subject = "Your Quantum Brain is ready — connector URL + API key inside";

  const desktopConfig = JSON.stringify({
    mcpServers: {
      "quantum-brain": {
        command: "npx",
        args: ["-y", "mcp-remote", input.connectorUrl, "--header", "Authorization: Bearer " + input.apiKey],
      },
    },
  }, null, 2);

  const text = [
    "Welcome to Quantum Brain (Cloud Sync)!",
    "",
    `Plan: ${planLabel}`,
    "",
    "Here are your two activation details. Keep them private — anyone holding the key can read and write your brain.",
    "",
    `  Connector URL:  ${input.connectorUrl}`,
    `  API key:        ${input.apiKey}`,
    "",
    "QUICK SETUP — Claude.ai (browser + mobile), about 2 minutes:",
    "  1. Go to claude.ai → Settings → Connectors → Add custom connector",
    "  2. Name: Quantum Brain",
    "  3. Remote MCP server URL: paste your Connector URL",
    "  4. Authentication: choose the API key / token option (not OAuth)",
    "  5. API key: paste your API key, then click Add",
    "  6. In a new chat, make sure the Quantum Brain connector is toggled on",
    "",
    "QUICK SETUP — Claude Desktop (optional):",
    "  Open %APPDATA%\Claude\claude_desktop_config.json (Windows) or",
    "  ~/Library/Application Support/Claude/claude_desktop_config.json (Mac) and add:",
    "",
    desktopConfig.split("\n").map((l) => "  " + l).join("\n"),
    "",
    "  Restart Claude Desktop. Requires Node.js (nodejs.org).",
    "",
    "TEST IT:",
    "  In a chat with the connector on, say: \"Remember that my test sync word is banana.\"",
    "  Then on another device: \"What's my test sync word?\"",
    "",
    "The full setup guide is in your Quantum Brain product kit (2-Quantum-Brain-Cloud-Connector-Setup.md).",
    support ? `Questions or a lost key? Just reply to this email (${support}).` : "Questions or a lost key? Just reply to this email.",
    "",
    "— AI Skill Drops",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:600px;margin:0 auto;padding:32px 20px">
  <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e5ea">
    <h1 style="font-size:22px;margin:0 0 8px">Your Quantum Brain is ready 🧠</h1>
    <p style="margin:0 0 20px;color:#6e6e73">Plan: <strong style="color:#1d1d1f">${escapeHtml(planLabel)}</strong></p>
    <p style="margin:0 0 16px">Here are your two activation details. Keep them private — anyone holding the key can read and write your brain.</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 24px;font-size:14px">
      <tr><td style="padding:10px 12px;background:#f5f5f7;border-radius:8px 8px 0 0;color:#6e6e73;width:120px">Connector URL</td>
          <td style="padding:10px 12px;background:#f5f5f7;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all">${escapeHtml(input.connectorUrl)}</td></tr>
      <tr><td style="padding:10px 12px;background:#f5f5f7;border-radius:0 0 8px 8px;color:#6e6e73">API key</td>
          <td style="padding:10px 12px;background:#f5f5f7;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all">${escapeHtml(input.apiKey)}</td></tr>
    </table>
    <h2 style="font-size:16px;margin:0 0 8px">Quick setup — Claude.ai (browser + mobile)</h2>
    <ol style="margin:0 0 20px;padding-left:20px;line-height:1.6">
      <li>Go to <strong>claude.ai → Settings → Connectors → Add custom connector</strong></li>
      <li>Name: <strong>Quantum Brain</strong></li>
      <li>Remote MCP server URL: paste your <strong>Connector URL</strong></li>
      <li>Authentication: choose the <strong>API key / token</strong> option (not OAuth)</li>
      <li>API key: paste your <strong>API key</strong>, then click Add</li>
      <li>In a new chat, make sure the Quantum Brain connector is toggled on</li>
    </ol>
    <h2 style="font-size:16px;margin:0 0 8px">Quick setup — Claude Desktop (optional)</h2>
    <p style="margin:0 0 8px;font-size:14px">Open <code>%APPDATA%\Claude\claude_desktop_config.json</code> (Windows) or <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (Mac) and add:</p>
    <pre style="background:#1d1d1f;color:#f5f5f7;padding:14px;border-radius:8px;font-size:12px;overflow-x:auto;margin:0 0 8px">${escapeHtml(desktopConfig)}</pre>
    <p style="margin:0 0 20px;font-size:13px;color:#6e6e73">Restart Claude Desktop. Requires Node.js (nodejs.org).</p>
    <h2 style="font-size:16px;margin:0 0 8px">Test it</h2>
    <p style="margin:0 0 20px;font-size:14px">In a chat with the connector on, say: <em>"Remember that my test sync word is banana."</em> Then on another device: <em>"What's my test sync word?"</em></p>
    <p style="margin:0 0 6px;font-size:13px;color:#6e6e73">The full setup guide is in your Quantum Brain product kit (2-Quantum-Brain-Cloud-Connector-Setup.md).</p>
    <p style="margin:0;font-size:13px;color:#6e6e73">Questions or a lost key? Just reply to this email.</p>
  </div>
  <p style="text-align:center;color:#a1a1a6;font-size:12px;margin:16px 0 0">AI Skill Drops · Quantum Brain</p>
</div>
</body></html>`;

  return { subject, text, html };
}

/**
 * Sends via Resend. Throws EmailError on a non-2xx so the webhook can answer
 * 500 and let Stripe retry — the customers row records whether the email
 * landed, so the retry resends rather than re-provisioning.
 */
export async function sendActivationEmail(env: Env, input: ActivationEmailInput): Promise<{ id: string }> {
  if (!env.RESEND_API_KEY) throw new EmailError(503, "RESEND_API_KEY is not configured");
  const from = env.EMAIL_FROM || "support@getaiskilldrops.com";
  const replyTo = env.EMAIL_REPLY_TO || undefined;
  const rendered = renderActivationEmail({ ...input, supportEmail: input.supportEmail ?? replyTo });

  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: from.includes("<") ? from : `Quantum Brain <${from}>`,
      to: [input.to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new EmailError(res.status, `Resend ${res.status}: ${body.slice(0, 300)}`);
  try { return { id: (JSON.parse(body) as { id?: string }).id ?? "" }; } catch { return { id: "" }; }
}
