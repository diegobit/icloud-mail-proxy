import { describe, it, expect } from "vitest";
import { htmlToText } from "../src/html-text";

describe("htmlToText", () => {
  it("strips all tags, leaving no < or > remnants", () => {
    const out = htmlToText("<p>Hello <b>world</b> and <i>everyone</i></p>");
    expect(out).toBe("Hello world and everyone");
    expect(out).not.toMatch(/[<>]/);
  });

  it("drops script, style, head and comments with their contents", () => {
    const html =
      "<head><title>ignored</title></head>" +
      "<style>.a{color:red}</style>" +
      "<!-- tracking pixel comment -->" +
      "<p>Visible</p>" +
      "<script>alert('x'); if (a < b) {}</script>" +
      "<p>Tail</p>";
    const out = htmlToText(html);
    expect(out).toBe("Visible\nTail");
    expect(out).not.toContain("ignored");
    expect(out).not.toContain("color");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("tracking");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("A &amp; B &lt; C &gt; D &quot;q&quot; &#39;s&#39;")).toBe(
      'A & B < C > D "q" \'s\'',
    );
    expect(htmlToText("caf&#233; &#x1F600; &#38;")).toBe("café 😀 &");
  });

  it("does not double-decode entities", () => {
    // &amp;lt; must yield the literal text "&lt;", not "<".
    expect(htmlToText("<p>&amp;lt;</p>")).toBe("&lt;");
  });

  it("treats a non-breaking space as a normal, collapsible space", () => {
    expect(htmlToText("<p>a&nbsp;&nbsp;b</p>")).toBe("a b");
  });

  it("renders links as `label (url)` for differing http(s) targets", () => {
    expect(
      htmlToText('<a href="https://example.com/pay">Pay now</a>'),
    ).toBe("Pay now (https://example.com/pay)");
  });

  it("shows only the label when it already equals the url", () => {
    expect(
      htmlToText('<a href="https://example.com">https://example.com</a>'),
    ).toBe("https://example.com");
  });

  it("keeps only the label for non-http links (mailto, relative)", () => {
    expect(htmlToText('<a href="mailto:a@b.com">Email us</a>')).toBe("Email us");
    expect(htmlToText('<a href="/local/path">Home</a>')).toBe("Home");
  });

  it("uses the url alone when the link has no visible label", () => {
    expect(
      htmlToText('<a href="https://example.com/img"><img src="x.png"></a>'),
    ).toBe("https://example.com/img");
  });

  it("turns <br> into newlines", () => {
    expect(htmlToText("line one<br>line two<br/>line three")).toBe(
      "line one\nline two\nline three",
    );
  });

  it("bullets list items and breaks paragraphs onto new lines", () => {
    const html = "<p>Shopping</p><ul><li>Milk</li><li>Bread</li></ul>";
    expect(htmlToText(html)).toBe("Shopping\n- Milk\n- Bread");
  });

  it("collapses whitespace and caps blank lines", () => {
    const html = "<p>a  \t b</p>\n\n\n\n<p>c</p>";
    expect(htmlToText(html)).toBe("a b\n\nc");
  });

  it("converts a realistic marketing email with no tag remnants", () => {
    const html = `
      <!DOCTYPE html>
      <head><title>Newsletter</title><style>body{margin:0}</style></head>
      <!-- open-tracking beacon -->
      <div style="font-family:Arial">
        <h1>Summer Sale &amp; More</h1>
        <p>Hi there,&nbsp;save up to 50%25 this week.</p>
        <p>Our top picks:</p>
        <ul>
          <li>Shoes &mdash; comfy</li>
          <li>Bags</li>
        </ul>
        <p>
          <a href="https://shop.example.com/sale?ref=email&amp;id=7">Shop the sale</a>
        </p>
        <script>track('open');</script>
      </div>
      <p>Unsubscribe <a href="https://shop.example.com/u">here</a>.</p>
    `;
    const out = htmlToText(html);
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain("track(");
    expect(out).not.toContain("margin");
    expect(out).toContain("Summer Sale & More");
    expect(out).toContain("- Shoes");
    expect(out).toContain("- Bags");
    expect(out).toContain("Shop the sale (https://shop.example.com/sale?ref=email&id=7)");
    expect(out).toContain("Unsubscribe here (https://shop.example.com/u).");
  });
});
