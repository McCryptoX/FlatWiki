import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";

const rootDir = process.cwd();
const configEnvPath = path.join(rootDir, "config.env");

const generateHex = (bytes: number): string => randomBytes(bytes).toString("hex");

interface InstallerResult {
  created: boolean;
}

const appendMissingEnvKeys = (filePath: string): InstallerResult => {
  const result: InstallerResult = { created: false };
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "# FlatWiki Erstkonfiguration\n", "utf8");
    result.created = true;
  }

  const original = fs.readFileSync(filePath, "utf8");
  const hasKey = (key: string): boolean => new RegExp(`^\\s*${key}=`, "m").test(original);

  const defaults: Record<string, string> = {
    PORT: "3000",
    HOST: "0.0.0.0",
    COOKIE_SECRET: generateHex(32),
    PASSWORD_PEPPER: generateHex(24),
    SESSION_TTL_HOURS: "12",
    WIKI_TITLE: "FlatWiki",
    BOOTSTRAP_ADMIN_USERNAME: "admin"
  };

  const missingLines = Object.entries(defaults)
    .filter(([key]) => !hasKey(key))
    .map(([key, value]) => `${key}=${value}`);

  if (missingLines.length > 0) {
    const needsNewline = original.length > 0 && !original.endsWith("\n");
    const prefix = needsNewline ? "\n" : "";
    fs.appendFileSync(filePath, `${prefix}${missingLines.join("\n")}\n`, "utf8");
  }

  return result;
};

const hasExternalConfig = [
  "COOKIE_SECRET",
  "PASSWORD_PEPPER",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "BOOTSTRAP_ADMIN_USERNAME",
  "HOST",
  "PORT",
  "SESSION_TTL_HOURS",
  "WIKI_TITLE"
].some((key) => Boolean(process.env[key]));

const installerResult = fs.existsSync(configEnvPath) || !hasExternalConfig
  ? appendMissingEnvKeys(configEnvPath)
  : { created: false };

dotenv.config({
  path: configEnvPath
});

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  rootDir,
  port: parsePositiveInt(process.env.PORT, 3000),
  host: process.env.HOST ?? "0.0.0.0",
  cookieSecret: process.env.COOKIE_SECRET ?? "dev-only-change-cookie-secret-please",
  isProduction: process.env.NODE_ENV === "production",
  sessionTtlHours: parsePositiveInt(process.env.SESSION_TTL_HOURS, 12),
  wikiTitle: process.env.WIKI_TITLE ?? "FlatWiki",
  bootstrapAdminUsername: process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin",
  dataDir: path.join(rootDir, "data"),
  wikiDir: path.join(rootDir, "data", "wiki"),
  uploadDir: path.join(rootDir, "data", "uploads"),
  usersFile: path.join(rootDir, "data", "users.json"),
  sessionsFile: path.join(rootDir, "data", "sessions.json"),
  auditFile: path.join(rootDir, "data", "audit.log")
};

if (installerResult.created) {
  console.warn("[INSTALLER] config.env wurde automatisch erstellt.");
}

if (config.cookieSecret === "dev-only-change-cookie-secret-please") {
  console.warn("[WARN] COOKIE_SECRET nicht gesetzt. Bitte in Produktion zwingend setzen.");
}
