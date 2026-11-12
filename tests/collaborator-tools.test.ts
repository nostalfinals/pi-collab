import { describe, expect, it } from "vitest";
import { selectCollaboratorTools } from "../src/utils/session.ts";

const inheritAll = { include: [], exclude: [] };

describe("selectCollaboratorTools", () => {
  it("inherits the lead's tools except collab tools and MCP tools", () => {
    const leadTools = ["read", "bash", "collab_send"];
    const registeredTools = ["read", "bash", "collab_send", "mcp__server__tool", "list_mcp_resources"];

    expect(selectCollaboratorTools(inheritAll, leadTools, registeredTools, ["read"])).toEqual({
      names: ["read", "bash"],
      unmatched: [],
    });
  });

  it("drops inherited tools the collaborator does not have without reporting them", () => {
    expect(selectCollaboratorTools(inheritAll, ["read", "bash", "write"], ["read"], [])).toEqual({
      names: ["read"],
      unmatched: [],
    });
  });

  it("keeps MCP tools that are already active in the collaborator", () => {
    const activeTools = ["read", "mcp__server__tool", "list_mcp_resources"];

    expect(selectCollaboratorTools(inheritAll, ["read"], ["read"], activeTools)).toEqual({
      names: ["read", "mcp__server__tool", "list_mcp_resources"],
      unmatched: [],
    });
  });

  it("reports included MCP tool names as unmatched", () => {
    expect(selectCollaboratorTools({ include: ["mcp__server__tool", "read"], exclude: [] }, [], ["read"], [])).toEqual({
      names: ["read"],
      unmatched: ["mcp__server__tool"],
    });
  });
});
