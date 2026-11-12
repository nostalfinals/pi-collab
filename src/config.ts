import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { text } from "./text.ts";

export type SelectionRule = string[] | { include: string[]; exclude: string[] };

export type CollaboratorConfig = {
  extensions: SelectionRule;
  skills: SelectionRule;
  tools: SelectionRule;
};

const ruleFields = ["extensions", "skills", "tools"] as const;
const ruleObjectKeys = ["include", "exclude"] as const;

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

export function loadCollabConfig(): CollaboratorConfig {
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

  return config;
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
