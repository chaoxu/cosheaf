import { describe, expect, it } from "vitest";
import { contentTypeForPath, isLikelyTextContent, repositoryRawHeadersForPath } from "./content-type.js";

function rawHeaders(filePath: string): Record<string, string> {
  return repositoryRawHeadersForPath(filePath) as Record<string, string>;
}

describe("content type helpers", () => {
  it("keeps built asset content types intact", () => {
    expect(contentTypeForPath("assets/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForPath("assets/style.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeForPath("assets/icon.svg")).toBe("image/svg+xml");
    expect(contentTypeForPath("assets/font.woff2")).toBe("font/woff2");
  });

  it("serves active repository raw text as inert text", () => {
    const html = rawHeaders("docs/payload.html");
    expect(html["content-type"]).toBe("text/plain; charset=utf-8");
    expect(html["x-content-type-options"]).toBe("nosniff");
    expect(html["content-security-policy"]).toContain("sandbox");

    const script = rawHeaders("docs/payload.js");
    expect(script["content-type"]).toBe("text/plain; charset=utf-8");
    expect(script["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps passive previews usable while adding raw safety headers", () => {
    const pdf = rawHeaders("docs/sample.pdf");
    expect(pdf["content-type"]).toBe("application/pdf");
    expect(pdf["x-content-type-options"]).toBe("nosniff");
    expect(pdf["content-security-policy"]).toBeUndefined();

    const svg = rawHeaders("showcase/hover-preview-figure.svg");
    expect(svg["content-type"]).toBe("image/svg+xml");
    expect(svg["x-content-type-options"]).toBe("nosniff");
    expect(svg["content-security-policy"]).toContain("script-src 'none'");
  });

  it("can sniff extensionless raw text without treating binary bytes as text", () => {
    expect(isLikelyTextContent(Buffer.from("plain text\nwith utf-8 π\n"))).toBe(true);
    expect(isLikelyTextContent(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))).toBe(false);

    const makefile = repositoryRawHeadersForPath("Makefile", Buffer.from("test:\n\tpnpm test\n"));
    expect(makefile["content-type"]).toBe("text/plain; charset=utf-8");

    const binary = repositoryRawHeadersForPath("artifact", Buffer.from([0, 1, 2, 3]));
    expect(binary["content-type"]).toBe("application/octet-stream");
  });
});
