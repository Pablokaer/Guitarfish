import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/html";

describe("escapeHtml", () => {
  it("escapes markup and quotes", () => {
    expect(escapeHtml(`<b class="x">Tom & Jerry's</b>`)).toBe("&lt;b class=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;");
    expect(escapeHtml("plain")).toBe("plain");
  });
});
