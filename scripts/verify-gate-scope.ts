#!/usr/bin/env bun
// verify-gate-scope: a gate must show how much it checked (AGENTS.md "Always test new or modified code").
// Two silent-shrink failures this catches, both of which would leave the gate green while checking less:
//   1. a tracked .ts file that lands in neither tsconfig project is never typechecked (or linted with types);
//   2. a source file under src/ missing from the coverage summary is never held to the 90% bar.
// Fix a failure by fixing the include globs, never by excusing the file.
// Runs after `vitest run --coverage`, which writes coverage/coverage-summary.json.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
};

const tracked = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts"]).filter(
  (f) => !f.startsWith("node_modules/"),
);
if (!tracked.length) throw new Error("verify-gate-scope: found no .ts files at all; the check itself is broken");

// 1. typecheck scope. Read each project's file list through the TypeScript API in-process (no subprocess, so
// the result cannot depend on how a launcher behaves in a given shell or sandbox), and treat an empty list as a
// broken check rather than as "nothing typechecked".
const typed = new Set<string>();
for (const project of ["tsconfig.json", "tsconfig.tools.json"]) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    resolve(root, project),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(`verify-gate-scope: ${project}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      },
    },
  );
  if (!parsed || parsed.errors.length)
    throw new Error(`verify-gate-scope: could not parse ${project}; the check itself is broken`);
  if (!parsed.fileNames.length)
    throw new Error(`verify-gate-scope: ${project} lists no files; the check itself is broken`);
  for (const f of parsed.fileNames) typed.add(relative(root, f));
}
const untyped = tracked.filter((f) => !typed.has(f));

// 2. coverage scope
const summaryPath = resolve(root, "coverage/coverage-summary.json");
if (!existsSync(summaryPath))
  throw new Error("verify-gate-scope: no coverage summary; run vitest with --coverage first");
const measured = new Set(
  Object.keys(JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>)
    .filter((k) => k !== "total")
    .map((k) => relative(root, k)),
);
const sources = tracked.filter((f) => f.startsWith("src/") && !f.endsWith(".d.ts"));
const unmeasured = sources.filter((f) => !measured.has(f));

console.log(`gate scope: typechecked ${tracked.length - untyped.length} of ${tracked.length} .ts files`);
console.log(`gate scope: coverage measured ${sources.length - unmeasured.length} of ${sources.length} src files`);
if (untyped.length || unmeasured.length) {
  for (const f of untyped) console.error(`  not in any tsconfig project: ${f}`);
  for (const f of unmeasured) console.error(`  missing from coverage: ${f}`);
  process.exit(1);
}
