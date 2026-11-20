#!/usr/bin/env node
import { EmotionEngine } from "../src/engine.ts";
import { executeCliCommand } from "../src/tools.ts";

function main(): void {
  const argv = process.argv.slice(2);
  const engine = new EmotionEngine();

  try {
    const output = executeCliCommand(engine, argv);
    process.stdout.write(`${output}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

main();
