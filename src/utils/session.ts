import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { text } from "../text.ts";

async function findCollaboratorFile(sessionDir: string, leadSessionId: string): Promise<string | undefined> {
  const collabDir = join(sessionDir, "collab");
  let names: string[];

  try {
    names = await readdir(collabDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const name = names.find((name) => name === `${leadSessionId}.jsonl` || name.endsWith(`_${leadSessionId}.jsonl`));
  return name ? join(collabDir, name) : undefined;
}

function findCollaboratorLeaf(entries: SessionEntry[], anchorId: string): string | null {
  const anchorIndex = entries.findIndex((entry) => entry.id === anchorId);
  if (anchorIndex === -1) {
    return null;
  }

  const nextUserIndex = entries.findIndex(
    (entry, index) => index > anchorIndex && entry.type === "message" && entry.message.role === "user",
  );
  if (nextUserIndex === -1) {
    return entries.at(-1)?.id ?? null;
  }

  for (let i = nextUserIndex - 1; i > anchorIndex; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message.role === "assistant") {
      return entry.id;
    }
  }
  return entries[nextUserIndex - 1]?.id ?? entries[anchorIndex]?.id ?? null;
}

export async function copyCollaboratorFile(
  previousSessionFile: string,
  sessionDir: string,
  sessionId: string,
): Promise<void> {
  const previousId = SessionManager.open(previousSessionFile).getSessionId();
  const source = await findCollaboratorFile(dirname(previousSessionFile), previousId);

  if (!source) {
    return;
  }

  const targetDir = join(sessionDir, "collab");
  const sourceSuffix = `${previousId}.jsonl`;
  const targetName = `${basename(source).slice(0, -sourceSuffix.length)}${sessionId}.jsonl`;

  await mkdir(targetDir, { recursive: true });
  await copyFile(source, join(targetDir, targetName));
}

export type CollaboratorSessionOptions = {
  ctx: ExtensionContext;
  extensionPath: string;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  tools: string[];
  // The collaborator entry recorded by the latest Lead anchor on the current branch.
  anchorEntryId: string | undefined;
};

// Opens the collaborator session file for the current Lead session, or creates one,
// and positions its leaf at the point the latest anchor refers to.
export async function createCollaboratorSession(options: CollaboratorSessionOptions): Promise<AgentSession> {
  const { ctx, extensionPath, anchorEntryId } = options;
  const agentDir = getAgentDir();
  const role = (await readFile(join(dirname(extensionPath), "../prompts/collaborator_role.md"), "utf8")).trim();
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) => extension.resolvedPath !== extensionPath),
    }),
    extensionFactories: [
      {
        name: "collab-role",
        factory: (collaboratorPi) => {
          collaboratorPi.on("before_agent_start", (event) => {
            event.systemPromptOptions.sections.collaborator_role = role;
          });
        },
      },
    ],
  });

  await resourceLoader.reload();

  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionFile = await findCollaboratorFile(sessionDir, ctx.sessionManager.getSessionId());
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile)
    : SessionManager.create(ctx.cwd, join(sessionDir, "collab"), {
        id: ctx.sessionManager.getSessionId(),
      });
  const leafId = anchorEntryId ? findCollaboratorLeaf(sessionManager.getEntries(), anchorEntryId) : null;
  if (leafId) {
    sessionManager.branch(leafId);
  } else {
    sessionManager.resetLeaf();
  }

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: options.tools,
    resourceLoader,
    sessionManager,
  });

  await session.bindExtensions({
    onError: (error) => {
      options.ctx.ui.notify(text.ui.collaboratorExtensionError(error.extensionPath, error.error, error.stack), "error");
    },
  });

  return session;
}
