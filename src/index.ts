#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createBridge } from "./bridge.js";
import { sanitizedError } from "./redact.js";

async function main() {
  const config = loadConfig();
  console.log("[GROK-TG] Config loaded. STATE_DIR=", config.stateDir, "GROK_CWD=", config.grokCwdAbs, "ALWAYS_APPROVE=", config.GROK_ALWAYS_APPROVE);

  const bridge = createBridge(config);

  let shutdownPromise: Promise<void> | null = null;
  let requestedExitCode = 0;
  const shutdown = (reason: string, exitCode: number): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log(`[GROK-TG] shutdown (${reason})`);
      try {
        await bridge.shutdown();
      } catch (error: unknown) {
        requestedExitCode = 1;
        console.error(`shutdown error: ${sanitizedError(error)}`);
      } finally {
        process.exitCode = requestedExitCode;
      }
    })();
    return shutdownPromise;
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      void shutdown(sig, 0);
    });
  }
  process.on("uncaughtException", (e) => {
    console.error(`uncaught: ${sanitizedError(e)}`);
    void shutdown("uncaught", 1);
  });
  process.on("unhandledRejection", (e) => {
    console.error(`unhandledRejection: ${sanitizedError(e)}`);
    void shutdown("unhandled", 1);
  });

  await bridge.start();
}

main().catch((err) => {
  console.error(`fatal: ${sanitizedError(err)}`);
  process.exit(1);
});
