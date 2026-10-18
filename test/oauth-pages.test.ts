import { describe, expect, it } from "vitest";
import { consentPage, errorPage, escapeHtml, htmlHeaders, tokenEntryPage } from "../src/oauth-pages";

const CLIENT = {
  clientName: "Example App",
  clientDomain: "example.com",
  redirectUri: "https://example.com/callback",
  redirectHost: "example.com",
  redirectIsLoopback: false,
};

describe("escapeHtml", () => {
  it("escapes text and attribute metacharacters", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
  });
});

describe("tokenEntryPage", () => {
  it("shows the client facts, the fixed wording, and a password field", () => {
    const html = tokenEntryPage({ client: CLIENT, authQuery: "client_id=x&state=y" });
    expect(html).toContain("Example App");
    expect(html).toContain("example.com");
    expect(html).toContain("lets it send mail and save drafts from this address");
    expect(html).toContain('<input type="password" id="token" name="token"');
    expect(html).toContain('method="post" action="/authorize"');
    expect(html).toContain('name="authQuery" value="client_id=x&amp;state=y"');
  });

  it("warns about loopback redirects", () => {
    const html = tokenEntryPage({
      client: { ...CLIENT, redirectUri: "http://127.0.0.1:1455/callback", redirectHost: "127.0.0.1", redirectIsLoopback: true },
      authQuery: "",
    });
    expect(html).toContain("local app on this computer");
  });

  it("escapes hostile client facts and query values everywhere they appear", () => {
    const html = tokenEntryPage({
      client: {
        clientName: `"><script>alert(1)</script>`,
        clientDomain: `evil" onmouseover="x`,
        redirectUri: `https://evil.com/"><img src=x>`,
        redirectHost: `"><b>host`,
        redirectIsLoopback: false,
      },
      authQuery: `state="><script>alert(2)</script>`,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain(`onmouseover="x"`);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
  });
});

describe("consentPage", () => {
  it("shows one fixed permission and posts handle, epoch plus action", () => {
    const html = consentPage({ client: CLIENT, handle: "h-1", epoch: "epoch-1" });
    expect(html).toContain("Read mail (mail:read)");
    expect(html).toContain("send mail and save drafts");
    expect(html).not.toContain("It cannot send");
    expect(html).toContain('name="handle" value="h-1"');
    expect(html).toContain('name="epoch" value="epoch-1"');
    expect(html).toContain('method="post" action="/authorize/consent"');
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="deny"');
  });

  it("offers no scope selection", () => {
    const html = consentPage({ client: CLIENT, handle: "h-1", epoch: "epoch-1" });
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toMatch(/name="scope/);
  });

  it("escapes a hostile consent handle and epoch", () => {
    const html = consentPage({ client: CLIENT, handle: `"><script>alert(1)</script>`, epoch: `"><img src=x>` });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain(`value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
    expect(html).toContain(`value="&quot;&gt;&lt;img src=x&gt;"`);
  });
});

describe("errorPage", () => {
  it("escapes the message and carries the status", () => {
    const html = errorPage(`<b>bad</b>`, 400);
    expect(html).toContain("Error 400");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).not.toContain("<b>bad</b>");
  });
});

describe("htmlHeaders", () => {
  it("locks the page down without a form-action directive", () => {
    const headers = htmlHeaders();
    expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("base-uri 'none'");
    expect(headers["Content-Security-Policy"]).not.toContain("form-action");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
  });
});
