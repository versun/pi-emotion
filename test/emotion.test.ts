import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  BASE_DECAY_MS,
  CONTEXT_DECAY_MS,
  clampValenceByGravity,
  createEmotionExtension,
  EmotionEngine,
  executeCliCommand,
  formatEmotionStatusBadge,
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

      // Direct unit check on gravity clamping function
      assert.equal(clampValenceByGravity(10, 1, 4), 5);

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

  it("4. Sleep, Wake, Rest and Fatigue synchronously constrain and update Emotion Energy", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      // Accumulate high fatigue (80/100) -> energy cap drops to 10 - 0.8 * 9 = 2.8
      const tired = engine.setFatigue(80);
      assert.equal(tired.fatigue.value, 80);
      assert.equal(tired.fatigue.energyCap, 2.8);
      assert.equal(tired.base.energy, 2.8);
      assert.equal(tired.blended.energy, 2.8);

      // Attempting to set high Base energy (9) while fatigue is 80 is capped at 2.8
      const cappedBase = engine.setBase({
        mood: "excited",
        energy: 9,
        valence: 8,
        description: "trying to stay hyped despite exhaustion",
      });
      assert.equal(cappedBase.base.energy, 2.8);

      // Enter sleep(): status -> SLEEPING, base & blended energy drop to <= 1, mood -> "sleepy"
      const sleeping = engine.sleep();
      assert.equal(sleeping.fatigue.status, "SLEEPING");
      assert.ok(sleeping.base.energy <= 1);
      assert.ok(sleeping.blended.energy <= 1);
      assert.equal(sleeping.blended.mood, "sleepy");

      // Sleep for 2 hours, then wake(): status -> AWAKE, fatigue drops by 40 (80 -> 40), energy restores
      currentTime += 2 * 60 * 60 * 1000;
      const woken = engine.wake();
      assert.equal(woken.fatigue.status, "AWAKE");
      assert.equal(woken.fatigue.value, 40);
      assert.ok(woken.base.energy >= 5, `Expected waking energy >= 5, got ${woken.base.energy}`);
      assert.equal(woken.blended.energy, woken.base.energy);

      // Call rest(): fatigue resets to 0, status = AWAKE, energy boosts to >= 8
      const rested = engine.rest();
      assert.equal(rested.fatigue.status, "AWAKE");
      assert.equal(rested.fatigue.value, 0);
      assert.equal(rested.fatigue.energyCap, 10);
      assert.ok(rested.base.energy >= 8);
      assert.equal(rested.blended.energy, rested.base.energy);
    } finally {
      cleanup();
    }
  });

  it("5. Pre-Prompt Hook, AI Tools, and CLI commands integrate end-to-end", async () => {
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

      // Verify all 8 tools are registered
      for (const toolName of [
        "emotion_status",
        "emotion_get",
        "emotion_set_base",
        "emotion_set_context",
        "sleep",
        "wake",
        "rest",
        "fatigue_status",
      ]) {
        assert.ok(registeredTools.has(toolName), `Missing tool: ${toolName}`);
      }
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

      // Sections path: injects via systemPromptOptions.sections and returns
      // undefined (no full prompt replacement => no duplicate injection).
      assert.equal(hookResult, undefined);
      assert.ok(
        promptEvent.systemPromptOptions.sections.emotion_and_fatigue.includes(
          "[Emotion & Fatigue Context Block]",
        ),
      );
      assert.ok(
        promptEvent.systemPromptOptions.sections.emotion_and_fatigue.includes(
          "BLENDED: playful",
        ),
      );

      // Fallback path: without systemPromptOptions, the block is appended to
      // the returned systemPrompt exactly once.
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

      // Verify CLI command dispatcher works for status & get
      const getJson = JSON.parse(
        executeCliCommand(ext.engine, ["get"]),
      );
      assert.equal(getJson.blended.mood, "playful");
    } finally {
      cleanup();
    }
  });

  it("6. Sleep/wake edge cases: no free recovery, sleep timer preserved, mood stays sleepy past full decay", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      // wake() while already AWAKE grants no recovery and leaves state alone
      engine.setFatigue(60);
      const before = engine.getBlendedEmotion();
      const wakeWhileAwake = engine.wake();
      assert.equal(wakeWhileAwake.fatigue.value, 60);
      assert.equal(wakeWhileAwake.fatigue.status, "AWAKE");
      assert.equal(wakeWhileAwake.base.energy, before.base.energy);
      assert.equal(wakeWhileAwake.base.mood, before.base.mood);

      // sleep(), then sleep() again later: the sleep timer must not reset,
      // so a 3h "re-sleep" still counts the full elapsed duration on wake.
      engine.sleep();
      currentTime += 3 * 60 * 60 * 1000;
      engine.sleep(); // idempotent re-sleep
      currentTime += 60 * 1000;
      const woken = engine.wake();
      // ~3h of sleep => recovery = max(40, ~60) = ~60, not just the 40pt floor
      assert.ok(
        woken.fatigue.value <= 0.5,
        `Expected near-full recovery after ~3h sleep, got ${woken.fatigue.value}`,
      );

      // Sleeping past the full 6h base decay window still reports "sleepy",
      // not the reverted baseline mood.
      engine.sleep();
      currentTime += BASE_DECAY_MS + 1000;
      const longSleep = engine.getBlendedEmotion();
      assert.equal(longSleep.fatigue.status, "SLEEPING");
      assert.equal(longSleep.base.mood, "sleepy");
      assert.equal(longSleep.blended.mood, "sleepy");

      // A non-"sleepy" base mood set while SLEEPING must not stick as
      // "sleepy" after wake().
      engine.setBase({
        mood: "annoyed",
        energy: 5,
        valence: 3,
        description: "woken up mid-nap",
      });
      const afterWake = engine.wake();
      assert.equal(afterWake.fatigue.status, "AWAKE");
      assert.notEqual(afterWake.base.mood, "sleepy");
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
      delete process.env.PI_EMOTION_STATE_PATH; // ensure global default path logic is bypassed only for identities

      const alice = new EmotionEngine({ identity: "pi-emotion-test-alice" });
      const bob = new EmotionEngine({ identity: "pi-emotion-test-bob" });

      // Each custom identity gets a private file under emotion-state/users/
      assert.ok(alice.storage.filePath.endsWith(path.join("users", "pi-emotion-test-alice.json")));
      assert.ok(bob.storage.filePath.endsWith(path.join("users", "pi-emotion-test-bob.json")));
      assert.notEqual(alice.storage.filePath, bob.storage.filePath);

      // Alice sleeps; Bob is unaffected
      alice.sleep();
      assert.equal(alice.getFatigueStatus().status, "SLEEPING");
      assert.equal(bob.getFatigueStatus().status, "AWAKE");

      // Bob's context mood does not leak into Alice's
      bob.setContext({ mood: "annoyed", valence: 2, trigger: "noise" });
      assert.equal(alice.getBlendedEmotion().context, null);
      assert.equal(alice.identity, "pi-emotion-test-alice");
      assert.equal(bob.identity, "pi-emotion-test-bob");

      // Env-var driven identity also resolves
      process.env.PI_EMOTION_USER = "pi-emotion-test-carol";
      const carol = new EmotionEngine({});
      assert.equal(carol.identity, "pi-emotion-test-carol");
      assert.ok(carol.storage.filePath.endsWith(path.join("users", "pi-emotion-test-carol.json")));
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

  it("8. Legacy per-chatId `contexts` dict migrates to the newest entry as shared context", () => {
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
        fatigue: { status: "AWAKE", fatigue: 0, updatedAt: currentTime },
      };
      fs.writeFileSync(filePath, JSON.stringify(legacyState, null, 2), "utf8");

      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      // The newest legacy entry (chat-b) becomes the shared context
      const blended = engine.getBlendedEmotion();
      assert.ok(blended.context);
      assert.equal(blended.context.mood, "determined");
      assert.equal(blended.context.trigger, "fresh sprint kickoff");
      assert.equal(blended.blended.mood, "determined");
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
      assert.equal(blended.fatigue.status, "AWAKE");

      // The corrupted file is rewritten with valid state JSON
      const reloaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(reloaded.version, 1);
      assert.equal(reloaded.base.mood, "cheerful");
      assert.equal(reloaded.fatigue.status, "AWAKE");
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

  it("11. setFatigue() while SLEEPING preserves the sleep timer so wake() counts full duration", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        now: () => currentTime,
      });

      engine.setFatigue(80);
      engine.sleep();

      // Sleep 1h, adjust fatigue mid-sleep (must not reset the sleep timer),
      // then sleep 2 more hours => ~3h total => recovery ~60, not the 40pt floor
      currentTime += 60 * 60 * 1000;
      engine.setFatigue(80);
      currentTime += 2 * 60 * 60 * 1000;
      const woken = engine.wake();

      assert.equal(woken.fatigue.status, "AWAKE");
      assert.equal(woken.fatigue.value, 20);
    } finally {
      cleanup();
    }
  });

  it("12. setFatigue() preserves base mood, description, and 6h decay timer when lowering fatigue or while sleeping", () => {
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
      const cleared = engine.setFatigue(0);

      // Lowering fatigue must NOT reset base.updatedAt or overwrite decayed values
      assert.equal(cleared.base.updatedAt, t0);
      assert.equal(cleared.base.decayProgress, 0.5);
      assert.equal(cleared.base.mood, "hyped");
      assert.equal(cleared.base.description, "launched new release");
      assert.equal(cleared.base.energy, 6.5);
      assert.equal(cleared.base.valence, 7.5);

      // While SLEEPING with a non-"sleepy" base mood, adjusting fatigue must not clobber mood
      engine.sleep();
      engine.setBase({
        mood: "annoyed",
        energy: 5,
        valence: 3,
        description: "disturbed mid-nap",
      });
      engine.setFatigue(50);
      const status = engine.getStatus();
      assert.equal(status.base.raw.mood, "annoyed");
      assert.equal(status.base.raw.description, "disturbed mid-nap");
    } finally {
      cleanup();
    }
  });

  it("13. wake() respects low-energy baselines, rest() keeps mood/description coherent, and re-sleep preserves base decay timer", () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      let currentTime = 1_700_000_000_000;
      const engine = new EmotionEngine({
        storagePath: filePath,
        baseline: { mood: "chill", energy: 2, valence: 6, description: "low-key" },
        now: () => currentTime,
      });

      // Sleep with low valence, re-sleep 1h later: base decay timer must stay at sleep start
      engine.setBase({ mood: "down", energy: 2, valence: 2, description: "rough day" });
      const sleepStart = currentTime;
      engine.sleep();
      currentTime += 60 * 60 * 1000;
      engine.sleep(); // idempotent no-op
      assert.equal(engine.getStatus().base.raw.updatedAt, sleepStart);

      // Wake up: low-energy baseline (2) should NOT be forced up to 4
      currentTime += 60 * 60 * 1000;
      const woken = engine.wake();
      assert.equal(woken.fatigue.status, "AWAKE");
      assert.equal(woken.base.energy, 2);

      // rest() with a non-"sleepy" base mood preserves its coherent description
      engine.setBase({
        mood: "focused",
        energy: 5,
        valence: 7,
        description: "in the zone",
      });
      const rested = engine.rest();
      assert.equal(rested.base.mood, "focused");
      assert.equal(rested.base.description, "in the zone");
      assert.ok(rested.base.energy >= 8);
    } finally {
      cleanup();
    }
  });

  it("14. Exponential decay curve front-loads decay and honors exact 6h/2h boundaries", () => {
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

  it("15. setBaseline() ignores NaN and blank strings without corrupting existing baseline", () => {
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

  it("16. Storage resilience: non-object JSON roots, corrupted legacy contexts, whitespace env, dot identities", () => {
    const { filePath, cleanup } = createTempStateFile();
    const origUser = process.env.PI_EMOTION_USER;
    const origDir = process.env.PI_EMOTION_STATE_DIR;
    try {
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

      // Whitespace PI_EMOTION_USER falls through instead of short-circuiting to "default"
      process.env.PI_EMOTION_USER = "   ";
      const resolved = resolveIdentity();
      assert.ok(resolved.length > 0);
      assert.equal(resolved, resolveIdentity(undefined));

      // Dot-only custom identities do not produce dotfiles
      process.env.PI_EMOTION_STATE_DIR = path.dirname(filePath);
      const dotPath = resolveStoragePath("..");
      assert.equal(path.basename(dotPath), "default.json");
    } finally {
      if (origUser === undefined) delete process.env.PI_EMOTION_USER;
      else process.env.PI_EMOTION_USER = origUser;
      if (origDir === undefined) delete process.env.PI_EMOTION_STATE_DIR;
      else process.env.PI_EMOTION_STATE_DIR = origDir;
      cleanup();
    }
  });

  it("17. Badge formatting (no stray leading space) and session_start/before_agent_start UI status updates", async () => {
    const { filePath, cleanup } = createTempStateFile();
    try {
      const currentTime = 1_700_000_000_000;
      const ext = createEmotionExtension({
        storagePath: filePath,
        identity: "pi-emotion-test-alice",
        now: () => currentTime,
      });

      const badge = formatEmotionStatusBadge(ext.engine.getBlendedEmotion(), "alice");
      assert.ok(badge.startsWith("alice·"), `Unexpected badge prefix: ${JSON.stringify(badge)}`);

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

      assert.equal(statuses.length, 2);
      assert.equal(statuses[0][0], "pi-emotion");
      assert.ok(statuses[0][1].startsWith("pi-emotion-test-alice·"));
      assert.equal(statuses[1][1], statuses[0][1]);
    } finally {
      cleanup();
    }
  });

  it("18. tokenizeArgs preserves contractions, and tools/CLI validate numeric inputs", async () => {
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

      // Non-finite params in tools throw clearly instead of silently becoming 0
      await assert.rejects(
        () =>
          registeredTools.get("emotion_set_base").execute(
            "c1",
            { mood: "happy", energy: "oops", valence: 7, description: "test" },
            undefined,
            undefined,
            { hasUI: false },
          ),
        /finite numbers/,
      );
      await assert.rejects(
        () =>
          registeredTools.get("emotion_set_context").execute(
            "c2",
            { mood: "amused", valence: Number.NaN, trigger: "joke" },
            undefined,
            undefined,
            { hasUI: false },
          ),
        /finite number/,
      );

      // CLI validation errors & /emotion slash command UI error notification
      assert.throws(() => executeCliCommand(ext.engine, ["fatigue", "abc"]), /must be a number/);
      assert.throws(() => executeCliCommand(ext.engine, ["bogus"]), /Supported:.*fatigue/);

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
});
