import { describe, it, expect } from "vitest";
import { extractSubdomain } from "./subdomain-funnel-resolver";

describe("extractSubdomain", () => {
  it("returns the subdomain for a normal host", () => {
    expect(extractSubdomain("https://protect.advantageheatingllc.com/quote")).toBe("protect");
  });

  it("lowercases the host", () => {
    expect(extractSubdomain("https://Protect.Example.COM/")).toBe("protect");
  });

  it("strips a leading www. before extracting", () => {
    expect(extractSubdomain("https://www.protect.example.com")).toBe("protect");
  });

  it("returns null for an apex domain", () => {
    expect(extractSubdomain("https://example.com")).toBe(null);
  });

  it("returns null when the only label before the apex is www", () => {
    expect(extractSubdomain("https://www.example.com")).toBe(null);
  });

  it("returns null for empty / missing url", () => {
    expect(extractSubdomain(null)).toBe(null);
    expect(extractSubdomain("")).toBe(null);
    expect(extractSubdomain(undefined)).toBe(null);
  });

  it("returns null for a malformed url", () => {
    expect(extractSubdomain("not a url")).toBe(null);
  });

  it("supports multi-label subdomains", () => {
    expect(extractSubdomain("https://a.b.example.com/path")).toBe("a.b");
  });
});
