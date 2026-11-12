import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { text } from "./text.ts";
import type { CollabConfig } from "./types.ts";

export type SelectionRule = string[] | { include: string[]; exclude: string[] };

export type CollaboratorConfig = {
  extensions: SelectionRule;
  skills: SelectionRule;
  tools: SelectionRule;
};

export type CollabSettings = {
  collaborator: CollaboratorConfig;
  default?: CollabConfig;
  autoEnable: boolean;
};

const ruleFields = ["extensions", "skills", "tools"] as const;
const ruleObjectKeys = ["include", "exclude"] as const;
const defaultFields = ["model", "thinkingLevel"] as const;
const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

function getCollabConfigPath(): string {
  return join(getAgentDir(), "collab.json");
}

export function defaultCollaboratorConfig(): CollaboratorConfig {
  return {
    extensions: { include: [], exclude: [] },
    skills: { include: [], exclude: [] },
    tools: { include: [], exclude: [] },
  };
}

export function loadCollabConfig(): CollabSettings {
  const path = getCollabConfigPath();

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ collaborator: defaultCollaboratorConfig() }, null, 2)}\n`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(text.config.invalidJson(path, error instanceof Error ? error.message : String(error)));
  }

  if (!isRecord(parsed)) {
    throw new Error(text.config.invalidTopLevel(path));
  }

  const collaborator = parsed.collaborator;

  if (collaborator !== undefined && !isRecord(collaborator)) {
    throw new Error(text.config.invalidCollaborator(path));
  }

  const rules = collaborator ?? {};
  const config = defaultCollaboratorConfig();

  for (const field of ruleFields) {
    const rule = rules[field];
    if (rule !== undefined) {
      config[field] = parseRule(rule, field, path);
    }
  }

  const defaultConfig = parsed.default === undefined ? undefined : parseDefault(parsed.default, path);

  if (parsed.autoEnable !== undefined && typeof parsed.autoEnable !== "boolean") {
    throw new Error(text.config.invalidAutoEnable(path));
  }

  const autoEnable = parsed.autoEnable === true;

  if (autoEnable && !defaultConfig) {
    throw new Error(text.config.autoEnableWithoutDefault(path));
  }

  return { collaborator: config, default: defaultConfig, autoEnable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(value: unknown, field: string, path: string): SelectionRule {
  if (Array.isArray(value)) {
    return parseNameList(value, field, path);
  }

  if (!isRecord(value)) {
    throw new Error(text.config.invalidRule(path, field));
  }

  for (const key of Object.keys(value)) {
    if (!(ruleObjectKeys as readonly string[]).includes(key)) {
      throw new Error(text.config.unknownRuleKey(path, field, key));
    }
  }

  return {
    include: value.include === undefined ? [] : parseNameList(value.include, `${field}.include`, path),
    exclude: value.exclude === undefined ? [] : parseNameList(value.exclude, `${field}.exclude`, path),
  };
}

function parseDefault(value: unknown, path: string): CollabConfig {
  if (!isRecord(value)) {
    throw new Error(text.config.invalidDefault(path));
  }

  for (const key of Object.keys(value)) {
    if (!(defaultFields as readonly string[]).includes(key)) {
      throw new Error(text.config.unknownDefaultKey(path, key));
    }
  }

  const model = value.model;

  if (typeof model !== "string") {
    throw new Error(text.config.invalidDefaultModel(path));
  }

  const separator = model.indexOf("/");

  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(text.config.invalidDefaultModel(path));
  }

  const thinkingLevel = value.thinkingLevel;

  if (typeof thinkingLevel !== "string" || !(thinkingLevels as readonly string[]).includes(thinkingLevel)) {
    throw new Error(text.config.invalidDefaultThinkingLevel(path));
  }

  return {
    provider: model.slice(0, separator),
    modelId: model.slice(separator + 1),
    thinkingLevel: thinkingLevel as ModelThinkingLevel,
  };
}

function parseNameList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(text.config.invalidNameList(path, field));
  }
  return value;
}

// A rule's list is an allowlist. An object rule starts from the current items, adds
// include matches, then removes exclude matches.
export function selectItems<T>(
  rule: SelectionRule,
  current: T[],
  candidates: T[],
  namesOf: (item: T) => string[],
): { selected: T[]; unmatched: string[] } {
  const include = Array.isArray(rule) ? rule : rule.include;
  const exclude = Array.isArray(rule) ? [] : rule.exclude;
  const allowlist = Array.isArray(rule);
  const currentItems = new Set(current);

  const matches = (item: T, entry: string): boolean => namesOf(item).some((name) => wildcardMatch(entry, name));
  const matchesAny = (item: T, entries: string[]): boolean => entries.some((entry) => matches(item, entry));

  const selected = candidates.filter((item) => {
    const kept = allowlist ? matchesAny(item, include) : currentItems.has(item) || matchesAny(item, include);
    return kept && !matchesAny(item, exclude);
  });

  const unmatched = [...include, ...exclude].filter((entry) => !candidates.some((item) => matches(item, entry)));

  return { selected, unmatched };
}

// `*` matches any characters; every other character is literal.
function wildcardMatch(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}
