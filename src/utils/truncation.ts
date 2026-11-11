import {
  truncateHead,
  truncateTail,
  type TruncationOptions,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function truncateText(
  text: string,
  mode: "head" | "tail",
  options?: TruncationOptions,
): Promise<{ result: TruncationResult; fullOutputPath: string } | undefined> {
  let result;

  switch (mode) {
    case "head":
      result = truncateHead(text, options);
      break;
    case "tail":
      result = truncateTail(text, options);
      break;
  }

  if (!result.truncated) {
    return undefined;
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-collab-"));
  const fullOutputPath = join(tempDirectory, "truncated.txt");
  await writeFile(fullOutputPath, text, "utf-8");
  return { result: result, fullOutputPath };
}
