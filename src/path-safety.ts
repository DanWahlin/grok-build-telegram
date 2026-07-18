import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function canonicalizePotentialPath(input: string): string {
  const unresolved: string[] = [];
  let cursor = resolve(input);

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    unresolved.unshift(basename(cursor));
    cursor = parent;
  }

  const canonicalBase = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return resolve(canonicalBase, ...unresolved);
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const parentAbs = canonicalizePotentialPath(parent);
  const candidateAbs = canonicalizePotentialPath(candidate);
  const rel = relative(parentAbs, candidateAbs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function getBuildOutputDir(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const parent = dirname(moduleDir);
  const packageRoot = basename(parent) === "dist" ? dirname(parent) : parent;
  return resolve(packageRoot, "dist");
}

export function assertRuntimePathsOutsideBuildOutput(
  stateDir: string,
  grokCwd: string,
  buildOutputDir: string,
): void {
  const conflicts = [
    ["STATE_DIR", stateDir],
    ["GROK_CWD", grokCwd],
  ] as const;

  for (const [label, candidate] of conflicts) {
    if (isPathWithin(buildOutputDir, candidate)) {
      throw new Error(`${label} must not be inside build output: ${buildOutputDir}`);
    }
  }
}
