import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { truncateText } from "../src/truncation.ts";

it("truncates reports over 50 KB and saves the full report", async () => {
  const report = "a".repeat(60 * 1024);
  const result = await truncateText(report);

  if (!result) {
    throw new Error("Expected the report to be truncated");
  }

  expect(result.truncated.length).toBeLessThan(report.length);

  try {
    expect((await stat(result.fullOutputPath)).isFile()).toBe(true);
    expect(await readFile(result.fullOutputPath, "utf8")).toBe(report);
  } finally {
    await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
  }
});
