import type { NextConfig } from "next";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const ROOT_DIR = process.cwd();
const KNOWN_CODEX_TRACE_PACKAGES = [
  "@openai/codex",
  "@openai/codex-darwin-arm64",
  "@openai/codex-darwin-x64",
  "@openai/codex-linux-arm64",
  "@openai/codex-linux-x64",
  "@openai/codex-win32-arm64",
  "@openai/codex-win32-x64",
];
const KNOWN_CODEX_EXTERNAL_PACKAGES = [
  "@openai/codex-sdk",
];

function isInstalledPackage(packageName: string): boolean {
  const packageJsonPath = path.join(ROOT_DIR, "node_modules", ...packageName.split("/"), "package.json");
  return fs.existsSync(packageJsonPath);
}

const installedCodexTracePackages = KNOWN_CODEX_TRACE_PACKAGES.filter(isInstalledPackage);
const installedCodexExternalPackages = KNOWN_CODEX_EXTERNAL_PACKAGES.filter(isInstalledPackage);
const codexTracingGlobs = installedCodexTracePackages.map(
  (packageName) => `./node_modules/${packageName}/**/*`,
);

const nextConfig: NextConfig = {
  allowedDevOrigins: ['code.lspon.com'],
  output: 'standalone',
  serverExternalPackages: [
    'better-sqlite3',
    'discord.js',
    '@discordjs/ws',
    'node-pty',
    'zlib-sync',
    ...installedCodexExternalPackages,
  ],
  outputFileTracingIncludes: codexTracingGlobs.length > 0 ? {
    '/*': codexTracingGlobs,
  } : undefined,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
