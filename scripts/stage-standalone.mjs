#!/usr/bin/env node
/**
 * Next's `output: "standalone"` build does not include the client assets.
 * Copy `.next/static` and `public` next to the standalone server so both
 * `npm start` and the Docker image run the exact same tree.
 */
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error("[stage] .next/standalone not found — did the build run?");
  process.exit(1);
}

async function copy(from, to, label) {
  if (!existsSync(from)) return;
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  console.log(`[stage] ${label}`);
}

await copy(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), ".next/static -> standalone");
await copy(path.join(root, "public"), path.join(standalone, "public"), "public -> standalone");
