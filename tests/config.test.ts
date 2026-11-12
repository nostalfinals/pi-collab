import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCollabConfig, selectItems, type SelectionRule } from "../src/config.ts";

const defaultConfig = {
  collaborator: {
    extensions: { include: [], exclude: [] },
    skills: { include: [], exclude: [] },
    tools: { include: [], exclude: [] },
  },
};

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = await mkdtemp(join(tmpdir(), "pi-collab-config-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(agentDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(agentDir, "collab.json");
}

async function writeConfig(content: unknown): Promise<void> {
  await writeFile(configPath(), typeof content === "string" ? content : JSON.stringify(content));
}

describe("loadCollabConfig", () => {
  it("creates collab.json with the default config when the file is missing", async () => {
    const config = loadCollabConfig();

    expect(config).toEqual(defaultConfig.collaborator);
    expect(await readFile(configPath(), "utf8")).toBe(`${JSON.stringify(defaultConfig, null, 2)}\n`);
  });

  it("fills in missing rules and fields with the default rule", async () => {
    await writeConfig({ collaborator: { tools: { include: ["read"] } } });

    expect(loadCollabConfig()).toEqual({
      extensions: { include: [], exclude: [] },
      skills: { include: [], exclude: [] },
      tools: { include: ["read"], exclude: [] },
    });

    await writeConfig({});

    expect(loadCollabConfig()).toEqual(defaultConfig.collaborator);
  });

  it("reads list rules and object rules", async () => {
    await writeConfig({
      collaborator: {
        extensions: ["a", "b*"],
        skills: { exclude: ["c"] },
        tools: { include: ["read", "write"], exclude: ["bash"] },
      },
    });

    expect(loadCollabConfig()).toEqual({
      extensions: ["a", "b*"],
      skills: { include: [], exclude: ["c"] },
      tools: { include: ["read", "write"], exclude: ["bash"] },
    });
  });

  it("throws with the file path when the file is not valid JSON", async () => {
    await writeConfig("{");

    expect(() => loadCollabConfig()).toThrow(configPath());
    expect(() => loadCollabConfig()).toThrow("not valid JSON");
  });

  it("throws when collaborator is not an object", async () => {
    await writeConfig({ collaborator: [] });

    expect(() => loadCollabConfig()).toThrow(configPath());
    expect(() => loadCollabConfig()).toThrow('"collaborator" must be an object');
  });

  it("throws when a rule is neither a string list nor an object", async () => {
    await writeConfig({ collaborator: { skills: 5 } });

    expect(() => loadCollabConfig()).toThrow(configPath());
    expect(() => loadCollabConfig()).toThrow('"collaborator.skills"');
  });

  it("throws when a rule object has a key other than include and exclude", async () => {
    await writeConfig({ collaborator: { tools: { include: ["read"], only: ["bash"] } } });

    expect(() => loadCollabConfig()).toThrow(configPath());
    expect(() => loadCollabConfig()).toThrow('unknown key "only"');
  });

  it("throws when a list contains a non-string or an empty string", async () => {
    await writeConfig({ collaborator: { extensions: ["a", 5] } });
    expect(() => loadCollabConfig()).toThrow('"collaborator.extensions"');

    await writeConfig({ collaborator: { extensions: { exclude: [""] } } });
    expect(() => loadCollabConfig()).toThrow('"collaborator.extensions.exclude"');
  });
});

type Item = { names: string[] };

function item(...names: string[]): Item {
  return { names };
}

function namesOf(entry: Item): string[] {
  return entry.names;
}

function select(rule: SelectionRule, current: Item[], candidates: Item[]): Item[] {
  return selectItems(rule, current, candidates, namesOf).selected;
}

describe("selectItems", () => {
  const a = item("a");
  const b = item("b");
  const c = item("c");

  it("keeps only the named candidates for a list rule", () => {
    expect(select(["a", "c"], [a, b, c], [c, b, a])).toEqual([c, a]);
  });

  it("starts from the current items, adds included candidates, then removes excluded ones", () => {
    expect(select({ include: ["c"], exclude: ["b"] }, [a, b], [a, b, c, item("d")])).toEqual([a, c]);
  });

  it("lets exclude win over include", () => {
    expect(select({ include: ["a", "b"], exclude: ["a"] }, [a], [a, b])).toEqual([b]);
  });

  it("matches * anywhere in a name and treats other characters literally", () => {
    const ts = item("src/foo.ts");
    const notTs = item("src/fooXts");
    const star = item("a*b");
    const starMatch = item("aXXb");

    expect(select(["src/foo.ts", "a*b"], [], [ts, notTs, star, starMatch])).toEqual([ts, star, starMatch]);
  });

  it("matches a candidate by any of its names", () => {
    const multi = item("first", "second");

    expect(select(["second"], [], [multi, a])).toEqual([multi]);
  });

  it("reports every list, include, and exclude entry that matches no candidate", () => {
    expect(selectItems(["a", "missing", "also*missing"], [], [a], namesOf).unmatched).toEqual([
      "missing",
      "also*missing",
    ]);

    expect(selectItems({ include: ["missing"], exclude: ["b", "gone"] }, [a], [a, b], namesOf).unmatched).toEqual([
      "missing",
      "gone",
    ]);
  });

  it("does not report an exclude entry that matches a candidate outside the current items", () => {
    expect(selectItems({ include: [], exclude: ["b"] }, [a], [a, b], namesOf)).toEqual({
      selected: [a],
      unmatched: [],
    });
  });
});
