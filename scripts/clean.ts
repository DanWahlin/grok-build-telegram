import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";
import {
  assertRuntimePathsOutsideBuildOutput,
  getBuildOutputDir,
} from "../src/path-safety.js";

dotenv.config({ quiet: true });

const buildOutputDir = getBuildOutputDir(import.meta.url);
const stateDir = resolve(process.env["STATE_DIR"] ?? ".grok-telegram-state");
const grokCwd = resolve(process.env["GROK_CWD"] ?? process.cwd());

assertRuntimePathsOutsideBuildOutput(stateDir, grokCwd, buildOutputDir);
await rm(buildOutputDir, { recursive: true, force: true });
console.log(`Removed build output: ${buildOutputDir}`);
