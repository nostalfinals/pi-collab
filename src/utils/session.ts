import { existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  loadSkills,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type ResolvedResource,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { selectItems, type CollaboratorConfig, type SelectionRule } from "../config.ts";
import { text } from "../text.ts";
import { collabToolNames } from "../tools.ts";

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

export function findCollaboratorLeaf(entries: SessionEntry[], anchorId: string): string | null {
  const anchorIndex = entries.findIndex((entry) => entry.id === anchorId);

  if (anchorIndex === -1) {
    return null;
  }

  let leafId = anchorId;

  for (const entry of entries.slice(anchorIndex + 1)) {
    const isUserMessage = entry.type === "message" && entry.message.role === "user";
    if (entry.parentId === leafId && !isUserMessage) {
      leafId = entry.id;
    }
  }

  return leafId;
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

const builtinExtensionNames = ["codemode", "tool-search", "mcp"];
const mcpResourceToolNames = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || mcpResourceToolNames.has(name);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pathKey(path: string): string {
  if (path.startsWith("builtin:")) {
    return path;
  }
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithinPath(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(parentPath.endsWith(sep) ? parentPath : parentPath + sep);
}

// Settings entries are resolved against the agent directory or the project config directory.
function scopeBaseDir(scope: ResolvedResource["metadata"]["scope"], cwd: string, agentDir: string): string | undefined {
  switch (scope) {
    case "user":
      return agentDir;
    case "project":
      return join(cwd, CONFIG_DIR_NAME);
    default:
      return undefined;
  }
}

function extensionEntryNames(entry: ResolvedResource, cwd: string, agentDir: string): string[] {
  if (entry.metadata.source === "builtin") {
    return [entry.path];
  }
  if (entry.metadata.origin === "package") {
    return [entry.metadata.source, entry.path];
  }
  const baseDir = entry.metadata.baseDir ?? scopeBaseDir(entry.metadata.scope, cwd, agentDir);
  return baseDir ? [relative(baseDir, entry.path).split(sep).join("/"), entry.path] : [entry.path];
}

// Mirrors DefaultResourceLoader.mapSkillPath: a settings directory entry points at its SKILL.md.
function mapSkillEntryPath(entry: ResolvedResource): string {
  if (entry.metadata.source !== "auto" && entry.metadata.origin !== "package") {
    return entry.path;
  }
  try {
    if (!statSync(entry.path).isDirectory()) {
      return entry.path;
    }
  } catch {
    return entry.path;
  }
  const skillFile = join(entry.path, "SKILL.md");
  return existsSync(skillFile) ? skillFile : entry.path;
}

export function selectCollaboratorTools(
  rule: SelectionRule,
  leadTools: string[],
  registeredTools: string[],
  activeTools: string[],
): { names: string[]; unmatched: string[] } {
  const candidates = registeredTools.filter((name) => !isMcpToolName(name));
  const candidateNames = new Set(candidates);
  const current = leadTools.filter(
    (name) => !collabToolNames.includes(name) && !isMcpToolName(name) && candidateNames.has(name),
  );
  const selection = selectItems(rule, current, candidates, (name) => [name]);
  const activeMcpTools = activeTools.filter(isMcpToolName);

  return { names: [...selection.selected, ...activeMcpTools], unmatched: selection.unmatched };
}

export type CollaboratorSessionOptions = {
  ctx: ExtensionContext;
  extensionPath: string;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  config: CollaboratorConfig;
  leadTools: string[];
  // The collaborator entry recorded by the latest Lead anchor on the current branch.
  anchorEntryId: string | undefined;
};

// Opens the collaborator session file for the current Lead session, or creates one,
// and positions its leaf at the point the latest anchor refers to.
export async function createCollaboratorSession(options: CollaboratorSessionOptions): Promise<AgentSession> {
  const { ctx, extensionPath, config, anchorEntryId } = options;
  const agentDir = getAgentDir();
  const role = (await readFile(join(dirname(extensionPath), "../prompts/collaborator_role.md"), "utf8")).trim();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  const packageManager = new DefaultPackageManager({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
    builtinExtensions: builtinExtensionNames,
  });
  const resolved = await packageManager.resolve();

  const ownExtensionKey = pathKey(extensionPath);
  const extensionEntries = resolved.extensions.filter((entry) => pathKey(entry.path) !== ownExtensionKey);
  const extensionSelection = selectItems(
    config.extensions,
    extensionEntries.filter((entry) => entry.enabled),
    extensionEntries,
    (entry) => extensionEntryNames(entry, ctx.cwd, agentDir),
  );

  const skillEntries = resolved.skills.map((resource) => ({ resource, path: mapSkillEntryPath(resource) }));
  const enabledSkillPaths = unique(skillEntries.filter((entry) => entry.resource.enabled).map((entry) => entry.path));
  const disabledSkillPaths = unique(
    skillEntries.filter((entry) => !entry.resource.enabled).map((entry) => entry.path),
  ).filter((path) => !enabledSkillPaths.includes(path));
  // Enabled paths first so a name collision with a disabled skill keeps the enabled one.
  const skillPaths = unique([...enabledSkillPaths, ...disabledSkillPaths]);
  const { skills: allSkills } = loadSkills({ cwd: ctx.cwd, agentDir, skillPaths, includeDefaults: false });
  const skillIsEnabled = (filePath: string): boolean =>
    enabledSkillPaths.some((root) => isWithinPath(root, filePath)) ||
    !disabledSkillPaths.some((root) => isWithinPath(root, filePath));
  const currentSkills = allSkills.filter((skill) => skillIsEnabled(skill.filePath));
  const skillSelection = selectItems(config.skills, currentSkills, allSkills, (skill) => [skill.name]);

  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: unique(extensionSelection.selected.map((entry) => entry.path)),
    additionalSkillPaths: unique(
      skillSelection.selected.filter((skill) => !skillIsEnabled(skill.filePath)).map((skill) => skill.filePath),
    ),
    noExtensions: true,
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
      { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
      { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
      {
        name: "collab-role",
        factory: (collaboratorPi) => {
          collaboratorPi.on("before_agent_start", (event) => {
            event.systemPromptOptions.sections.collaborator_role = role;
          });
        },
      },
    ],
    // Skills that extensions discover at runtime are not known during selection, so apply the
    // rule to the final skill list: the base is everything enabled plus discovered skills.
    skillsOverride: (base) => {
      const current = base.skills.filter((skill) => skillIsEnabled(skill.filePath));
      const selection = selectItems(config.skills, current, base.skills, (skill) => [skill.name]);
      return { skills: selection.selected, diagnostics: base.diagnostics };
    },
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
    resourceLoader,
    settingsManager,
    sessionManager,
  });

  await session.bindExtensions({
    onError: (error) => {
      options.ctx.ui.notify(text.ui.collaboratorExtensionError(error.extensionPath, error.error, error.stack), "error");
    },
  });

  const toolSelection = selectCollaboratorTools(
    config.tools,
    options.leadTools,
    session.getAllTools().map((tool) => tool.name),
    session.getActiveToolNames(),
  );
  session.setActiveToolsByName(toolSelection.names);

  const unmatched = {
    extensions: extensionSelection.unmatched,
    skills: skillSelection.unmatched,
    tools: toolSelection.unmatched,
  };

  if (unmatched.extensions.length + unmatched.skills.length + unmatched.tools.length > 0) {
    ctx.ui.notify(text.ui.unmatchedSelection(unmatched), "warning");
  }

  return session;
}
