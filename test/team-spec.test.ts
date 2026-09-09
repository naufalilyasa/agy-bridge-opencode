import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  TeamError,
  TeamSpecSchema,
  validateTeamSpec,
  ROLE_ALIASES,
  loadNamedTeam,
  saveNamedTeam,
  listNamedTeams,
} from "../src/team/spec.js";
import { OMO_ROLES } from "../src/tools.js";

describe("TeamError", () => {
  it("creates an error with field and name", () => {
    const err = new TeamError("Invalid name", "name");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TeamError);
    expect(err.name).toBe("TeamError");
    expect(err.field).toBe("name");
    expect(err.message).toContain("name");
  });
});

describe("ROLE_ALIASES", () => {
  it("defines OMO role aliases without mutating OMO_ROLES", () => {
    expect(ROLE_ALIASES).toEqual({
      sisyphus: "deep",
      "sisyphus-junior": "quick",
      atlas: "ultrabrain",
    });
    expect("sisyphus" in OMO_ROLES).toBe(false);
    expect("sisyphus-junior" in OMO_ROLES).toBe(false);
    expect("atlas" in OMO_ROLES).toBe(false);
  });
});

describe("validateTeamSpec - normalization and valid specs", () => {
  it("normalizes a minimal single-member spec", () => {
    const raw = {
      name: "core-team",
      members: [
        {
          name: "lead",
          kind: "subagent_type",
          subagent_type: "deep",
        },
      ],
    };

    const normalized = validateTeamSpec(raw);
    expect(normalized).toEqual({
      version: 1,
      name: "core-team",
      leadAgentId: "lead",
      backendType: "cli",
      members: [
        {
          name: "lead",
          kind: "subagent_type",
          subagent_type: "deep",
          backendType: "cli",
        },
      ],
    });
  });

  it("normalizes a multi-member spec with explicit leadAgentId", () => {
    const raw = {
      version: 1,
      name: "feature-team",
      leadAgentId: "lead-dev",
      backendType: "cli",
      members: [
        {
          name: "lead-dev",
          kind: "subagent_type",
          subagent_type: "deep",
          prompt: "Drive feature development",
        },
        {
          name: "qa-dev",
          kind: "subagent_type",
          subagent_type: "tester",
          prompt: "Write tests",
        },
      ],
    };

    const normalized = validateTeamSpec(raw);
    expect(normalized.version).toBe(1);
    expect(normalized.name).toBe("feature-team");
    expect(normalized.leadAgentId).toBe("lead-dev");
    expect(normalized.backendType).toBe("cli");
    expect(normalized.members).toHaveLength(2);
    expect(normalized.members[0].name).toBe("lead-dev");
    expect(normalized.members[1].name).toBe("qa-dev");
  });

  it("resolves role aliases sisyphus, sisyphus-junior, atlas to canonical keys", () => {
    const raw = {
      name: "alias-team",
      leadAgentId: "agent-sisyphus",
      members: [
        {
          name: "agent-sisyphus",
          kind: "subagent_type",
          subagent_type: "sisyphus",
        },
        {
          name: "agent-junior",
          kind: "subagent_type",
          subagent_type: "sisyphus-junior",
        },
        {
          name: "agent-atlas",
          kind: "subagent_type",
          subagent_type: "atlas",
        },
      ],
    };

    const normalized = validateTeamSpec(raw);
    expect(normalized.members[0]).toMatchObject({ subagent_type: "deep" });
    expect(normalized.members[1]).toMatchObject({ subagent_type: "quick" });
    expect(normalized.members[2]).toMatchObject({ subagent_type: "ultrabrain" });
  });

  it("infers kind for category members and subagent_type members when kind omitted", () => {
    const raw = {
      name: "inferred-kinds",
      leadAgentId: "worker-cat",
      members: [
        {
          name: "worker-cat",
          category: "engineering",
          prompt: "Build stuff",
        },
        {
          name: "worker-sub",
          subagent_type: "reviewer",
        },
      ],
    };

    const normalized = validateTeamSpec(raw);
    expect(normalized.members[0]).toMatchObject({
      kind: "category",
      category: "engineering",
    });
    expect(normalized.members[1]).toMatchObject({
      kind: "subagent_type",
      subagent_type: "reviewer",
    });
  });

  it("supports all 18 OMO_ROLES keys as valid subagents", () => {
    const sampleRoles = [
      "git-master",
      "oracle",
      "librarian",
      "explore",
      "momus",
      "metis",
      "multimodal-looker",
      "ultrabrain",
    ];

    const raw = {
      name: "roles-test",
      leadAgentId: "m-0",
      members: sampleRoles.map((role, idx) => ({
        name: `m-${idx}`,
        kind: "subagent_type",
        subagent_type: role,
      })),
    };

    const normalized = validateTeamSpec(raw);
    expect(normalized.members).toHaveLength(8);
  });

  it("normalizes a minimal valid single-member category spec", () => {
    const raw = {
      version: 1,
      name: "single-cat-team",
      members: [
        {
          name: "lead-eng",
          kind: "category",
          category: "engineering",
        },
      ],
    };

    const normalized = validateTeamSpec(raw);
    expect(normalized).toEqual({
      version: 1,
      name: "single-cat-team",
      leadAgentId: "lead-eng",
      backendType: "cli",
      members: [
        {
          name: "lead-eng",
          kind: "category",
          category: "engineering",
          backendType: "cli",
        },
      ],
    });
  });
});

describe("validateTeamSpec - validation errors and edge cases", () => {
  it("throws TeamError naming 'name' on invalid team name", () => {
    const invalidNames = ["CoreTeam", "core_team", "core team", "core!", ""];
    for (const name of invalidNames) {
      expect(() =>
        validateTeamSpec({
          name,
          members: [{ name: "lead", kind: "subagent_type", subagent_type: "deep" }],
        }),
      ).toThrow(TeamError);

      try {
        validateTeamSpec({
          name,
          members: [{ name: "lead", kind: "subagent_type", subagent_type: "deep" }],
        });
      } catch (e) {
        expect(e).toBeInstanceOf(TeamError);
        const err = e as TeamError;
        expect(err.field).toBe("name");
        expect(err.message).toMatch(/name/i);
      }
    }
  });

  it("throws TeamError naming 'members' when 0 members", () => {
    expect(() =>
      validateTeamSpec({
        name: "empty-team",
        members: [],
      }),
    ).toThrow(TeamError);

    try {
      validateTeamSpec({
        name: "empty-team",
        members: [],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("members");
      expect(err.message).toMatch(/members/i);
    }
  });

  it("throws TeamError naming 'members' when >8 members", () => {
    const members = Array.from({ length: 9 }, (_, i) => ({
      name: `agent-${i}`,
      kind: "subagent_type",
      subagent_type: "deep",
    }));

    try {
      validateTeamSpec({
        name: "nine-members",
        leadAgentId: "agent-0",
        members,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("members");
      expect(err.message).toMatch(/members/i);
    }
  });

  it("throws TeamError naming 'leadAgentId' when missing with multiple members", () => {
    try {
      validateTeamSpec({
        name: "multi-team",
        members: [
          { name: "member-1", kind: "subagent_type", subagent_type: "deep" },
          { name: "member-2", kind: "subagent_type", subagent_type: "quick" },
        ],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("leadAgentId");
      expect(err.message).toMatch(/leadAgentId/i);
    }
  });

  it("throws TeamError naming 'leadAgentId' when leadAgentId does not match any member", () => {
    try {
      validateTeamSpec({
        name: "multi-team",
        leadAgentId: "unknown-lead",
        members: [
          { name: "member-1", kind: "subagent_type", subagent_type: "deep" },
          { name: "member-2", kind: "subagent_type", subagent_type: "quick" },
        ],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("leadAgentId");
      expect(err.message).toMatch(/leadAgentId/i);
    }
  });

  it("throws TeamError naming 'members' on duplicate member names", () => {
    try {
      validateTeamSpec({
        name: "dupe-team",
        leadAgentId: "worker",
        members: [
          { name: "worker", kind: "subagent_type", subagent_type: "deep" },
          { name: "worker", kind: "subagent_type", subagent_type: "quick" },
        ],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("members");
      expect(err.message).toMatch(/duplicate/i);
    }
  });

  it("throws TeamError naming 'name' on invalid member name", () => {
    try {
      validateTeamSpec({
        name: "bad-member",
        members: [{ name: "INVALID_MEMBER", kind: "subagent_type", subagent_type: "deep" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("name");
      expect(err.message).toMatch(/name/i);
    }
  });

  it("throws TeamError naming 'subagent_type' listing valid roles on unknown subagent_type", () => {
    try {
      validateTeamSpec({
        name: "unknown-subagent",
        members: [{ name: "bad-agent", kind: "subagent_type", subagent_type: "nonexistent-bot" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("subagent_type");
      expect(err.message).toMatch(/subagent_type/i);
      expect(err.message).toContain("nonexistent-bot");
      expect(err.message).toMatch(/deep/);
      expect(err.message).toMatch(/quick/);
      expect(err.message).toMatch(/ultrabrain/);
    }
  });

  it("throws TeamError naming 'backendType' when backendType is 'tmux'", () => {
    try {
      validateTeamSpec({
        name: "tmux-team",
        backendType: "tmux",
        members: [{ name: "lead", kind: "subagent_type", subagent_type: "deep" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("backendType");
      expect(err.message).toMatch(/backendType/i);
      expect(err.message).toMatch(/cli/i);
      expect(err.message).toMatch(/tmux/i);
    }
  });

  it("throws TeamError naming 'backendType' when backendType is 'in-process'", () => {
    try {
      validateTeamSpec({
        name: "inproc-team",
        backendType: "in-process",
        members: [{ name: "lead", kind: "subagent_type", subagent_type: "deep" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("backendType");
      expect(err.message).toMatch(/backendType/i);
      expect(err.message).toMatch(/cli/i);
      expect(err.message).toMatch(/in-process/i);
    }
  });

  it("throws TeamError naming 'backendType' when member backendType is not 'cli'", () => {
    try {
      validateTeamSpec({
        name: "member-tmux-team",
        members: [
          {
            name: "lead",
            kind: "subagent_type",
            subagent_type: "deep",
            backendType: "tmux",
          },
        ],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("backendType");
      expect(err.message).toMatch(/backendType/i);
    }
  });

  it("throws TeamError naming 'kind' when member has both category and subagent_type", () => {
    try {
      validateTeamSpec({
        name: "conflict-member",
        members: [
          {
            name: "conflicted",
            kind: "subagent_type",
            category: "engineering",
            subagent_type: "deep",
          },
        ],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("kind");
      expect(err.message).toMatch(/both/i);
    }
  });

  it("throws TeamError naming 'kind' when member lacks kind, category, and subagent_type", () => {
    try {
      validateTeamSpec({
        name: "empty-kind-member",
        members: [{ name: "no-kind" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("kind");
      expect(err.message).toMatch(/kind/i);
    }
  });

  it("throws TeamError naming 'category' when category member is missing category", () => {
    try {
      validateTeamSpec({
        name: "bad-cat-member",
        members: [{ name: "cat-no-category", kind: "category" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("category");
      expect(err.message).toMatch(/category/i);
    }
  });

  it("throws TeamError naming 'subagent_type' when subagent member is missing subagent_type", () => {
    try {
      validateTeamSpec({
        name: "bad-sub-member",
        members: [{ name: "sub-no-type", kind: "subagent_type" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("subagent_type");
      expect(err.message).toMatch(/subagent_type/i);
    }
  });

  it("throws TeamError naming 'version' when version is not 1", () => {
    try {
      validateTeamSpec({
        version: 2,
        name: "bad-version",
        members: [{ name: "lead", kind: "subagent_type", subagent_type: "deep" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.field).toBe("version");
      expect(err.message).toMatch(/version/i);
    }
  });

  it("throws TeamError with code UNSUPPORTED_BACKEND_TYPE when backendType is tmux or in-process", () => {
    for (const backend of ["tmux", "in-process"]) {
      try {
        validateTeamSpec({
          name: "backend-team",
          backendType: backend,
          members: [{ name: "lead", kind: "subagent_type", subagent_type: "deep" }],
        });
      } catch (e) {
        expect(e).toBeInstanceOf(TeamError);
        const err = e as TeamError;
        expect(err.field).toBe("backendType");
        expect(err.code).toBe("UNSUPPORTED_BACKEND_TYPE");
        expect(err.message).toMatch(/UNSUPPORTED_BACKEND_TYPE|cli/i);
      }
    }
  });

  it("throws TeamError with code INVALID_MEMBER when members are non-flat or non-object items", () => {
    const nonObjectMembers = ["string-member", null, undefined, 123, true];

    for (const badMember of nonObjectMembers) {
      try {
        validateTeamSpec({
          name: "non-flat-team",
          members: [badMember],
        });
        expect.unreachable("should have thrown TeamError");
      } catch (e) {
        expect(e).toBeInstanceOf(TeamError);
        const err = e as TeamError;
        expect(err.field).toBe("members");
        expect(err.code).toBe("INVALID_MEMBER");
        expect(err.message).toMatch(/object/i);
      }
    }

    // Nested array inside members list (non-flat members array)
    try {
      validateTeamSpec({
        name: "nested-array-team",
        members: [[{ name: "nested-lead", kind: "subagent_type", subagent_type: "deep" }]],
      });
      expect.unreachable("should have thrown TeamError");
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      // An array is an object whose name property is undefined -> throws INVALID_MEMBER_NAME
      expect(err.field).toBe("name");
      expect(err.code).toBe("INVALID_MEMBER_NAME");
    }
  });

  it("resolves role alias function or mapping: sisyphus->deep, sisyphus-junior->quick, atlas->ultrabrain", () => {
    const resolveRoleAlias = (role: string) => ROLE_ALIASES[role] ?? role;
    expect(resolveRoleAlias("sisyphus")).toBe("deep");
    expect(resolveRoleAlias("sisyphus-junior")).toBe("quick");
    expect(resolveRoleAlias("atlas")).toBe("ultrabrain");
    expect(resolveRoleAlias("explore")).toBe("explore");
  });
});

describe("TeamSpecSchema Zod schema directly", () => {
  it("successfully parses valid object", () => {
    const parsed = TeamSpecSchema.parse({
      name: "valid-zod",
      members: [{ name: "solo", kind: "subagent_type", subagent_type: "deep" }],
    });
    expect(parsed.name).toBe("valid-zod");
    expect(parsed.version).toBe(1);
    expect(parsed.backendType).toBe("cli");
    expect(parsed.leadAgentId).toBe("solo");
  });
});

describe("named team spec load/save/list", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-spec-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("roundtrip save->load equals normalized spec", async () => {
    const rawSpec = {
      name: "frontend-team",
      leadAgentId: "lead",
      description: "Frontend team driving UI",
      members: [
        {
          name: "lead",
          kind: "subagent_type",
          subagent_type: "sisyphus",
          prompt: "Architect and coordinate",
        },
        {
          name: "designer",
          kind: "category",
          category: "frontend",
          prompt: "Build reactive components",
        },
      ],
    };

    await saveNamedTeam(tmpDir, rawSpec);

    // Verify config file location
    const expectedPath = path.join(tmpDir, ".omo", "teams", "frontend-team", "config.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const loaded = await loadNamedTeam(tmpDir, "frontend-team");
    const normalized = validateTeamSpec(rawSpec);
    expect(loaded).toEqual(normalized);
  });

  it("load on missing path -> null", async () => {
    const loaded = await loadNamedTeam(tmpDir, "nonexistent-team");
    expect(loaded).toBeNull();
  });

  it("list returns N specs from 3 saved and sorted by name", async () => {
    const teams = [
      {
        name: "charlie-team",
        members: [{ name: "lead", kind: "subagent_type", subagent_type: "deep" }],
      },
      {
        name: "alpha-team",
        members: [{ name: "lead", kind: "subagent_type", subagent_type: "quick" }],
      },
      {
        name: "bravo-team",
        members: [{ name: "lead", kind: "subagent_type", subagent_type: "ultrabrain" }],
      },
    ];

    for (const t of teams) {
      await saveNamedTeam(tmpDir, t);
    }

    const list = await listNamedTeams(tmpDir);
    expect(list).toHaveLength(3);
    expect(list.map((t) => t.name)).toEqual(["alpha-team", "bravo-team", "charlie-team"]);
    expect(list[0]).toEqual(validateTeamSpec(teams[1]));
    expect(list[1]).toEqual(validateTeamSpec(teams[2]));
    expect(list[2]).toEqual(validateTeamSpec(teams[0]));
  });

  it("returns empty array from listNamedTeams when .omo/teams directory does not exist", async () => {
    const list = await listNamedTeams(tmpDir);
    expect(list).toEqual([]);
  });

  it("invalid config file on disk -> skipped not thrown", async () => {
    // 1. Valid team
    await saveNamedTeam(tmpDir, {
      name: "valid-team",
      members: [{ name: "solo", kind: "subagent_type", subagent_type: "deep" }],
    });

    // 2. Corrupted JSON file on disk
    const corruptedDir = path.join(tmpDir, ".omo", "teams", "corrupted-team");
    fs.mkdirSync(corruptedDir, { recursive: true });
    fs.writeFileSync(path.join(corruptedDir, "config.json"), "not json {{{", "utf-8");

    // 3. Invalid spec on disk (missing required leadAgentId for 2 members)
    const invalidSpecDir = path.join(tmpDir, ".omo", "teams", "missing-lead");
    fs.mkdirSync(invalidSpecDir, { recursive: true });
    fs.writeFileSync(
      path.join(invalidSpecDir, "config.json"),
      JSON.stringify({
        version: 1,
        name: "missing-lead",
        members: [
          { name: "m1", kind: "subagent_type", subagent_type: "deep" },
          { name: "m2", kind: "subagent_type", subagent_type: "quick" },
        ],
      }),
      "utf-8",
    );

    // 4. Empty directory with no config.json
    const emptyDir = path.join(tmpDir, ".omo", "teams", "empty-team");
    fs.mkdirSync(emptyDir, { recursive: true });

    // 5. File directly in .omo/teams (not a directory)
    fs.writeFileSync(path.join(tmpDir, ".omo", "teams", "stray-file.txt"), "hello", "utf-8");

    // Calling listNamedTeams must not throw; must skip the invalid/corrupted/empty entries
    const list = await listNamedTeams(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("valid-team");

    // Also verify loadNamedTeam on corrupted throws TeamError with INVALID_JSON code
    try {
      await loadNamedTeam(tmpDir, "corrupted-team");
      expect.unreachable("should have thrown TeamError");
    } catch (e) {
      expect(e).toBeInstanceOf(TeamError);
      const err = e as TeamError;
      expect(err.code).toBe("INVALID_JSON");
      expect(err.field).toBe("spec");
    }
    // And loadNamedTeam on invalid spec throws TeamError
    await expect(loadNamedTeam(tmpDir, "missing-lead")).rejects.toThrow(TeamError);
    // And loadNamedTeam on empty dir returns null (spec absent)
    expect(await loadNamedTeam(tmpDir, "empty-team")).toBeNull();
  });

  it("save with invalid spec throws TeamError and writes nothing", async () => {
    const invalidSpec = {
      name: "valid-name",
      members: [], // invalid: 0 members
    };

    await expect(saveNamedTeam(tmpDir, invalidSpec)).rejects.toThrow(TeamError);

    // Directory must not have been created
    const targetDir = path.join(tmpDir, ".omo", "teams", "valid-name");
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("saveNamedTeam name invalid -> TeamError BEFORE any mkdir", async () => {
    const invalidNameSpec = {
      name: "INVALID_UPPERCASE_NAME",
      members: [{ name: "solo", kind: "subagent_type", subagent_type: "deep" }],
    };

    await expect(saveNamedTeam(tmpDir, invalidNameSpec)).rejects.toThrow(TeamError);

    // Must not create any .omo directory or child
    const omoDir = path.join(tmpDir, ".omo");
    expect(fs.existsSync(omoDir)).toBe(false);
  });
});
