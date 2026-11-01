#!/usr/bin/env node
// Global entry point: after `npm link`, this lets you run `infra-coder <path> ["task"]`
// from anywhere on the machine, instead of cd-ing into infra-coder each time.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const entry = path.join(projectRoot, "src", "index.ts");
const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");

const child = spawn(tsx, [entry, ...process.argv.slice(2)], {
  // Inherit the caller's cwd (not projectRoot) so relative target paths resolve
  // against where `infra-coder` was actually invoked from.
  cwd: process.cwd(),
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
