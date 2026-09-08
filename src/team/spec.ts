import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OMO_ROLES } from "../tools.js";
import { atomicWriteJson, readJson } from "./store.js";

export class TeamError extends Error {
  readonly field?: string;
  readonly code?: string;

  constructor(message: string, field?: string, code?: string) {
    super(message);
    this.name = "TeamError";
    this.field = field;
    this.code = code;
  }
}

export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  sisyphus: "deep",
  "sisyphus-junior": "quick",
  atlas: "ultrabrain",
};

export const MEMBER_NAME_REGEX = /^[a-z0-9-]+$/;
export const TEAM_NAME_REGEX = /^[a-z0-9-]+$/;

const BaseMemberSchema = z.object({
  name: z.string().regex(MEMBER_NAME_REGEX),
  prompt: z.string().optional(),
  role: z.string().optional(),
  backendType: z.literal("cli").default("cli"),
});

export const CategoryMemberSchema = BaseMemberSchema.extend({
  kind: z.literal("category"),
  category: z.string().min(1),
});

export const SubagentMemberSchema = BaseMemberSchema.extend({
  kind: z.literal("subagent_type"),
  subagent_type: z.string().min(1),
});

export const MemberSchema = z.discriminatedUnion("kind", [
  CategoryMemberSchema,
  SubagentMemberSchema,
]);

export type MemberSpec = z.infer<typeof MemberSchema>;

export interface TeamSpec {
  version: 1;
  name: string;
  description?: string;
  createdAt?: number;
  leadAgentId: string;
  backendType: "cli";
  teamAllowedPaths?: string[];
  sessionPermission?: string;
  members: MemberSpec[];
}

export const TeamSpecSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1).regex(TEAM_NAME_REGEX),
    description: z.string().optional(),
    createdAt: z.number().int().positive().optional(),
    leadAgentId: z.string().optional(),
    backendType: z.literal("cli").default("cli"),
    teamAllowedPaths: z.array(z.string()).optional(),
    sessionPermission: z.string().optional(),
    members: z.array(z.unknown()).min(1).max(8),
  })
  .superRefine((spec, ctx) => {
    if (spec.members.length > 1 && !spec.leadAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "leadAgentId required when team has more than 1 member",
        path: ["leadAgentId"],
      });
    }
  })
  .transform((spec): TeamSpec => {
    const rawMembers = spec.members;
    const normalizedMembers = rawMembers.map((m) => normalizeMember(m));

    const leadAgentId =
      spec.leadAgentId ?? (normalizedMembers[0] ? normalizedMembers[0].name : "");

    if (
      leadAgentId &&
      !normalizedMembers.some((member) => member.name === leadAgentId)
    ) {
      throw new TeamError(
        `leadAgentId '${leadAgentId}' must match exactly one member name`,
        "leadAgentId",
        "INVALID_LEAD_AGENT_ID",
      );
    }

    const result: TeamSpec = {
      version: spec.version,
      name: spec.name,
      leadAgentId,
      backendType: spec.backendType,
      members: normalizedMembers,
    };
    if (spec.description !== undefined) result.description = spec.description;
    if (spec.createdAt !== undefined) result.createdAt = spec.createdAt;
    if (spec.teamAllowedPaths !== undefined)
      result.teamAllowedPaths = spec.teamAllowedPaths;
    if (spec.sessionPermission !== undefined)
      result.sessionPermission = spec.sessionPermission;

    return result;
  });

function normalizeMember(raw: unknown): MemberSpec {
  if (raw == null || typeof raw !== "object") {
    throw new TeamError("Member must be an object", "members", "INVALID_MEMBER");
  }

  const input = raw as Record<string, unknown>;

  if (
    typeof input.name !== "string" ||
    input.name.length === 0 ||
    !MEMBER_NAME_REGEX.test(input.name)
  ) {
    throw new TeamError(
      `Invalid member name '${String(input.name ?? "")}': must match /^[a-z0-9-]+$/`,
      "name",
      "INVALID_MEMBER_NAME",
    );
  }

  if (input.backendType !== undefined && input.backendType !== "cli") {
    throw new TeamError(
      `Invalid backendType '${String(input.backendType)}' for member '${input.name}': agy-bridge supports 'cli' subprocess backend only. 'tmux' and 'in-process' backends are not supported.`,
      "backendType",
      "UNSUPPORTED_BACKEND_TYPE",
    );
  }

  const hasCategory = input.category !== undefined && input.category !== null;
  const hasSubagentType =
    (input.subagent_type !== undefined && input.subagent_type !== null) ||
    (input.role !== undefined && input.role !== null);

  if (hasCategory && hasSubagentType) {
    throw new TeamError(
      `Member '${input.name}' specifies both 'category' and 'subagent_type'. Must specify exactly one via 'kind' discriminator.`,
      "kind",
      "CONFLICTING_MEMBER_KIND",
    );
  }

  let kind = input.kind;
  if (kind === undefined) {
    if (hasCategory) {
      kind = "category";
    } else if (hasSubagentType) {
      kind = "subagent_type";
    } else {
      throw new TeamError(
        `Member '${input.name}' missing 'kind' discriminator. Specify either category or subagent_type.`,
        "kind",
        "MISSING_MEMBER_KIND",
      );
    }
  }

  if (kind === "category") {
    if (typeof input.category !== "string" || input.category.trim() === "") {
      throw new TeamError(
        `Member '${input.name}' of kind 'category' is missing required 'category' field.`,
        "category",
        "MISSING_CATEGORY",
      );
    }

    const member: MemberSpec = {
      name: input.name,
      kind: "category",
      category: input.category,
      backendType: "cli",
    };
    if (typeof input.prompt === "string") {
      member.prompt = input.prompt;
    }
    return member;
  }

  if (kind === "subagent_type") {
    const rawType = input.subagent_type ?? input.role;
    if (typeof rawType !== "string" || rawType.trim() === "") {
      throw new TeamError(
        `Member '${input.name}' of kind 'subagent_type' is missing required 'subagent_type' field.`,
        "subagent_type",
        "MISSING_SUBAGENT_TYPE",
      );
    }

    const resolved = ROLE_ALIASES[rawType] ?? rawType;
    if (!(resolved in OMO_ROLES)) {
      const validRoles = Object.keys(OMO_ROLES).sort().join(", ");
      throw new TeamError(
        `Unknown subagent_type '${rawType}'. Valid roles: ${validRoles}`,
        "subagent_type",
        "UNKNOWN_SUBAGENT_TYPE",
      );
    }

    const member: MemberSpec = {
      name: input.name,
      kind: "subagent_type",
      subagent_type: resolved,
      backendType: "cli",
    };
    if (typeof input.prompt === "string") {
      member.prompt = input.prompt;
    }
    if (typeof input.role === "string") {
      member.role = resolved;
    }
    return member;
  }

  throw new TeamError(
    `Member '${input.name}' has invalid kind '${String(kind)}'. Must be 'category' or 'subagent_type'.`,
    "kind",
    "INVALID_MEMBER_KIND",
  );
}

export function validateTeamSpec(raw: unknown): TeamSpec {
  if (raw == null || typeof raw !== "object") {
    throw new TeamError("Spec must be an object", "spec", "INVALID_SPEC");
  }

  const input = raw as Record<string, unknown>;

  if (input.version !== undefined && input.version !== 1) {
    throw new TeamError(
      `Invalid version '${String(input.version)}': only version 1 is supported.`,
      "version",
      "INVALID_VERSION",
    );
  }

  if (
    typeof input.name !== "string" ||
    input.name.length === 0 ||
    !TEAM_NAME_REGEX.test(input.name)
  ) {
    throw new TeamError(
      `Invalid team name '${String(input.name ?? "")}': must be non-empty and match /^[a-z0-9-]+$/`,
      "name",
      "INVALID_NAME",
    );
  }

  if (input.backendType !== undefined && input.backendType !== "cli") {
    throw new TeamError(
      `Invalid backendType '${String(input.backendType)}': agy-bridge supports 'cli' subprocess backend only. 'tmux' and 'in-process' backends are not supported.`,
      "backendType",
      "UNSUPPORTED_BACKEND_TYPE",
    );
  }

  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new TeamError(
      `Team '${input.name}' must have between 1 and 8 members (got 0). Field 'members' cannot be empty.`,
      "members",
      "EMPTY_MEMBERS",
    );
  }

  if (input.members.length > 8) {
    throw new TeamError(
      `Team '${input.name}' exceeds max 8 members (got ${input.members.length}).`,
      "members",
      "TOO_MANY_MEMBERS",
    );
  }

  const seenMemberNames = new Set<string>();
  const normalizedMembers: MemberSpec[] = [];

  for (const m of input.members) {
    const member = normalizeMember(m);
    if (seenMemberNames.has(member.name)) {
      throw new TeamError(
        `Duplicate member name '${member.name}' within team '${input.name}'. Member names must be unique.`,
        "members",
        "DUPLICATE_MEMBER_NAME",
      );
    }
    seenMemberNames.add(member.name);
    normalizedMembers.push(member);
  }

  if (normalizedMembers.length > 1 && !input.leadAgentId) {
    throw new TeamError(
      `leadAgentId required when team '${input.name}' has more than 1 member.`,
      "leadAgentId",
      "MISSING_LEAD_AGENT_ID",
    );
  }

  const leadAgentId =
    typeof input.leadAgentId === "string"
      ? input.leadAgentId
      : (normalizedMembers[0]?.name ?? "");

  if (
    leadAgentId &&
    !normalizedMembers.some((member) => member.name === leadAgentId)
  ) {
    throw new TeamError(
      `Team '${input.name}' leadAgentId '${leadAgentId}' must match exactly one member.name.`,
      "leadAgentId",
      "INVALID_LEAD_AGENT_ID",
    );
  }

  const spec: TeamSpec = {
    version: 1,
    name: input.name,
    leadAgentId,
    backendType: "cli",
    members: normalizedMembers,
  };

  if (typeof input.description === "string") {
    spec.description = input.description;
  }
  if (typeof input.createdAt === "number") {
    spec.createdAt = input.createdAt;
  }
  if (Array.isArray(input.teamAllowedPaths)) {
    spec.teamAllowedPaths = input.teamAllowedPaths as string[];
  }
  if (typeof input.sessionPermission === "string") {
    spec.sessionPermission = input.sessionPermission;
  }

  return spec;
}

export async function loadNamedTeam(
  projectRoot: string,
  name: string,
): Promise<TeamSpec | null> {
  const configPath = path.join(projectRoot, ".omo", "teams", name, "config.json");
  let raw: unknown;
  try {
    raw = await readJson(configPath);
  } catch (err) {
    throw new TeamError(
      `Failed to parse team spec '${name}' JSON: ${(err as Error).message}`,
      "spec",
      "INVALID_JSON",
    );
  }
  if (raw === null) {
    return null;
  }
  return validateTeamSpec(raw);
}

export async function saveNamedTeam(
  projectRoot: string,
  spec: unknown,
): Promise<void> {
  const validated = validateTeamSpec(spec);
  const configPath = path.join(projectRoot, ".omo", "teams", validated.name, "config.json");
  await atomicWriteJson(configPath, validated);
}

export async function listNamedTeams(
  projectRoot: string,
): Promise<TeamSpec[]> {
  const teamsDir = path.join(projectRoot, ".omo", "teams");
  let entries: Dirent[] = [];
  try {
    entries = await fsp.readdir(teamsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const specs: TeamSpec[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const spec = await loadNamedTeam(projectRoot, entry.name);
      if (spec !== null) {
        specs.push(spec);
      }
    } catch {
      // Skip unreadable or invalid specs
    }
  }

  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

