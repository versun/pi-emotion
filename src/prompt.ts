import type { BlendedEmotionResult } from "./types.ts";

/**
 * Determine active valence guidance tier for the current blended valence.
 */
export function describeValenceBehavior(valence: number): string {
  if (valence <= 3) {
    return "valence 0–3（低落/烦躁/冷淡）：回复简短、少热情、可带轻微吐槽或叹气。";
  }
  if (valence < 7) {
    return "valence 4–6（平和）：正常自然交流，语气平稳。";
  }
  return "valence 7–10（开心/温暖/兴奋）：更有表达欲、爱开玩笑、多用表情、互动感更强。";
}

/**
 * Determine active energy guidance tier for the current blended energy.
 */
export function describeEnergyBehavior(energy: number, isSleeping: boolean): string {
  if (isSleeping) {
    return "SLEEPING / energy 0–1（睡眠/迷糊）：处于睡眠或半梦半醒状态，回复极简、迷糊困倦，除非被唤醒。";
  }
  if (energy <= 3) {
    return "energy 0–3（疲惫/犯困）：句子变短、不主动揽活、流露慵懒感。";
  }
  if (energy < 7) {
    return "energy 4–6（常态精力）：正常响应节奏与篇幅。";
  }
  return "energy 7–10（精力充沛）：话多、主动接话、积极帮忙。";
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

  const activeValenceRule = describeValenceBehavior(blended.valence);
  const activeEnergyRule = describeEnergyBehavior(
    blended.energy,
    fatigue.status === "SLEEPING",
  );

  return [
    "### [Emotion & Fatigue Context Block]",
    `- Session ID: ${sessionId}`,
    `- Base mood: ${base.mood} (valence ${base.valence}/10, energy ${base.energy}/10, description: "${base.description}", 6h decay: ${Math.round(base.decayProgress * 100)}%)`,
    `- Context mood: ${contextSummary}`,
    `- BLENDED: ${blended.mood} (valence ${blended.valence}/10, energy ${blended.energy}/10)`,
    `- FATIGUE: ${fatigue.status} (fatigue ${fatigue.value}/100, energy cap ${fatigue.energyCap}/10)`,
    "",
    "#### 当前生效语气画像（请自然融入回复语气、用词、长度与主动性，切勿在回复中机械播报情绪数值）：",
    `- 当前愉悦度表现 -> ${activeValenceRule}`,
    `- 当前精力表现 -> ${activeEnergyRule}`,
    "",
    "#### 行为映射规则参考：",
    "- `valence 0–3`：低落/烦躁/冷淡——回复简短、少热情、可带轻微吐槽或叹气。",
    "- `valence 4–6`：平和——正常自然交流。",
    "- `valence 7–10`：开心/温暖/兴奋——更有表达欲、爱开玩笑、多用表情、互动感更强。",
    "- `energy 0–3`：疲惫/犯困——句子变短、不主动揽活、流露慵懒感。",
    "- `energy 4–6`：常态精力——正常响应节奏与篇幅。",
    "- `energy 7–10`：精力充沛——话多、主动接话、积极帮忙。",
    "",
    "#### 情绪与疲劳工具更新约束（AI 自主按需调用）：",
    "1. **按需更新**：仅在对话氛围真正发生明显情绪变化时才调用 `emotion_set_context`（短期情绪波动，2h 衰减，跨会话共享）或 `emotion_set_base`（影响全局心情基调的重大事件，6h 衰减）；日常普通问答切勿无意义刷接口。",
    `2. **遵循情绪引力（Emotional Gravity）**：更新 \`emotion_set_context\` 时必须参考当前 Base mood 的 \`valence\`（当前为 ${base.valence}/10），避免底层极度低落时因单句夸奖直接跳到满分。`,
    "3. **身心同步（Sleep / Wake 一致性）**：当你在回复中表示准备睡觉、犯困睡去或刚醒来时，必须在同一轮内实际调用 `sleep` 或 `wake`（或完全休息时调用 `rest`），使系统疲劳状态与情绪 `energy` 保持同步一致。",
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
    state.fatigue.status === "SLEEPING"
      ? "💤"
      : state.blended.valence >= 7
        ? "😊"
        : state.blended.valence <= 3
          ? "😒"
          : "🙂";
  const personaTag =
    identity && identity !== "default" ? `${identity}·` : "";
  return `${personaTag}${icon} ${state.blended.mood} (V:${state.blended.valence} E:${state.blended.energy} F:${state.fatigue.value}%)`;
}
