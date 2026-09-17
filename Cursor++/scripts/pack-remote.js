#!/usr/bin/env node
/**
 * Package the headless remote companion (`cursor2plus-remote`).
 *
 * The companion is the same bundle as the control extension under a second
 * identity: `extensionKind: ["workspace"]` so VS Code places it on the Remote
 * SSH host, and no `contributes` block so its commands, view and settings
 * cannot collide with the control extension running locally in the very same
 * window. Everything else is derived from the main manifest, so the two
 * identities can never drift in version or runtime dependencies.
 *
 * Run after `pnpm run package` — this script only stages and zips.
 */
const { execSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const stage = join(root, ".remote-package");
const manifest = require(join(root, "package.json"));

if (!existsSync(join(root, "dist", "extension-remote.js"))) {
  throw new Error("dist/extension-remote.js is missing — run `pnpm run package` first");
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const remoteManifest = {
  publisher: manifest.publisher,
  name: `${manifest.name}-remote`,
  displayName: `${manifest.displayName} (Remote Host)`,
  version: manifest.version,
  icon: manifest.icon,
  description:
    "Headless Cursor++ BYOK server for a Remote SSH / WSL / container host. Install next to Cursor++ on the remote side; the local Cursor++ keeps the UI.",
  main: "./dist/extension-remote.js",
  extensionKind: ["workspace"],
  engines: manifest.engines,
  activationEvents: manifest.activationEvents,
  contributes: {},
  dependencies: manifest.dependencies,
  license: manifest.license,
};

writeFileSync(join(stage, "package.json"), `${JSON.stringify(remoteManifest, null, 2)}\n`);
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(root, "resources"), join(stage, "resources"), { recursive: true });

execSync(
  "pnpm exec vsce package --no-dependencies --allow-missing-repository --skip-license --allow-star-activation",
  { cwd: stage, stdio: "inherit" },
);

for (const file of readdirSync(stage).filter((f) => f.endsWith(".vsix"))) {
  cpSync(join(stage, file), join(root, file));
  console.log(`[build] remote companion packaged: ${file}`);
}
rmSync(stage, { recursive: true, force: true });
