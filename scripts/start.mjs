#!/usr/bin/env node
/**
 * Production launcher.
 *
 * Next's standalone `server.js` chdir()s into its own directory, so a relative
 * MUSICSEER_DB_PATH would resolve inside `.next/` and be wiped by the next
 * build. Pin an absolute default next to the project (or the app root in a
 * container) unless one was supplied explicitly.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, ".next", "standalone", "server.js");

process.env.MUSICSEER_DB_PATH ??= path.join(root, "data", "musicseer.db");

// A bare absolute path is not a valid ESM specifier on Windows.
await import(pathToFileURL(server).href);
