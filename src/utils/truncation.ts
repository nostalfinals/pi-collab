import { truncateTail } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function truncateText(text: string): Promise<{ truncated: string; fullOutputPath: string } | undefined> {
  const result = truncateTail(text);

  if (!result.truncated) {
    return undefined;
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-collab-"));
  const fullOutputPath = join(tempDirectory, "truncated.txt");
  await writeFile(fullOutputPath, text, "utf-8");
  return { truncated: result.content, fullOutputPath };
}
