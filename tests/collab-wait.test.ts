import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { truncateText } from "../src/utils/truncation.ts";

describe("truncateText", () => {
  it("keeps the first 2000 lines of a report with more lines and saves the full report", async () => {
    const lines = Array.from({ length: 2500 }, (_, index) => `line ${index}`);
    const report = lines.join("\n");
    const truncation = await truncateText(report, "head");

    if (!truncation) {
      throw new Error("Expected the report to be truncated");
    }

    try {
      expect(truncation.result.truncatedBy).toBe("lines");
      expect(truncation.result.content).toBe(lines.slice(0, 2000).join("\n"));
      expect(await readFile(truncation.fullOutputPath, "utf8")).toBe(report);
    } finally {
      await rm(dirname(truncation.fullOutputPath), { recursive: true, force: true });
    }
  });

  it("keeps the complete lines that fit in 50 KB when a later line crosses the limit", async () => {
    // 100 lines of 1 KB each, newline included.
    const lines = Array.from({ length: 100 }, () => "a".repeat(1023));
    const report = lines.join("\n");
    const truncation = await truncateText(report, "head");

    if (!truncation) {
      throw new Error("Expected the report to be truncated");
    }

    try {
      expect(truncation.result.truncatedBy).toBe("bytes");
      expect(truncation.result.firstLineExceedsLimit).toBe(false);
      expect(truncation.result.content).toBe(lines.slice(0, 50).join("\n"));
      expect(await readFile(truncation.fullOutputPath, "utf8")).toBe(report);
    } finally {
      await rm(dirname(truncation.fullOutputPath), { recursive: true, force: true });
    }
  });
});
