import { test } from "node:test";
import assert from "node:assert/strict";
import { BASELINE_BEDROCK_DIFFERENCES, evaluateCrossplay, type ContentCrossplay } from "../src/index.ts";

// The owner's own acceptance prompt: Pat & Jen style Lucky Block Challenge Games.
const crossplayBuild: ContentCrossplay[] = [
  { id: "modrinth:ly-lucky-blocks", name: "Lucky Blocks (datapack)", textures: "converted", behavior: "identical", differences: [] },
  { id: "generated:surprise-lucky-block", name: "Villager Lucky Block", textures: "converted", behavior: "identical", differences: [] },
  {
    id: "modrinth:mythicmobs",
    name: "MythicMobs boss",
    textures: "native",
    behavior: "identical",
    differences: [
      {
        source: "modrinth:mythicmobs",
        area: "textures",
        feature: "Boss particle effects",
        java: "Full particle effects.",
        bedrock: "Some particles look different or are missing.",
        severity: "cosmetic",
      },
    ],
  },
  { id: "generated:traders", name: "Challenge villager traders", textures: "native", behavior: "identical", differences: [] },
];

const classicMod: ContentCrossplay = {
  id: "modrinth:luckyblock",
  name: "Lucky Block mod",
  textures: "none",
  behavior: "cannot_join",
  differences: [],
  bedrockAlternative: "Lucky Blocks (datapack)",
};

test("unknown Bedrock audience asks all three questions before anything else", () => {
  const r = evaluateCrossplay({ bedrockPlayers: "unknown" }, crossplayBuild);
  assert.equal(r.status, "needs_input");
  assert.deepEqual(r.questions.map((q) => q.id), ["bedrock_players", "textures", "behavior"]);
});

test("Bedrock players without priorities: must ask textures and behavior separately", () => {
  const r = evaluateCrossplay({ bedrockPlayers: "yes" }, crossplayBuild);
  assert.equal(r.status, "needs_input");
  assert.deepEqual(r.questions.map((q) => q.id), ["textures", "behavior"]);
  for (const q of r.questions) assert.deepEqual(q.options.map((o) => o.value), ["required", "best_effort", "java_first"]);
});

test("crossplay lucky block build passes strict priorities and still lists differences", () => {
  const r = evaluateCrossplay({ bedrockPlayers: "yes", textures: "required", behavior: "required" }, crossplayBuild);
  assert.equal(r.status, "ok");
  assert.equal(r.badge, "java_bedrock");
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.differences.length, BASELINE_BEDROCK_DIFFERENCES.length + 1);
  assert.ok(r.differences.some((d) => d.feature === "Console joining"));
  assert.ok(r.differences.some((d) => d.feature === "Boss particle effects"));
});

test("classic Lucky Block mod conflicts with strict priorities and suggests the datapack", () => {
  const r = evaluateCrossplay({ bedrockPlayers: "yes", textures: "required", behavior: "required" }, [classicMod]);
  assert.equal(r.status, "conflicts");
  assert.equal(r.badge, "java_only");
  assert.deepEqual(r.conflicts.map((c) => c.category).sort(), ["behavior", "textures"]);
  assert.ok(r.conflicts.every((c) => c.fix.includes("Lucky Blocks (datapack)")));
  assert.equal(r.differences[0]?.severity, "blocking");
});

test("java_first accepts the classic mod but states plainly that Bedrock can't join", () => {
  const r = evaluateCrossplay({ bedrockPlayers: "yes", textures: "java_first", behavior: "java_first" }, [classicMod]);
  assert.equal(r.status, "ok");
  assert.equal(r.badge, "java_only");
  assert.match(r.summary, /Bedrock players can't join/);
});

test("best_effort allows vanilla stand-ins but not join-blocking mods", () => {
  const polymer: ContentCrossplay = { id: "x:poly", name: "Polymer furniture", textures: "fallback", behavior: "approximate", differences: [] };
  const ok = evaluateCrossplay({ bedrockPlayers: "yes", textures: "best_effort", behavior: "best_effort" }, [polymer]);
  assert.equal(ok.status, "ok");
  assert.equal(ok.badge, "bedrock_experimental");
  const blocked = evaluateCrossplay({ bedrockPlayers: "yes", textures: "best_effort", behavior: "best_effort" }, [polymer, classicMod]);
  assert.equal(blocked.status, "conflicts");
});

test("Java-only worlds skip questions and differences", () => {
  const r = evaluateCrossplay({ bedrockPlayers: "no" }, [classicMod]);
  assert.equal(r.status, "ok");
  assert.equal(r.questions.length + r.differences.length, 0);
});
