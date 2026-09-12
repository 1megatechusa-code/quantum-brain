import { describe, it, expect } from "vitest";
import {
  sanitizeFilename, fileR2Key, parseFileTags, decodeBase64,
  FILE_TAG, MAX_FILE_BYTES, MAX_MCP_FILE_BYTES,
} from "../../src/files/store";

describe("sanitizeFilename", () => {
  it("keeps an ordinary filename unchanged", () => {
    expect(sanitizeFilename("invoice-2026.pdf")).toBe("invoice-2026.pdf");
  });

  it("strips a path prefix down to the basename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\s\\Desktop\\notes.txt")).toBe("notes.txt");
  });

  it("replaces unsafe characters rather than dropping the file", () => {
    expect(sanitizeFilename("report (final)!.docx")).toBe("report__final__.docx");
  });

  it("falls back to a default name when nothing safe survives", () => {
    expect(sanitizeFilename("///")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
  });

  it("caps length rather than producing an unusable key", () => {
    const long = "a".repeat(500) + ".txt";
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(200);
  });
});

describe("fileR2Key", () => {
  it("namespaces by workspace and entry id, sanitizing the filename", () => {
    expect(fileR2Key("ws-abc", "entry-1", "my file.png")).toBe("files/ws-abc/entry-1/my_file.png");
  });

  it("still produces a valid, distinct key for the pre-tenancy empty workspace", () => {
    expect(fileR2Key("", "entry-1", "x.png")).toBe("files//entry-1/x.png");
  });
});

describe("parseFileTags / fileTagsFor round trip (via a real storeFile-shaped tag set)", () => {
  it("recovers the same metadata that a real upload would have written", () => {
    const tags = [
      FILE_TAG,
      "file-key:files/ws-1/e1/report.pdf",
      "file-name:report.pdf",
      "file-mime:application/pdf",
      "file-size:12345",
      "some-other-tag",
    ];
    expect(parseFileTags(tags)).toEqual({
      r2Key: "files/ws-1/e1/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 12345,
    });
  });

  it("returns null for an entry with no file tag at all", () => {
    expect(parseFileTags(["kind:semantic", "some-tag"])).toBeNull();
  });

  it("returns null when the file tag is present but the pointer is incomplete", () => {
    expect(parseFileTags([FILE_TAG, "file-name:only-a-name.txt"])).toBeNull();
  });

  it("returns null when the size tag isn't a number", () => {
    expect(parseFileTags([FILE_TAG, "file-key:k", "file-name:n", "file-mime:m", "file-size:not-a-number"])).toBeNull();
  });
});

describe("decodeBase64", () => {
  it("round-trips arbitrary bytes, including non-ASCII byte values", () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
    const b64 = btoa(String.fromCharCode(...original));
    expect(decodeBase64(b64)).toEqual(original);
  });

  it("decodes an empty string to zero bytes", () => {
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
  });
});

describe("size ceilings", () => {
  it("keeps the MCP ceiling meaningfully smaller than the HTTP ceiling", () => {
    // The MCP path pays a base64 + prompt-context tax the HTTP path doesn't;
    // if these ever converged it would mean someone raised MAX_MCP_FILE_BYTES
    // without thinking about that tax, which is the mistake this pins against.
    expect(MAX_MCP_FILE_BYTES).toBeLessThan(MAX_FILE_BYTES);
  });
});
