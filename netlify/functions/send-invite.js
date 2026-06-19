exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Resend API key is not configured in Netlify." });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid email payload." });
  }

  const toEmail = String(payload.to_email || "").trim();
  const subject = String(payload.subject || "Workspace invitation").trim();
  const message = String(payload.message || "").trim();
  const fromName = String(payload.from_name || "Avantex Flow").trim();
  const fromEmail = String(process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev").trim();

  if (!toEmail || !toEmail.includes("@")) {
    return json(400, { error: "Invite recipient email is required." });
  }
  if (!message) {
    return json(400, { error: "Invite message is required." });
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [toEmail],
      subject,
      text: message,
      html: emailHtml(payload, message)
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json(response.status, { error: result.message || "Resend could not send invite email." });
  }

  return json(200, { ok: true, id: result.id });
};

function emailHtml(payload, message) {
  const inviteLink = escapeHtml(payload.invite_link || "");
  const workspaceName = escapeHtml(payload.workspace_name || "your workspace");
  const fromName = escapeHtml(payload.from_name || "Workspace Admin");
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#18212f">
      <h2 style="margin:0 0 12px">You are invited to ${workspaceName}</h2>
      <p>${fromName} invited you to join ${workspaceName} on Avantex Flow.</p>
      <p><a href="${inviteLink}" style="display:inline-block;background:#111820;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:700">Accept Invite</a></p>
      <p style="color:#536072">${safeMessage}</p>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}
