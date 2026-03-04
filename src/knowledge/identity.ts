import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";

/**
 * Knowledge Agent Identity File Parser
 *
 * Parses the YAML identity file that defines who the Knowledge Agent IS —
 * its perspectives, boundaries, responsibilities, and operational parameters.
 *
 * Identity file spec: VEGA_Implementation_Guide_v3.2.md lines 667-766
 */

const PerspectiveSchema = z.object({
  name: z.string(),
  focus: z.string(),
});

const NorthStarSchema = z.object({
  output_metric: z.string(),
  controllable_inputs: z.array(z.string()),
});

const OperatingAlgorithmSchema = z.object({
  step_1: z.string(),
  step_2: z.string(),
  step_3: z.string(),
  step_4: z.string(),
  step_5: z.string(),
});

const DataAccessSchema = z.object({
  writes: z.array(z.string()),
  reads: z.array(z.string()),
  no_access: z.array(z.string()),
});

const ThinkingModelSchema = z.object({
  perspectives: z.array(PerspectiveSchema),
});

export const KnowledgeIdentitySchema = z.object({
  name: z.string(),
  role: z.string(),
  personality: z.object({
    core_traits: z.array(z.string()),
  }),
  ownership: z.string(),
  data_access: DataAccessSchema,
  privacy_duties: z.string(),
  model_intelligence: z.string(),
  thinking_model: ThinkingModelSchema,
  north_star: NorthStarSchema,
  trust_level: z.string(),
  operating_algorithm: OperatingAlgorithmSchema,
  charter_principles: z.array(z.string()),
  deletion_policy: z.string(),
  tools: z.array(z.string()),
});

export type KnowledgeIdentity = z.infer<typeof KnowledgeIdentitySchema>;
export type Perspective = z.infer<typeof PerspectiveSchema>;

/**
 * Parse a Knowledge Agent identity YAML file from disk.
 * Returns a fully typed and validated KnowledgeIdentity object.
 */
export async function parseIdentityFile(filePath: string): Promise<KnowledgeIdentity> {
  const raw = await readFile(filePath, "utf-8");
  return parseIdentityYaml(raw);
}

/**
 * Parse a Knowledge Agent identity from a YAML string.
 * Validates all fields against the Zod schema.
 */
export function parseIdentityYaml(yamlContent: string): KnowledgeIdentity {
  const parsed = YAML.parse(yamlContent);
  return KnowledgeIdentitySchema.parse(parsed);
}

/**
 * Get the 4 thinking perspectives from an identity.
 */
export function getPerspectives(identity: KnowledgeIdentity): Perspective[] {
  return identity.thinking_model.perspectives;
}

/**
 * Check if a data domain is in the agent's write access list.
 */
export function hasWriteAccess(identity: KnowledgeIdentity, domain: string): boolean {
  return identity.data_access.writes.includes(domain);
}

/**
 * Check if a data domain is in the agent's no-access list.
 */
export function isRestrictedDomain(identity: KnowledgeIdentity, domain: string): boolean {
  return identity.data_access.no_access.includes(domain);
}
