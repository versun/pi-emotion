import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASE_DECAY_MS,
  blendValenceWithGravity,
  CONTEXT_DECAY_MS,
  clampValenceByGravity,
  computeFatigueValencePenalty,
  computeRecoveredFatigue,
  createEmotionExtension,
  describeEnergyBehavior,
  describeValenceBehavior,
  EmotionEngine,
  executeCliCommand,
  formatEmotionStatusBadge,
  isCustomIdentity,
  resolveIdentity,
  resolveStoragePath,
  tokenizeArgs,
} from "../src/index.ts";

function createTempStateFile(): { filePath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-emotion-test-"));
  const filePath = path.join(tmpDir, "emotion-state.json");
  return {
    filePath,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("Layered Emotion & Fatigue System Plugin", () => {
  it("1. 6h Base Mood lazy decay smoothly interpolates and fully reverts to Default Baseline at >= 6h", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        baseline: {
          mood: "cheerful",
          energy: 7,
          valence: 7,
          description: "curious, slightly sassy, warm",
        },
        now: () => currentTime,
      });

      // Set low base mood at t = 0
      const t0 = engine.setBase({
        mood: "melancholy",
        energy: 3,
        valence: 2,
        description: "drained after a rough debugging session",
      });
      assert.equal(t0.base.mood, "melancholy");
      assert.equal(t0.base.energy, 3);
      assert.equal(t0.base.valence, 2);
      assert.equal(t0.base.decayProgress, 0);

      // Advance 3 hours (50% of 6h decay window)
      currentTime += BASE_DECAY_MS / 2;
      const t3h = engine.getBlendedEmotion();
      assert.equal(t3h.base.decayProgress, 0.5);
      // Halfway between 2 and 7 is 4.5; halfway between 3 and 7 is 5.0
      assert.equal(t3h.base.valence, 4.5);
      assert.equal(t3h.base.energy, 5);
      assert.equal(t3h.blended.valence, 4.5);
      assert.equal(t3h.blended.energy, 5);

      // Advance to full 6 hours (100% decay)
      currentTime += BASE_DECAY_MS / 2;
      const t6h = engine.getBlendedEmotion();
      assert.equal(t6h.base.decayProgress, 1);
      assert.equal(t6h.base.mood, "cheerful");
      assert.equal(t6h.base.valence, 7);
      assert.equal(t6h.base.energy, 7);
      assert.equal(t6h.base.description, "curious, slightly sassy, warm");
      assert.equal(t6h.blended.mood, "cheerful");
    } finally {
      cleanup();
    }
  });

  it("2. 2h Context Mood lazy decay & shared across sessions", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      // Baseline is valence 7, energy 7. Set shared context mood to frustrated (valence 3)
      const afterSet = engine.setContext({
        mood: "frustrated",
        valence: 3,
        trigger: "flaky test suite",
      });

      assert.ok(afterSet.context);
      assert.equal(afterSet.context.mood, "frustrated");
      assert.equal(afterSet.context.valence, 3);
      assert.equal(afterSet.context.remainingWeight, 1);
      assert.equal(afterSet.blended.mood, "frustrated");
      // At t=0, blended.valence = round1(7 * 0.35 + 3 * 0.65) = 4.4
      assert.equal(afterSet.blended.valence, 4.4);

      // Shared context: a mood set in one session is visible to all reads
      const otherRead = engine.getBlendedEmotion();
      assert.ok(otherRead.context);
      assert.equal(otherRead.blended.mood, "frustrated");
      assert.equal(otherRead.blended.valence, 4.4);

      // Advance 1 hour (50% of 2h context decay window)
      currentTime += CONTEXT_DECAY_MS / 2;
      const t1h = engine.getBlendedEmotion();
      assert.ok(t1h.context);
      assert.equal(t1h.context.remainingWeight, 0.5);
      // Pull weakens at 1h: blended valence moves closer to base valence 7 (5.7 > 4.4)
      assert.ok(t1h.blended.valence > afterSet.blended.valence);
      assert.ok(t1h.blended.valence < 7);

      // Advance past 2 hours: Context Mood expires (null) and is pruned
      currentTime += CONTEXT_DECAY_MS / 2 + 1000;
      const t2h = engine.getBlendedEmotion();
      assert.equal(t2h.context, null);
      assert.equal(t2h.blended.mood, "cheerful");
      assert.equal(t2h.blended.valence, 7);

      const status = engine.getStatus();
      assert.equal(status.context, null);
    } finally {
      cleanup();
    }
  });

  it("3. Emotional Gravity limits high Context stimulus when Base Mood is deeply low", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        maxGravityDelta: 4.0,
        contextWeight: 0.65,
        now: () => currentTime,
      });

      // Set deeply low Base Mood (valence = 1, mood = "depressed")
      engine.setBase({
        mood: "depressed",
        energy: 3,
        valence: 1,
        description: "feeling down after production outage",
      });

      // Direct unit check on gravity clamping and blending (including out-of-range base clamping)
      assert.equal(clampValenceByGravity(10, 1, 4), 5);
      assert.equal(blendValenceWithGravity(15, 10, 0), 10);
      assert.equal(blendValenceWithGravity(-5, 0, 0), 0);

      // Stimulate with an extreme positive Context event (valence = 10)
      const blended = engine.setContext({
        mood: "flattered",
        valence: 10,
        trigger: "user gave a sudden compliment",
      });

      // 1) Context valence itself is clamped by Base gravity: 1 + 4 = 5 (cannot jump to 10)
      assert.ok(blended.context);
      assert.equal(blended.context.valence, 5);

      // 2) Blended valence is weighted between Base (1) and Clamped Context (5):
      //    1 * 0.35 + 5 * 0.65 = 3.6 (far below 10; prevents instant euphoria from one compliment)
      assert.equal(blended.blended.valence, 3.6);
      assert.ok(blended.blended.valence < 5);
      assert.ok(blended.blended.valence > blended.base.valence);
    } finally {
      cleanup();
    }
  });

  it("4. Workload fatigue caps energy, drags valence when exhausted, recovers lazily over idle time, and resets via rest()", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      // Direct math checks
      assert.equal(computeRecoveredFatigue(60, 2 * 60 * 60 * 1000, 15), 30);
      assert.equal(computeFatigueValencePenalty(60, 60, 1.5), 0);
      assert.equal(computeFatigueValencePenalty(100, 60, 1.5), 1.5);
      // Setting threshold = 100 disables valence drag without a cliff at fatigue = 100
      assert.equal(computeFatigueValencePenalty(100, 100, 1.5), 0);

      // Accumulate high fatigue (80/100):
      // - energy cap drops to 10 - 0.8 * 9 = 2.8
      // - valence drag = ((80 - 60) / 40) * 1.5 = 0.75 => blended valence = round1(7 - 0.75) = 6.3
      const tired = engine.setFatigue(80);
      assert.equal(tired.fatigue.value, 80);
      assert.equal(tired.fatigue.energyCap, 2.8);
      assert.equal(tired.base.energy, 2.8);
      assert.equal(tired.blended.energy, 2.8);
      assert.equal(tired.blended.valence, 6.3);

      // Setting high Base energy (9) while fatigue is 80 dynamically caps displayed energy at 2.8
      // while keeping raw persisted energy intact so it rebounds once fatigue drops
      const cappedBase = engine.setBase({
        mood: "excited",
        energy: 9,
        valence: 8,
        description: "trying to stay hyped despite exhaustion",
      });
      assert.equal(cappedBase.base.energy, 2.8);
      assert.equal(engine.getStatus().base.raw.energy, 9);

      // Idle 4 hours (4 * 15 = 60 pts recovered): fatigue drops 80 -> 20, energyCap rises to 8.2,
      // valence drag drops to 0, and base energy rebounds smoothly along its 9 -> 7 decay curve (7.7)
      currentTime += 4 * 60 * 60 * 1000;
      const recovered = engine.getBlendedEmotion();
      assert.equal(recovered.fatigue.value, 20);
      assert.equal(recovered.fatigue.energyCap, 8.2);
      assert.equal(recovered.base.energy, 7.7);
      assert.equal(recovered.blended.valence, recovered.base.valence);

      // getFatigueStatus() also returns lazily recovered fatigue
      const fatigueStatus = engine.getFatigueStatus();
      assert.equal(fatigueStatus.value, 20);
      assert.equal(fatigueStatus.energyCap, 8.2);

      // Call rest(): fatigue resets to 0, energy boosts to >= 8
      const rested = engine.rest();
      assert.equal(rested.fatigue.value, 0);
      assert.equal(rested.fatigue.energyCap, 10);
      assert.ok(rested.base.energy >= 8);
      assert.equal(rested.blended.energy, rested.base.energy);
    } finally {
      cleanup();
    }
  });

  it("5. Pre-Prompt Hook, turn_end workload hook, AI Tools (no sleep/wake), and CLI integrate end-to-end", async () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      const ext = createEmotionExtension({
        storagePath: filePath,
        now: () => currentTime,
      });

      const registeredTools = new Map<string, any>();
      const registeredCommands = new Map<string, any>();
      const eventHandlers = new Map<string, Function[]>();

      const mockPi: any = {
        registerTool(def: any) {
          registeredTools.set(def.name, def);
        },
        registerCommand(name: string, def: any) {
          registeredCommands.set(name, def);
        },
        on(event: string, handler: Function) {
          const list = eventHandlers.get(event) ?? [];
          list.push(handler);
          eventHandlers.set(event, list);
        },
      };

      ext(mockPi);

      // Verify the 6 active tools are registered and sleep/wake are gone
      for (const toolName of [
        "emotion_status",
        "emotion_get",
        "emotion_set_base",
        "emotion_set_context",
        "rest",
        "fatigue_status",
      ]) {
        assert.ok(registeredTools.has(toolName), `Missing tool: ${toolName}`);
      }
      assert.equal(registeredTools.has("sleep"), false);
      assert.equal(registeredTools.has("wake"), false);
      assert.ok(
        Array.isArray(registeredTools.get("rest").promptGuidelines) &&
          registeredTools.get("rest").promptGuidelines.length > 0,
      );
      assert.ok(registeredCommands.has("emotion"));

      const mockCtx: any = {
        hasUI: false,
        sessionManager: {
          getSessionId: () => "session-xyz",
        },
      };

      // Invoke emotion_set_context tool
      const setCtxTool = registeredTools.get("emotion_set_context");
      await setCtxTool.execute(
        "call-1",
        {
          mood: "playful",
          valence: 9,
          trigger: "bantering with user",
        },
        undefined,
        undefined,
        mockCtx,
      );

      // Simulate a turn_end with 4 coding tool calls and 1 error:
      // fatigue += 2.0 (turn) + 4 * 0.5 (tools) + 1 * 1.0 (error) = 5.0
      const turnEndHandlers = eventHandlers.get("turn_end") ?? [];
      assert.equal(turnEndHandlers.length, 1);
      await turnEndHandlers[0](
        {
          turnIndex: 0,
          toolResults: [
            { toolName: "read", isError: false },
            { toolName: "edit", isError: false },
            { toolName: "bash", isError: true },
            { toolName: "bash", isError: false },
            { toolName: "emotion_set_context", isError: false }, // passive, excluded
          ],
        },
        mockCtx,
      );
      assert.equal(ext.engine.getFatigueStatus().value, 5);

      // Trigger Pre-Prompt Hook (before_agent_start)
      const beforeStartHandlers = eventHandlers.get("before_agent_start") ?? [];
      assert.equal(beforeStartHandlers.length, 1);

      const promptEvent: any = {
        systemPrompt: "You are Pi.",
        systemPromptOptions: {
          sections: {},
        },
      };

      const hookResult = await beforeStartHandlers[0](promptEvent, mockCtx);

      // Sections path: injects via systemPromptOptions.sections and returns undefined
      assert.equal(hookResult, undefined);
      const sectionText: string =
        promptEvent.systemPromptOptions.sections.emotion_and_fatigue;
      assert.ok(sectionText.includes("[Emotion & Fatigue Context Block]"));
      assert.ok(sectionText.includes("BLENDED: playful"));
      assert.ok(sectionText.includes("FATIGUE: 5/100"));
      assert.equal(sectionText.includes("Mind-Body Sync"), false);
      assert.equal(sectionText.includes("SLEEPING"), false);

      // Fallback path: without systemPromptOptions, the block is appended once
      const fallbackEvent: any = { systemPrompt: "You are Pi." };
      const fallbackResult = await beforeStartHandlers[0](fallbackEvent, mockCtx);
      assert.ok(
        fallbackResult?.systemPrompt.includes("[Emotion & Fatigue Context Block]"),
      );
      assert.ok(fallbackResult?.systemPrompt.includes("valence 0–3"));
      assert.ok(fallbackResult?.systemPrompt.includes("energy 0–3"));
      assert.equal(
        fallbackResult.systemPrompt.split("[Emotion & Fatigue Context Block]")
          .length - 1,
        1,
      );

      // Verify CLI command dispatcher works for status, get, and workload
      const getJson = JSON.parse(executeCliCommand(ext.engine, ["get"]));
      assert.equal(getJson.blended.mood, "playful");
      assert.equal(getJson.fatigue.value, 5);

      const workloadJson = JSON.parse(
        executeCliCommand(ext.engine, ["workload", "1", "2", "0"]),
      );
      assert.equal(workloadJson.fatigue.value, 8); // 5 + (2 + 2*0.5)
    } finally {
      cleanup();
    }
  });

  it("6. Workload edge cases: recovery before accumulation, per-turn cap, zero-delta no-op, and rest turn_end guard", async () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const ext = createEmotionExtension({
        storagePath: filePath,
        now: () => currentTime,
      });
      const engine = ext.engine;

      // Build fatigue to 45 at t = 0
      engine.setFatigue(45);

      // Idle 2 hours (recovers 30 pts -> effective fatigue 15), then complete 1 turn (+2)
      // Must apply recovery BEFORE adding workload: 15 + 2 = 17 (NOT 45 + 2 = 47)
      currentTime += 2 * 60 * 60 * 1000;
      const afterBreak = engine.recordWorkload({ turns: 1 });
      assert.equal(afterBreak.fatigue.value, 17);

      // Massive single-turn parallel batch is capped at maxFatiguePerTurn (default 12)
      const afterBurst = engine.recordWorkload({
        turns: 1,
        toolCalls: 40,
        toolErrors: 10,
      });
      assert.equal(afterBurst.fatigue.value, 29); // 17 + 12

      // Multi-turn workload scales the per-turn cap with `turns` instead of clipping to 12
      const afterMultiTurn = engine.recordWorkload({ turns: 10 });
      assert.equal(afterMultiTurn.fatigue.value, 49); // 29 + 20

      // Zero-delta workload is a no-op and does not advance fatigue.updatedAt
      const prevUpdatedAt = afterMultiTurn.fatigue.updatedAt;
      currentTime += 60_000;
      const noop = engine.recordWorkload({ turns: 0, toolCalls: 0, toolErrors: 0 });
      assert.equal(noop.fatigue.updatedAt, prevUpdatedAt);

      // Explicit fatigueDelta override works cleanly
      const explicit = engine.recordWorkload({ fatigueDelta: 10 });
      assert.ok(explicit.fatigue.value >= 58 && explicit.fatigue.value <= 59);

      // In Pi extension: a turn_end containing successful `rest` leaves fatigue at 0
      const handlers = new Map<string, Function[]>();
      ext({
        registerTool() {},
        registerCommand() {},
        on(ev: string, fn: Function) {
          handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
        },
      } as any);

      engine.rest();
      assert.equal(engine.getFatigueStatus().value, 0);
      await handlers.get("turn_end")?.[0](
        { turnIndex: 1, toolResults: [{ toolName: "rest", isError: false }] },
        { hasUI: false },
      );
      assert.equal(engine.getFatigueStatus().value, 0);

      // Aborted or provider-errored empty turns add no fatigue
      await handlers.get("turn_end")?.[0](
        { turnIndex: 2, outcome: "aborted", toolResults: [] },
        { hasUI: false },
      );
      await handlers.get("turn_end")?.[0](
        { turnIndex: 3, outcome: "error", toolResults: [] },
        { hasUI: false },
      );
      assert.equal(engine.getFatigueStatus().value, 0);

      // Failed `rest` (isError: true) does NOT suppress turn fatigue
      await handlers.get("turn_end")?.[0](
        { turnIndex: 4, toolResults: [{ toolName: "rest", isError: true }] },
        { hasUI: false },
      );
      assert.equal(engine.getFatigueStatus().value, 2);

      // highFatigueValenceThreshold = 100 disables valence drag even at fatigue = 100
      const noDrag = new EmotionEngine({
        storagePath: filePath,
        highFatigueValenceThreshold: 100,
        now: () => currentTime,
      });
      const maxed = noDrag.setFatigue(100);
      assert.equal(maxed.blended.valence, maxed.base.valence);

      // Invalid NaN options & NaN setFatigue never wipe fatigue to 0
      const hardened = new EmotionEngine({
        storagePath: filePath,
        fatiguePerTurn: Number.NaN,
        maxFatiguePerTurn: Number.NaN,
        fatigueRecoveryPerHour: -5,
        now: () => currentTime,
      });
      hardened.setFatigue(40);
      hardened.setFatigue(Number.NaN);
      assert.equal(hardened.getFatigueStatus().value, 40);
      const afterNaNOptsWork = hardened.recordWorkload({ turns: 1 });
      assert.equal(afterNaNOptsWork.fatigue.value, 42);
      assert.equal(hardened.getStatus().blended.energy, afterNaNOptsWork.blended.energy);
    } finally {
      cleanup();
    }
  });

  it("7. Multi-user isolation via PI_EMOTION_USER identity files", () => {
    const { filePath, cleanup } = createTempStateFile();
    const stateDir = path.dirname(filePath);
    const origEnv = {
      PI_EMOTION_STATE_PATH: process.env.PI_EMOTION_STATE_PATH,
      PI_EMOTION_STATE_DIR: process.env.PI_EMOTION_STATE_DIR,
      PI_EMOTION_USER: process.env.PI_EMOTION_USER,
    };
    try {
      process.env.PI_EMOTION_STATE_DIR = path.join(stateDir, "emotion-state");
      delete process.env.PI_EMOTION_USER;
      delete process.env.PI_EMOTION_STATE_PATH;

      const alice = new EmotionEngine({ identity: "pi-emotion-test-alice" });
      const bob = new EmotionEngine({ identity: "pi-emotion-test-bob" });

      // Each custom identity gets a private file under emotion-state/users/
      assert.ok(
        alice.storage.filePath.endsWith(
          path.join("users", "pi-emotion-test-alice.json"),
        ),
      );
      assert.ok(
        bob.storage.filePath.endsWith(
          path.join("users", "pi-emotion-test-bob.json"),
        ),
      );
      assert.notEqual(alice.storage.filePath, bob.storage.filePath);

      // Alice accumulates fatigue; Bob is unaffected
      alice.recordWorkload({ fatigueDelta: 40 });
      assert.equal(alice.getFatigueStatus().value, 40);
      assert.equal(bob.getFatigueStatus().value, 0);

      // Bob's context mood does not leak into Alice's
      bob.setContext({ mood: "annoyed", valence: 2, trigger: "noise" });
      assert.equal(alice.getBlendedEmotion().context, null);
      assert.equal(alice.identity, "pi-emotion-test-alice");
      assert.equal(bob.identity, "pi-emotion-test-bob");

      // Env-var driven identity also resolves
      process.env.PI_EMOTION_USER = "pi-emotion-test-carol";
      const carol = new EmotionEngine({});
      assert.equal(carol.identity, "pi-emotion-test-carol");
      assert.ok(
        carol.storage.filePath.endsWith(
          path.join("users", "pi-emotion-test-carol.json"),
        ),
      );
    } finally {
      if (origEnv.PI_EMOTION_STATE_PATH === undefined) {
        delete process.env.PI_EMOTION_STATE_PATH;
      } else {
        process.env.PI_EMOTION_STATE_PATH = origEnv.PI_EMOTION_STATE_PATH;
      }
      if (origEnv.PI_EMOTION_STATE_DIR === undefined) {
        delete process.env.PI_EMOTION_STATE_DIR;
      } else {
        process.env.PI_EMOTION_STATE_DIR = origEnv.PI_EMOTION_STATE_DIR;
      }
      if (origEnv.PI_EMOTION_USER === undefined) {
        delete process.env.PI_EMOTION_USER;
      } else {
        process.env.PI_EMOTION_USER = origEnv.PI_EMOTION_USER;
      }
      cleanup();
    }
  });

  it("8. Legacy per-chatId `contexts` dict and legacy `fatigue.status` migrate cleanly", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      const legacyState = {
        version: 1,
        baseline: {
          mood: "cheerful",
          energy: 7,
          valence: 7,
          description: "curious, slightly sassy, warm",
        },
        base: {
          mood: "cheerful",
          energy: 7,
          valence: 7,
          description: "curious, slightly sassy, warm",
          updatedAt: currentTime,
        },
        contexts: {
          "chat-a": {
            mood: "nostalgic",
            valence: 4,
            trigger: "old photos",
            updatedAt: currentTime - 60 * 60 * 1000,
          },
          "chat-b": {
            mood: "determined",
            valence: 8,
            trigger: "fresh sprint kickoff",
            updatedAt: currentTime - 10 * 60 * 1000,
          },
        },
        fatigue: { status: "SLEEPING", fatigue: 45, updatedAt: currentTime },
      };
      fs.writeFileSync(filePath, JSON.stringify(legacyState, null, 2), "utf8");

      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      // The newest legacy entry (chat-b) becomes the shared context, and legacy fatigue.status is dropped cleanly
      const blended = engine.getBlendedEmotion();
      assert.ok(blended.context);
      assert.equal(blended.context.mood, "determined");
      assert.equal(blended.context.trigger, "fresh sprint kickoff");
      assert.equal(blended.blended.mood, "determined");
      assert.equal(blended.fatigue.value, 45);
      assert.equal("status" in blended.fatigue, false);
    } finally {
      cleanup();
    }
  });

  it("9. Corrupted state file falls back to a valid initial state and is rewritten", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      fs.writeFileSync(filePath, "not json{", "utf8");

      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      // Load falls back to baseline defaults instead of throwing
      const blended = engine.getBlendedEmotion();
      assert.equal(blended.base.mood, "cheerful");
      assert.equal(blended.base.valence, 7);
      assert.equal(blended.context, null);
      assert.equal(blended.fatigue.value, 0);

      // The corrupted file is rewritten with valid state JSON
      const reloaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(reloaded.version, 1);
      assert.equal(reloaded.base.mood, "cheerful");
      assert.equal(reloaded.fatigue.fatigue, 0);
      assert.equal("status" in reloaded.fatigue, false);
    } finally {
      cleanup();
    }
  });

  it("10. Shared context is persisted at disk level and visible to a second engine instance", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      const first = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });
      first.setContext({
        mood: "focused",
        valence: 6,
        trigger: "deep work block",
      });

      // A second engine on the same storagePath reads the context from disk
      const second = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });
      const blended = second.getBlendedEmotion();
      assert.ok(blended.context);
      assert.equal(blended.context.mood, "focused");
      assert.equal(blended.context.trigger, "deep work block");
      assert.equal(blended.blended.mood, "focused");
    } finally {
      cleanup();
    }
  });

  it("11. setFatigue() preserves base mood, description, 6h decay timer, and lets energy rebound dynamically", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        baseline: { mood: "calm", energy: 4, valence: 6, description: "steady" },
        now: () => currentTime,
      });

      const t0 = currentTime;
      engine.setBase({
        mood: "hyped",
        energy: 9,
        valence: 9,
        description: "launched new release",
      });

      // Advance 3h (50% decay): raw decayed energy is 6.5, valence is 7.5
      currentTime += BASE_DECAY_MS / 2;

      // Temporarily spike fatigue to 80 (caps displayed energy to 2.8)
      const spiked = engine.setFatigue(80);
      assert.equal(spiked.base.energy, 2.8);
      assert.equal(spiked.base.updatedAt, t0);
      assert.equal(spiked.base.decayProgress, 0.5);
      assert.equal(spiked.base.mood, "hyped");
      assert.equal(spiked.base.description, "launched new release");

      // Lowering fatigue back to 0 immediately restores the decayed energy (6.5) without clipping it
      const cleared = engine.setFatigue(0);
      assert.equal(cleared.base.updatedAt, t0);
      assert.equal(cleared.base.decayProgress, 0.5);
      assert.equal(cleared.base.energy, 6.5);
      assert.equal(cleared.base.valence, 7.5);
    } finally {
      cleanup();
    }
  });

  it("12. rest() keeps base mood/description coherent and boosts energy & valence", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        baseline: { mood: "calm", energy: 6, valence: 7, description: "steady" },
        now: () => currentTime,
      });

      engine.setBase({
        mood: "focused",
        energy: 4,
        valence: 5,
        description: "in the zone",
      });
      engine.setFatigue(75);

      const rested = engine.rest();
      assert.equal(rested.fatigue.value, 0);
      assert.equal(rested.fatigue.energyCap, 10);
      assert.equal(rested.base.mood, "focused");
      assert.equal(rested.base.description, "in the zone");
      assert.equal(rested.base.energy, 8);
      assert.equal(rested.base.valence, 7);
    } finally {
      cleanup();
    }
  });

  it("13. Exponential decay curve front-loads decay and honors exact 6h/2h boundaries", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        decayCurve: "exponential",
        now: () => currentTime,
      });

      engine.setBase({ mood: "gloomy", energy: 1, valence: 1, description: "low" });
      engine.setContext({ mood: "amused", valence: 5, trigger: "meme" });

      // Halfway through 2h context window: exponential decays faster than linear (> 50% decayed => remainingWeight < 0.5)
      currentTime += CONTEXT_DECAY_MS / 2;
      const t1h = engine.getBlendedEmotion();
      assert.ok(t1h.context);
      assert.ok(t1h.context.remainingWeight < 0.5);
      assert.ok(t1h.base.decayProgress > 1 / 6);

      // Just before exact 2h boundary: context is still active
      currentTime = 1_700_000_000_000 + CONTEXT_DECAY_MS - 1000;
      assert.ok(engine.getBlendedEmotion().context);

      // At exact 2h boundary: context expires
      currentTime = 1_700_000_000_000 + CONTEXT_DECAY_MS;
      assert.equal(engine.getBlendedEmotion().context, null);

      // Just before 6h boundary: base mood has NOT reverted yet
      currentTime = 1_700_000_000_000 + BASE_DECAY_MS - 1000;
      assert.equal(engine.getBlendedEmotion().base.mood, "gloomy");

      // At exact 6h boundary: base mood reverts to baseline
      currentTime = 1_700_000_000_000 + BASE_DECAY_MS;
      assert.equal(engine.getBlendedEmotion().base.mood, "cheerful");
      assert.equal(engine.getBlendedEmotion().base.decayProgress, 1);
    } finally {
      cleanup();
    }
  });

  it("14. setBaseline() ignores NaN and blank strings without corrupting existing baseline", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const engine = new EmotionEngine({ storagePath: filePath });
      const updated = engine.setBaseline({
        mood: "   ",
        energy: Number.NaN,
        valence: 8.5,
        description: "",
      });

      assert.equal(updated.mood, "cheerful");
      assert.equal(updated.energy, 7);
      assert.equal(updated.valence, 8.5);
      assert.equal(updated.description, "curious, slightly sassy, warm");
    } finally {
      cleanup();
    }
  });

  it("15. Storage resilience: non-object JSON roots, corrupted legacy contexts, whitespace env, dot identities", () => {
    const { filePath, cleanup } = createTempStateFile();
    const origPath = process.env.PI_EMOTION_STATE_PATH;
    const origUser = process.env.PI_EMOTION_USER;
    const origDir = process.env.PI_EMOTION_STATE_DIR;
    try {
      delete process.env.PI_EMOTION_STATE_PATH;
      const currentTime = 1_700_000_000_000;

      // Non-object JSON roots ("123", "[]", "null") all recover and rewrite valid JSON
      for (const badRoot of ["123", "[]", "null", '"hello"']) {
        fs.writeFileSync(filePath, badRoot, "utf8");
        const engine = new EmotionEngine({ storagePath: filePath, now: () => currentTime });
        const blended = engine.getBlendedEmotion();
        assert.equal(blended.base.mood, "cheerful");
        const disk = JSON.parse(fs.readFileSync(filePath, "utf8"));
        assert.equal(disk.version, 1);
      }

      // Legacy contexts dict where first entry has invalid updatedAt still picks valid newest entry
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          contexts: {
            broken: { mood: "stale", valence: "bad", updatedAt: null },
            valid: { mood: "relieved", valence: 8, trigger: "tests passed", updatedAt: currentTime - 1000 },
          },
        }),
        "utf8",
      );
      const engine = new EmotionEngine({ storagePath: filePath, now: () => currentTime });
      const blended = engine.getBlendedEmotion();
      assert.ok(blended.context);
      assert.equal(blended.context.mood, "relieved");

      // Whitespace PI_EMOTION_USER / PI_EMOTION_STATE_DIR / identity fall through cleanly
      process.env.PI_EMOTION_USER = "   ";
      assert.notEqual(resolveIdentity(), "   ");
      assert.equal(isCustomIdentity("   "), false);
      assert.ok(resolveStoragePath("   ").endsWith("emotion-state.json"));

      process.env.PI_EMOTION_STATE_DIR = "   ";
      const fallbackUserPath = resolveStoragePath("pi-emotion-test-trim");
      assert.ok(fallbackUserPath.endsWith(path.join("emotion-state", "users", "pi-emotion-test-trim.json")));

      // Dot-only identity sanitizes safely instead of creating a hidden/traversal path
      process.env.PI_EMOTION_STATE_DIR = path.dirname(filePath);
      const dotPath = resolveStoragePath("...");
      assert.ok(dotPath.endsWith(path.join("users", "default.json")));

      // Explicit PI_EMOTION_STATE_PATH overrides custom identity / PI_EMOTION_STATE_DIR
      process.env.PI_EMOTION_STATE_PATH = filePath;
      assert.equal(resolveStoragePath("pi-emotion-test-alice"), path.resolve(filePath));
    } finally {
      if (origPath === undefined) delete process.env.PI_EMOTION_STATE_PATH;
      else process.env.PI_EMOTION_STATE_PATH = origPath;
      if (origUser === undefined) delete process.env.PI_EMOTION_USER;
      else process.env.PI_EMOTION_USER = origUser;
      if (origDir === undefined) delete process.env.PI_EMOTION_STATE_DIR;
      else process.env.PI_EMOTION_STATE_DIR = origDir;
      cleanup();
    }
  });

  it("16. Badge formatting (normal & exhausted icon, no stray leading space) and UI status updates", async () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      const ext = createEmotionExtension({
        storagePath: filePath,
        identity: "pi-emotion-test-alice",
        now: () => currentTime,
      });

      const badge = formatEmotionStatusBadge(ext.engine.getBlendedEmotion(), "alice");
      assert.ok(badge.startsWith("alice·😊"), `Unexpected badge: ${JSON.stringify(badge)}`);
      assert.ok(
        formatEmotionStatusBadge(ext.engine.getBlendedEmotion(), "   ").startsWith("😊"),
        "Whitespace identity should not emit a blank prefix",
      );

      const exhausted = ext.engine.setFatigue(85);
      const tiredBadge = formatEmotionStatusBadge(exhausted, "alice");
      assert.ok(tiredBadge.startsWith("alice·😪"), `Expected exhausted icon, got ${JSON.stringify(tiredBadge)}`);
      ext.engine.rest();

      const handlers = new Map<string, Function[]>();
      const mockPi: any = {
        registerTool() {},
        registerCommand() {},
        on(event: string, fn: Function) {
          handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        },
      };
      ext(mockPi);

      const statuses: Array<[string, string]> = [];
      const mockCtx: any = {
        hasUI: true,
        ui: {
          setStatus(key: string, value: string) {
            statuses.push([key, value]);
          },
        },
        sessionManager: { getSessionId: () => "sess-1" },
      };

      await handlers.get("session_start")?.[0]({}, mockCtx);
      await handlers.get("before_agent_start")?.[0](
        { systemPrompt: "sys", systemPromptOptions: { sections: {} } },
        mockCtx,
      );
      await handlers.get("turn_end")?.[0](
        { turnIndex: 0, toolResults: [{ toolName: "bash", isError: false }] },
        mockCtx,
      );

      assert.equal(statuses.length, 3);
      assert.equal(statuses[0][0], "pi-emotion");
      assert.ok(statuses[0][1].startsWith("pi-emotion-test-alice·"));
      assert.equal(statuses[1][1], statuses[0][1]);
      assert.ok(statuses[2][1].includes("F:2.5%"), `Expected updated fatigue badge, got ${statuses[2][1]}`);
    } finally {
      cleanup();
    }
  });

  it("17. tokenizeArgs preserves contractions, and tools/CLI validate numeric inputs and removed commands", async () => {
    assert.deepEqual(
      tokenizeArgs(`set-context annoyed 3 user's build don't work`),
      ["set-context", "annoyed", "3", "user's", "build", "don't", "work"],
    );
    assert.deepEqual(
      tokenizeArgs(`set-base cheerful 7 7 "don't worry" 'all good'`),
      ["set-base", "cheerful", "7", "7", "don't worry", "all good"],
    );

    const { filePath, cleanup } = createTempStateFile();
    try {
      const ext = createEmotionExtension({ storagePath: filePath });
      const registeredTools = new Map<string, any>();
      const registeredCommands = new Map<string, any>();

      ext({
        registerTool(def: any) {
          registeredTools.set(def.name, def);
        },
        registerCommand(name: string, def: any) {
          registeredCommands.set(name, def);
        },
        on() {},
      } as any);

      // Non-finite, blank string, or non-numeric primitive params in tools throw clearly instead of coercing to 0/1
      for (const badVal of ["oops", "", null, false, true, []]) {
        await assert.rejects(
          () =>
            registeredTools.get("emotion_set_base").execute(
              "c1",
              { mood: "happy", energy: badVal, valence: 7, description: "test" },
              undefined,
              undefined,
              { hasUI: false },
            ),
          /finite numbers/,
        );
      }
      for (const badVal of [Number.NaN, null, false, ""]) {
        await assert.rejects(
          () =>
            registeredTools.get("emotion_set_context").execute(
              "c2",
              { mood: "amused", valence: badVal, trigger: "joke" },
              undefined,
              undefined,
              { hasUI: false },
            ),
          /finite number/,
        );
      }

      // Prompt tier helpers classify exact < 7 boundary and non-finite inputs into neutral 4–6 tier
      assert.ok(describeValenceBehavior(6.9995).startsWith("valence 4–6"));
      assert.ok(describeEnergyBehavior(6.9995).startsWith("energy 4–6"));
      assert.ok(describeValenceBehavior(Number.NaN).startsWith("valence 4–6"));
      assert.ok(describeEnergyBehavior(Number.NaN).startsWith("energy 4–6"));

      // CLI validation errors (including blank strings & removed sleep/wake) & /emotion slash command UI error notification
      assert.throws(() => executeCliCommand(ext.engine, ["fatigue", "abc"]), /must be a number/);
      assert.throws(() => executeCliCommand(ext.engine, ["fatigue", ""]), /must be a number/);
      assert.throws(() => executeCliCommand(ext.engine, ["workload", "abc"]), /must be numbers/);
      assert.throws(() => executeCliCommand(ext.engine, ["workload", "   "]), /must be numbers/);
      assert.throws(() => executeCliCommand(ext.engine, ["workload", "-1"]), /must be numbers/);
      assert.throws(() => executeCliCommand(ext.engine, ["workload", "1", "-2"]), /must be numbers/);
      assert.throws(() => executeCliCommand(ext.engine, ["workload", "1", "0", "-1"]), /must be numbers/);
      assert.throws(() => executeCliCommand(ext.engine, ["set-base", "happy", "", "5", "desc"]), /must be numbers/);
      assert.throws(() => executeCliCommand(ext.engine, ["sleep"]), /Unknown emotion command/);
      assert.throws(() => executeCliCommand(ext.engine, ["wake"]), /Unknown emotion command/);
      assert.throws(() => executeCliCommand(ext.engine, ["bogus"]), /Supported:.*workload/);

      const notifications: Array<[string, string]> = [];
      await registeredCommands.get("emotion").handler("fatigue notanumber", {
        hasUI: true,
        ui: {
          setStatus() {},
          notify(msg: string, level: string) {
            notifications.push([msg, level]);
          },
        },
      });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0][1], "error");
    } finally {
      cleanup();
    }
  });

  it("18. High-frequency workload avoids double-rounding drift, expired setBase(NaN) falls back to decayed baseline, and high-fatigue prompt reflects energy cap", async () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const ext = createEmotionExtension({
        storagePath: filePath,
        now: () => currentTime,
      });
      const engine = ext.engine;

      // 30 rapid turns spaced 10s apart (5 minutes total = 1.25 pts idle recovery at 15 pts/hr).
      // Exact accumulation: first turn +2 at t=0, then 29 turns each recovering 10/3600*15 (~0.0417) and adding +2:
      // 30 * 2 - 29 * (15 * 10 / 3600) = 60 - 1.2083 = 58.7917 -> displayed as 58.8 (not 60.0 from swallowed rounding).
      engine.recordWorkload({ turns: 1 });
      for (let i = 0; i < 29; i += 1) {
        currentTime += 10_000;
        engine.recordWorkload({ turns: 1 });
      }
      assert.equal(engine.getFatigueStatus().value, 58.8);

      // Huge turns overflows safely to max fatigue 100 instead of NaN/0
      const overflowed = engine.recordWorkload({ turns: 1e308 });
      assert.equal(overflowed.fatigue.value, 100);

      // setFatigue keeps 3-decimal precision on disk (consistent with recordWorkload) and rounds to 1 decimal on display
      const precise = engine.setFatigue(12.345);
      assert.equal(precise.fatigue.value, 12.3);
      assert.equal(engine.getStatus().fatigue.raw.fatigue, 12.345);

      // Active Base Mood with blank mood/description preserves current decayed mood/description
      engine.setBase({ mood: "gloomy", energy: 2, valence: 2, description: "down" });
      const preserved = engine.setBase({
        mood: "   ",
        energy: Number.NaN,
        valence: Number.NaN,
        description: "",
      });
      assert.equal(preserved.base.mood, "gloomy");
      assert.equal(preserved.base.description, "down");

      // Expired Base Mood (> 6h) with NaN energy/valence falls back to decayed baseline (7/7),
      // rather than resurrecting the stale pre-decay disk values (2/2).
      currentTime += BASE_DECAY_MS + 1_000;
      const afterNaNSet = engine.setBase({
        mood: "steady",
        energy: Number.NaN,
        valence: Number.NaN,
        description: "back to normal",
      });
      assert.equal(afterNaNSet.base.energy, 7);
      assert.equal(afterNaNSet.base.valence, 7);

      // High-fatigue Pre-Prompt Hook reflects capped energy and tired guidance tier
      engine.setFatigue(85);
      const handlers = new Map<string, Function[]>();
      ext({
        registerTool() {},
        registerCommand() {},
        on(event: string, fn: Function) {
          handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        },
      } as any);

      const promptEvent: any = {
        systemPrompt: "You are Pi.",
        systemPromptOptions: { sections: {} },
      };
      await handlers.get("before_agent_start")?.[0](promptEvent, {
        hasUI: false,
        sessionManager: { getSessionId: () => "tired-sess" },
      });
      const section: string =
        promptEvent.systemPromptOptions.sections.emotion_and_fatigue;
      assert.ok(section.includes("FATIGUE: 85/100 (energy cap 2.4/10"), section);
      assert.ok(section.includes("energy 2.4/10"), section);
      assert.ok(
        section.includes("Current energy expression -> energy 0–3 (tired / worn out)"),
        section,
      );
    } finally {
      cleanup();
    }
  });

  it("19. Cross-process lockfile prevents lost updates under concurrent CLI writes and reclaims stale locks", async () => {
    const { filePath, cleanup } = createTempStateFile();
    const binPath = fileURLToPath(new URL("../bin/emotion.ts", import.meta.url));

    const runCliChild = (args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [binPath, ...args], {
          env: {
            ...process.env,
            PI_EMOTION_STATE_PATH: filePath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`CLI child failed (${code}): ${stderr}`));
        });
      });

    try {
      // Seed state file once
      const engine = new EmotionEngine({ storagePath: filePath });
      engine.getBlendedEmotion();

      // Plant a stale lockfile (mtime > 10s ago) and verify automatic reclamation
      const lockPath = `${filePath}.lock`;
      fs.writeFileSync(lockPath, "999999:dead:0", "utf8");
      const oldDate = new Date(Date.now() - 15_000);
      fs.utimesSync(lockPath, oldDate, oldDate);

      engine.recordWorkload({ fatigueDelta: 5 });
      assert.equal(engine.getFatigueStatus().value, 5);
      assert.equal(fs.existsSync(lockPath), false);

      // Launch 6 concurrent child processes: 5 adding 4 pts workload each (turns=1, toolCalls=4)
      // plus 1 setting shared context mood. All 5 increments and the context write must survive.
      await Promise.all([
        runCliChild(["workload", "1", "4", "0"]),
        runCliChild(["workload", "1", "4", "0"]),
        runCliChild(["set-context", "excited", "9", "concurrent test"]),
        runCliChild(["workload", "1", "4", "0"]),
        runCliChild(["workload", "1", "4", "0"]),
        runCliChild(["workload", "1", "4", "0"]),
      ]);

      const final = engine.getBlendedEmotion();
      // Expected: 5 (initial) + 5 * 4 = 25 (tiny sub-second idle recovery < 0.05)
      assert.ok(
        final.fatigue.value >= 24.9 && final.fatigue.value <= 25,
        `Expected ~25 fatigue without lost updates, got ${final.fatigue.value}`,
      );
      assert.ok(final.context, "Concurrent set-context must not be clobbered by workload writes");
      assert.equal(final.context.mood, "excited");
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      cleanup();
    }
  });
});
