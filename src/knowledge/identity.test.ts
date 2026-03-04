import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseIdentityFile,
  parseIdentityYaml,
  getPerspectives,
  hasWriteAccess,
  isRestrictedDomain,
  type KnowledgeIdentity,
} from "./identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "lingelpedia.yaml");

describe("Identity File Parser", () => {
  let identity: KnowledgeIdentity;

  it("parseIdentityFile reads and parses the YAML fixture", async () => {
    identity = await parseIdentityFile(FIXTURE_PATH);
    expect(identity.name).toBe("Knowledge Agent");
    expect(identity.role).toContain("Truth Engine");
  });

  it("exposes typed configuration: name, role, personality", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(id.name).toBe("Knowledge Agent");
    expect(id.role).toBe("Truth Engine, Knowledge System, and Sole Write Owner");
    expect(id.personality.core_traits).toHaveLength(5);
    expect(id.personality.core_traits[0]).toContain("truth-seeking");
  });

  it("parses ownership as a string block", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(id.ownership).toContain("Single-threaded ownership");
    expect(id.ownership).toContain("Lingelpedia");
  });

  it("parses data_access with writes, reads, no_access arrays", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(id.data_access.writes).toContain("neo4j_knowledge_graph");
    expect(id.data_access.writes).toContain("obsidian_agent_insights");
    expect(id.data_access.reads).toContain("obsidian_vault");
    expect(id.data_access.no_access).toContain("email");
    expect(id.data_access.no_access).toContain("health_apis");
  });

  it("parses privacy_duties and model_intelligence as string blocks", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(id.privacy_duties).toContain("Data containment is non-negotiable");
    expect(id.privacy_duties).toContain("Harrison, Beckham");
    expect(id.model_intelligence).toContain("frontier model");
    expect(id.model_intelligence).toContain("Agentic Query Mode");
  });

  it("parses 4 thinking model perspectives", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    const perspectives = getPerspectives(id);
    expect(perspectives).toHaveLength(4);
    expect(perspectives.map((p) => p.name)).toEqual([
      "Analytical",
      "Ambitious",
      "Contrarian",
      "Investigator",
    ]);
    expect(perspectives[0].focus).toContain("Claim verification");
    expect(perspectives[3].focus).toContain("Active reasoning");
  });

  it("parses north_star with output_metric and controllable_inputs", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(id.north_star.output_metric).toBe("Knowledge truth and retrieval value");
    expect(id.north_star.controllable_inputs).toHaveLength(8);
    expect(id.north_star.controllable_inputs).toContain("Decomposition accuracy");
  });

  it("parses trust_level, operating_algorithm, charter_principles", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(id.trust_level).toBe("Observe");
    expect(id.operating_algorithm.step_1).toContain("Question every claim");
    expect(id.charter_principles).toHaveLength(5);
    expect(id.charter_principles[0]).toContain("Family-First");
  });

  it("parses deletion_policy and tools", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(id.deletion_policy).toContain("Deletion Approval Protocol");
    expect(id.tools).toContain("neo4j_mcp");
    expect(id.tools).toContain("embeddings");
    expect(id.tools).toContain("agentic_query_pipeline");
  });

  it("hasWriteAccess correctly identifies write domains", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(hasWriteAccess(id, "neo4j_knowledge_graph")).toBe(true);
    expect(hasWriteAccess(id, "obsidian_agent_insights")).toBe(true);
    expect(hasWriteAccess(id, "email")).toBe(false);
  });

  it("isRestrictedDomain correctly identifies no-access domains", async () => {
    const id = await parseIdentityFile(FIXTURE_PATH);
    expect(isRestrictedDomain(id, "email")).toBe(true);
    expect(isRestrictedDomain(id, "calendar")).toBe(true);
    expect(isRestrictedDomain(id, "neo4j_knowledge_graph")).toBe(false);
  });

  it("rejects invalid YAML with missing required fields", () => {
    const invalidYaml = `
name: "Test Agent"
role: "Test"
`;
    expect(() => parseIdentityYaml(invalidYaml)).toThrow();
  });

  it("rejects YAML with wrong field types", () => {
    const badTypes = `
name: "Test"
role: "Test"
personality:
  core_traits: "not an array"
ownership: "test"
data_access:
  writes: []
  reads: []
  no_access: []
privacy_duties: "test"
model_intelligence: "test"
thinking_model:
  perspectives: []
north_star:
  output_metric: "test"
  controllable_inputs: []
trust_level: "test"
operating_algorithm:
  step_1: "a"
  step_2: "b"
  step_3: "c"
  step_4: "d"
  step_5: "e"
charter_principles: []
deletion_policy: "test"
tools: []
`;
    expect(() => parseIdentityYaml(badTypes)).toThrow();
  });

  it("parseIdentityFile throws for nonexistent file", async () => {
    await expect(parseIdentityFile("/nonexistent/path.yaml")).rejects.toThrow();
  });
});
