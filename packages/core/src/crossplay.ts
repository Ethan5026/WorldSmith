// Java/Bedrock crossplay rules for world plans.
//
// Owner requirement (2026-10-05): whenever Bedrock players may join, the system must
//   1. say exactly where the prompt's features will differ between Java and Bedrock, and
//   2. ask the owner how strictly Bedrock compatibility should be enforced, separately for
//      TEXTURES (how things look) and BEHAVIOR (how mods/plugins/rules play),
// before a plan can be approved. A plan without those answers is "needs_input", never "valid".

import { z } from "zod";

/** How strictly one category must work on Bedrock. */
export const BedrockPriority = z.enum([
  /** Only content that works the same on Bedrock. Anything else is swapped out or dropped. */
  "required",
  /** Bedrock may get a close substitute (vanilla look-alike, approximate mechanic). Differences are listed. */
  "best_effort",
  /** Pick the best Java content. Bedrock players may miss it, or be unable to join if behavior needs it. */
  "java_first",
]);
export type BedrockPriority = z.infer<typeof BedrockPriority>;

export const CrossplayIntent = z.object({
  /** Will anyone join from Bedrock (phone, Windows, Xbox, PlayStation, Switch)? */
  bedrockPlayers: z.enum(["yes", "no", "unknown"]),
  /** Unset until the owner answers; plans with Bedrock players can't be approved while unset. */
  textures: BedrockPriority.optional(),
  behavior: BedrockPriority.optional(),
});
export type CrossplayIntent = z.infer<typeof CrossplayIntent>;

/** How one piece of content looks on Bedrock (via Geyser). */
export const TextureCompat = z.enum([
  /** Uses vanilla assets only — identical on Bedrock. */
  "native",
  /** Custom look that Geyser shows correctly after conversion (Rainbow pack, custom-skull mappings). */
  "converted",
  /** Custom look that Bedrock sees as a vanilla stand-in. */
  "fallback",
  /** Needs a client mod — Bedrock can't render it at all. */
  "none",
]);
export type TextureCompat = z.infer<typeof TextureCompat>;

/** How one piece of content behaves on Bedrock (via Geyser). */
export const BehaviorCompat = z.enum([
  /** Server-side logic, same result for everyone. */
  "identical",
  /** Works, with Bedrock-specific differences (UI, controls, timing). */
  "approximate",
  /** Bedrock players can't use this feature, but can still play the world. */
  "missing",
  /** Needs a client mod to connect — Bedrock players can't join a world containing it. */
  "cannot_join",
]);
export type BehaviorCompat = z.infer<typeof BehaviorCompat>;

export const PlatformDifference = z.object({
  /** Which plan item this comes from ("" for differences every Bedrock player has). */
  source: z.string(),
  area: z.enum(["joining", "textures", "behavior", "controls", "interface"]),
  feature: z.string(),
  java: z.string(),
  bedrock: z.string(),
  severity: z.enum(["cosmetic", "minor", "major", "blocking"]),
  workaround: z.string().optional(),
});
export type PlatformDifference = z.infer<typeof PlatformDifference>;

export const ContentCrossplay = z.object({
  /** Plan item id, e.g. "modrinth:mythicmobs" or "generated:surprise-lucky-block". */
  id: z.string(),
  name: z.string(),
  textures: TextureCompat,
  behavior: BehaviorCompat,
  /** Item-specific differences to show the owner. */
  differences: z.array(PlatformDifference).default([]),
  /** Bedrock-friendly replacement the planner can swap in, if one is known. */
  bedrockAlternative: z.string().optional(),
});
export type ContentCrossplay = z.infer<typeof ContentCrossplay>;

/** Differences every Bedrock player has on a Geyser server, regardless of content. */
export const BASELINE_BEDROCK_DIFFERENCES: PlatformDifference[] = [
  {
    source: "",
    area: "joining",
    feature: "Console joining",
    java: "Add the server address in Multiplayer.",
    bedrock: "Phone/Windows add the address. Xbox, PlayStation and Switch have no Add Server button.",
    severity: "minor",
    workaround: "The server appears in the console Friends tab (MCXboxBroadcast); BedrockConnect DNS is the fallback.",
  },
  {
    source: "",
    area: "behavior",
    feature: "Combat timing",
    java: "Attack cooldown (1.9+ combat).",
    bedrock: "No native cooldown; Geyser shows a cooldown indicator instead.",
    severity: "minor",
  },
  {
    source: "",
    area: "controls",
    feature: "Offhand",
    java: "Use any item from the offhand.",
    bedrock: "Only shields, arrows, maps, totems and fireworks; other items need a swap.",
    severity: "minor",
    workaround: "/geyser offhand, or an emote swaps hands (EmoteOffhand extension).",
  },
  {
    source: "",
    area: "interface",
    feature: "Chat",
    java: "Clickable links and tab-complete for commands.",
    bedrock: "No clickable links; commands must be typed in full.",
    severity: "cosmetic",
  },
  {
    source: "",
    area: "textures",
    feature: "Glowing effect and banners",
    java: "Glowing outlines; banners with up to 16 layers.",
    bedrock: "No glowing outlines; banners show at most 6 layers.",
    severity: "cosmetic",
  },
];

const TEXTURE_OK: Record<BedrockPriority, TextureCompat[]> = {
  required: ["native", "converted"],
  best_effort: ["native", "converted", "fallback"],
  java_first: ["native", "converted", "fallback", "none"],
};
const BEHAVIOR_OK: Record<BedrockPriority, BehaviorCompat[]> = {
  required: ["identical"],
  best_effort: ["identical", "approximate"],
  java_first: ["identical", "approximate", "missing", "cannot_join"],
};

export type CrossplayBadge = "java_bedrock" | "bedrock_experimental" | "java_only";

export interface CrossplayQuestion {
  id: "bedrock_players" | "textures" | "behavior";
  prompt: string;
  options: { value: string; label: string; detail: string }[];
}

export interface CrossplayReport {
  status: "needs_input" | "ok" | "conflicts";
  badge: CrossplayBadge;
  /** Plain-language summary the planner must relay to the owner. */
  summary: string;
  /** Owner questions that block approval until answered. */
  questions: CrossplayQuestion[];
  /** Items that break the owner's chosen priorities, with what the planner should do. */
  conflicts: { id: string; name: string; category: "textures" | "behavior"; problem: string; fix: string }[];
  /** Everything that will look or play differently on Bedrock. */
  differences: PlatformDifference[];
}

const priorityOptions = (category: "textures" | "behavior") =>
  category === "textures"
    ? [
        { value: "required", label: "Must look the same", detail: "Only use content Bedrock shows correctly; swap out custom looks it can't show." },
        { value: "best_effort", label: "Close enough", detail: "Allow custom looks; Bedrock may see vanilla stand-ins." },
        { value: "java_first", label: "Java looks first", detail: "Use the best Java visuals even if Bedrock can't show them." },
      ]
    : [
        { value: "required", label: "Must play the same", detail: "Only use mods/plugins that behave identically on Bedrock." },
        { value: "best_effort", label: "Close enough", detail: "Allow features that work slightly differently on Bedrock (menus, controls)." },
        { value: "java_first", label: "Java gameplay first", detail: "Use the best Java mods even if Bedrock players miss features or can't join." },
      ];

export const QUESTION_TEXT = {
  bedrock_players: "Will anyone join this world from Bedrock (phone, Windows, Xbox, PlayStation, Switch)?",
  textures: "How closely should Bedrock players see the same textures (custom blocks, items, resource packs)?",
  behavior: "How closely should mods and plugins behave the same for Bedrock players?",
} as const;

/** Evaluate a plan's content against the owner's crossplay intent. Pure; no I/O. */
export function evaluateCrossplay(intent: CrossplayIntent, content: ContentCrossplay[]): CrossplayReport {
  const worst = {
    cannotJoin: content.filter((c) => c.behavior === "cannot_join"),
    textureNone: content.filter((c) => c.textures === "none"),
  };
  const experimental = content.some((c) => c.behavior === "approximate" || c.textures === "fallback");
  const badge: CrossplayBadge = worst.cannotJoin.length > 0 ? "java_only" : experimental ? "bedrock_experimental" : "java_bedrock";

  if (intent.bedrockPlayers === "no") {
    return {
      status: "ok",
      badge,
      summary: "Java-only world: Bedrock compatibility wasn't considered.",
      questions: [],
      conflicts: [],
      differences: [],
    };
  }

  const questions: CrossplayQuestion[] = [];
  if (intent.bedrockPlayers === "unknown") {
    questions.push({
      id: "bedrock_players",
      prompt: QUESTION_TEXT.bedrock_players,
      options: [
        { value: "yes", label: "Yes", detail: "Plan for Bedrock players and show every difference." },
        { value: "no", label: "No, Java only", detail: "Ignore Bedrock and use the best Java content." },
      ],
    });
  }
  // Ask both categories up front, even when the content looks fine today: the answers also steer
  // which content the planner picks next time the plan changes.
  if (!intent.textures) questions.push({ id: "textures", prompt: QUESTION_TEXT.textures, options: priorityOptions("textures") });
  if (!intent.behavior) questions.push({ id: "behavior", prompt: QUESTION_TEXT.behavior, options: priorityOptions("behavior") });

  const conflicts: CrossplayReport["conflicts"] = [];
  for (const c of content) {
    if (intent.textures && !TEXTURE_OK[intent.textures].includes(c.textures)) {
      conflicts.push({
        id: c.id,
        name: c.name,
        category: "textures",
        problem: c.textures === "none" ? "Bedrock can't display it at all." : "Bedrock sees a vanilla stand-in.",
        fix: c.bedrockAlternative ? `Swap for ${c.bedrockAlternative}.` : "Remove it or relax the texture priority.",
      });
    }
    if (intent.behavior && !BEHAVIOR_OK[intent.behavior].includes(c.behavior)) {
      conflicts.push({
        id: c.id,
        name: c.name,
        category: "behavior",
        problem:
          c.behavior === "cannot_join"
            ? "Needs a client mod, so Bedrock players can't join."
            : c.behavior === "missing"
              ? "Bedrock players can't use this feature."
              : "Works differently on Bedrock.",
        fix: c.bedrockAlternative ? `Swap for ${c.bedrockAlternative}.` : "Remove it or relax the behavior priority.",
      });
    }
  }

  const differences = [...BASELINE_BEDROCK_DIFFERENCES, ...content.flatMap((c) => c.differences)];
  if (worst.cannotJoin.length > 0) {
    differences.unshift({
      source: worst.cannotJoin.map((c) => c.id).join(", "),
      area: "joining",
      feature: "Joining this world",
      java: "Java players install the modpack and join.",
      bedrock: `Bedrock players can't join: ${worst.cannotJoin.map((c) => c.name).join(", ")} need a Java client mod.`,
      severity: "blocking",
    });
  }

  const status = questions.length > 0 ? "needs_input" : conflicts.length > 0 ? "conflicts" : "ok";
  const major = differences.filter((d) => d.severity === "major" || d.severity === "blocking").length;
  const summary =
    badge === "java_only"
      ? `Java only: Bedrock players can't join this world as planned. ${differences.length} Java/Bedrock differences listed.`
      : `${badge === "java_bedrock" ? "Java + Bedrock" : "Java + Bedrock (with differences)"}: ` +
        `${differences.length} differences between Java and Bedrock${major ? `, ${major} of them major` : ""}.`;

  return { status, badge, summary, questions, conflicts, differences };
}
