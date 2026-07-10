#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createBridge } from "./bridge.js";

async function main() {
  const config = loadConfig();
  console.log("[GROK-TG] Config loaded. STATE_DIR=", config.stateDir, "GROK_CWD=", config.grokCwdAbs, "ALWAYS_APPROVE=", config.GROK_ALWAYS_APPROVE);

  const bridge = createBridge(config);

  const shutdown = async (reason: string) => {
    console.log(`[GROK-TG] shutdown (${reason})`);
    await bridge.shutdown().catch((e) => console.error("shutdown err", e));
    process.exit(0);
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => shutdown(sig));
  }
  process.on("uncaughtException", (e) => {
    console.error("uncaught", e);
    shutdown("uncaught").catch(() => process.exit(1));
  });
  process.on("unhandledRejection", (e) => {
    console.error("unhandledRejection", e);
    shutdown("unhandled").catch(() => process.exit(1));
  });

  await bridge.start();
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
