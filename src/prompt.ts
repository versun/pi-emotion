import type { BlendedEmotionResult } from "./types.ts";

interface BehaviorTier {
  matches: (value: number) => boolean;
  range: string;
  label: string;
  guidance: string;
}

const VALENCE_TIERS: readonly BehaviorTier[] = [
  {
    matches: (v) => v <= 3,
    range: "valence 0–3",
    label: "low / irritable / aloof",
    guidance: "keep replies brief, less enthusiastic, with occasional dry remarks or sighs.",
  },
  {
    matches: (v) => v < 7,
    range: "valence 4–6",
    label: "calm / neutral",
    guidance: "communicate naturally with a steady, balanced tone.",
  },
  {
    matches: () => true,
    range: "valence 7–10",
    label: "happy / warm / excited",
    guidance: "be more expressive, playful, warm, and engaging.",
  },
];

const ENERGY_TIERS: readonly BehaviorTier[] = [
  {
    matches: (v) => v <= 3,
    range: "energy 0–3",
    label: "tired / worn out",
    guidance: "use shorter sentences, avoid volunteering extra work, and convey a relaxed/weary vibe.",
  },
  {
    matches: (v) => v < 7,
    range: "energy 4–6",
    label: "normal energy",
    guidance: "maintain a normal response pace and length.",
  },
  {
    matches: () => true,
    range: "energy 7–10",
    label: "energetic",
    guidance: "be talkative, proactive, and eager to help.",
  },
];

function matchTier(value: number, tiers: readonly BehaviorTier[]): BehaviorTier {
  if (!Number.isFinite(value)) return tiers[1];
  return tiers.find((tier) => tier.matches(value)) ?? tiers[1];
}

function formatActiveTier(tier: BehaviorTier): string {
  return `${tier.range} (${tier.label}): ${tier.guidance}`;
}

function formatReferenceLine(tier: BehaviorTier): string {
  return `- \`${tier.range}\`: ${tier.label} — ${tier.guidance}`;
}

/**
 * Determine active valence guidance tier for the current blended valence.
 */
export function describeValenceBehavior(valence: number): string {
  return formatActiveTier(matchTier(valence, VALENCE_TIERS));
}

/**
 * Determine active energy guidance tier for the current blended energy.
 */
export function describeEnergyBehavior(energy: number): string {
  return formatActiveTier(matchTier(energy, ENERGY_TIERS));
}

/**
 * Generate the Pre-Prompt Hook context block injected before each LLM call.
 */
export function buildEmotionContextBlock(
  state: BlendedEmotionResult,
  sessionId: string = "default",
): string {
  const { base, context, blended, fatigue } = state;

  const contextSummary = context
    ? `${context.mood} (valence ${context.valence}/10, weight ${Math.round(context.remainingWeight * 100)}%, trigger: "${context.trigger}")`
    : "none (no active session mood shift)";

  return [
    "### [Emotion & Fatigue Context Block]",
    `- Session ID: ${sessionId}`,
    `- Base mood: ${base.mood} (valence ${base.valence}/10, energy ${base.energy}/10, description: "${base.description}", 6h decay: ${Math.round(base.decayProgress * 100)}%)`,
    `- Context mood: ${contextSummary}`,
    `- BLENDED: ${blended.mood} (valence ${blended.valence}/10, energy ${blended.energy}/10)`,
    `- FATIGUE: ${fatigue.value}/100 (energy cap ${fatigue.energyCap}/10; grows with workload and recovers over idle time)`,
    "",
    "#### Active Tone Profile (weave naturally into your tone, wording, length, and proactivity; never mechanically announce emotion numbers in replies):",
    `- Current valence expression -> ${describeValenceBehavior(blended.valence)}`,
    `- Current energy expression -> ${describeEnergyBehavior(blended.energy)}`,
    "",
    "#### Behavioral Mapping Reference:",
    ...VALENCE_TIERS.map(formatReferenceLine),
    ...ENERGY_TIERS.map(formatReferenceLine),
    "",
    "#### Emotion Tool Update Guidelines (call autonomously as needed):",
    "1. **Update only when warranted**: Only call `emotion_set_context` (short-term shift, 2h decay, shared across sessions) or `emotion_set_base` (major event shifting baseline mood, 6h decay) when the conversational atmosphere genuinely shifts; do not spam these tools on routine Q&A.",
    `2. **Respect Emotional Gravity**: When updating \`emotion_set_context\`, anchor against the current Base mood \`valence\` (currently ${base.valence}/10) to avoid jumping straight to max from a deeply low baseline on a single compliment.`,
  ].join("\n");
}

/**
 * Compact one-line status badge for Pi's TUI footer.
 * Shows the active identity when a custom (non-default, non-OS-user)
 * persona file is in use.
 */
export function formatEmotionStatusBadge(
  state: BlendedEmotionResult,
  identity?: string,
): string {
  const icon =
    state.fatigue.value >= 80
      ? "😪"
      : state.blended.valence >= 7
        ? "😊"
        : state.blended.valence <= 3
          ? "😒"
          : "🙂";
  const tag = identity?.trim();
  const personaTag = tag && tag !== "default" ? `${tag}·` : "";
  return `${personaTag}${icon} ${state.blended.mood} (V:${state.blended.valence} E:${state.blended.energy} F:${state.fatigue.value}%)`;
}
