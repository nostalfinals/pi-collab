import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findCollaboratorLeaf } from "../src/utils/session.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function message(role: "user" | "assistant" | "toolResult", id: string, parentId: string | null): SessionEntry {
  return { type: "message", id, parentId, timestamp, message: { role } } as SessionEntry;
}

function modelChange(id: string, parentId: string): SessionEntry {
  return { type: "model_change", id, parentId, timestamp, provider: "p", modelId: "m" } as SessionEntry;
}

// Entries are listed in file order, which is the order they were appended in.
describe("findCollaboratorLeaf", () => {
  it("returns the last entry of the anchor's handoff when nothing follows it", () => {
    const entries = [
      message("user", "u0", null),
      message("assistant", "a0", "u0"),
      message("toolResult", "t0", "a0"),
      message("assistant", "a1", "t0"),
    ];

    expect(findCollaboratorLeaf(entries, "u0")).toBe("a1");
  });

  it("ignores entries at the end of the file that belong to another branch", () => {
    const entries = [
      message("user", "u0", null),
      message("assistant", "a0", "u0"),
      message("user", "u1", "a0"),
      message("assistant", "a1", "u1"),
      modelChange("m0", "a0"),
    ];

    expect(findCollaboratorLeaf(entries, "u1")).toBe("a1");
  });

  it("stops before the user message of the next handoff", () => {
    const entries = [
      message("user", "u0", null),
      message("assistant", "a0", "u0"),
      message("user", "u1", "a0"),
      message("assistant", "a1", "u1"),
    ];

    expect(findCollaboratorLeaf(entries, "u0")).toBe("a0");
  });

  it("stops before a message that was added to the running handoff", () => {
    const entries = [
      message("user", "u0", null),
      message("assistant", "a0", "u0"),
      message("toolResult", "t0", "a0"),
      message("user", "steer", "t0"),
      message("assistant", "a1", "steer"),
    ];

    expect(findCollaboratorLeaf(entries, "u0")).toBe("t0");
  });

  it("returns the anchor itself when it has no response yet", () => {
    const entries = [message("user", "u0", null), message("assistant", "a0", "u0"), message("user", "u1", "a0")];

    expect(findCollaboratorLeaf(entries, "u1")).toBe("u1");
  });

  it("skips a later handoff and keeps following the other entries under the same parent", () => {
    const entries = [
      message("user", "u0", null),
      message("assistant", "a0", "u0"),
      message("user", "u1", "a0"),
      message("assistant", "a1", "u1"),
      modelChange("m0", "a0"),
    ];

    expect(findCollaboratorLeaf(entries, "u0")).toBe("m0");
  });

  it("follows entries that are not messages to the end of the chain", () => {
    const entries = [
      message("user", "u0", null),
      message("assistant", "a0", "u0"),
      modelChange("m0", "a0"),
      modelChange("m1", "m0"),
    ];

    expect(findCollaboratorLeaf(entries, "u0")).toBe("m1");
  });

  it("returns null when the anchor is not in the file", () => {
    const entries = [message("user", "u0", null), message("assistant", "a0", "u0")];

    expect(findCollaboratorLeaf(entries, "missing")).toBeNull();
  });
});
