// Consent and error pages for the OAuth flow. Pure string rendering, no
// library imports: every value here may come from the connecting client, so
// everything goes through escapeHtml before it reaches the markup
// (plans/oauth-mcp.md, step 3).

export interface ClientFacts {
  clientName: string;
  clientDomain?: string;
  redirectUri: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function htmlHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    // No form-action: Chrome applies it to the post-submit redirect, which
    // goes to the client's redirect URI (OpenAI, Anthropic), not to us.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; display: flex;
         min-height: 100vh; align-items: center; justify-content: center;
         background: #f5f5f7; color: #1d1d1f; }
  main { background: #fff; border-radius: 12px; padding: 2rem; max-width: 32rem;
         box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { line-height: 1.5; }
  .fact { margin: .25rem 0; }
  .warn { background: #fff4e5; border-radius: 8px; padding: .75rem 1rem; }
  .error { background: #fdecea; border-radius: 8px; padding: .75rem 1rem; font-weight: 600; }
  form { margin-top: 1.5rem; display: grid; gap: .75rem; }
  label { font-weight: 600; }
  input[type=password] { font: inherit; padding: .5rem .75rem; border: 1px solid #999;
                         border-radius: 8px; }
  .buttons { display: flex; gap: .75rem; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 8px; border: 1px solid #999;
           background: #fff; cursor: pointer; }
  button.primary { background: #0071e3; border-color: #0071e3; color: #fff; }
  @media (prefers-color-scheme: dark) {
    body { background: #1d1d1f; color: #f5f5f7; }
    main { background: #2c2c2e; }
    .warn { background: #3a2f1d; }
    .error { background: #3a1f1d; }
    input[type=password], button { background: #2c2c2e; color: inherit; }
    button.primary { background: #0a84ff; border-color: #0a84ff; color: #fff; }
  }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function clientFactsHtml(client: ClientFacts): string {
  const name = client.clientDomain
    ? `<strong>${escapeHtml(client.clientName)}</strong> (${escapeHtml(client.clientDomain)})`
    : `<strong>${escapeHtml(client.clientName)}</strong>`;
  const lines = [
    `<p class="fact">Connecting app: ${name}</p>`,
    `<p class="fact">Redirects to: ${escapeHtml(client.redirectHost)} <span class="fact">(${escapeHtml(client.redirectUri)})</span></p>`,
  ];
  if (client.redirectIsLoopback) {
    lines.push(
      `<p class="warn">The sign-in completes in a local app on this computer. Any local process could be listening on that address, whatever the app claims to be.</p>`,
    );
  }
  return lines.join("\n");
}

export function tokenEntryPage(options: { client: ClientFacts; authQuery: string; error?: string }): string {
  const { client, authQuery, error } = options;
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  return page(
    "Connect iCloud Mail",
    `<h1>Connect iCloud Mail</h1>
${clientFactsHtml(client)}
<p>Signing in grants this app access to the mailbox folders this proxy exposes, and lets it send mail and save drafts from this address.</p>
${errorHtml}
<form method="post" action="/authorize">
<input type="hidden" name="authQuery" value="${escapeHtml(authQuery)}">
<label for="token">API token</label>
<input type="password" id="token" name="token" autocomplete="off" spellcheck="false" required>
<button type="submit" class="primary">Continue</button>
</form>`,
  );
}

// The consent form carries the grant epoch of the API token that was
// verified at sign-in (see oauth-authorize.ts): the consent handler refuses
// to mint a grant when the token has rotated since.
export function consentPage(options: { client: ClientFacts; handle: string; epoch: string }): string {
  const { client, handle, epoch } = options;
  return page(
    "Approve access",
    `<h1>Approve access</h1>
${clientFactsHtml(client)}
<p class="fact">This app will be able to:</p>
<p class="fact"><strong>Read mail (mail:read)</strong> — list folders, search messages, read message bodies and download allowed attachments. It can also <strong>send mail and save drafts</strong> as this address; it cannot move, flag, or delete anything in the mailbox.</p>
<form method="post" action="/authorize/consent">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="epoch" value="${escapeHtml(epoch)}">
<div class="buttons">
<button type="submit" name="action" value="approve" class="primary">Approve</button>
<button type="submit" name="action" value="deny">Deny</button>
</div>
</form>`,
  );
}

export function errorPage(message: string, status: number): string {
  return page(
    `Error ${status}`,
    `<h1>Error ${status}</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>`,
  );
}
