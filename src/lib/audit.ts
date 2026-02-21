import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { appendTextFile } from "./fileStore.js";

interface AuditEvent {
  at: string;
  action: string;
  actorId?: string | undefined;
  targetId?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

// Rotation-Sperre verhindert parallele Rotationen.
let rotationInProgress = false;

const buildRotatedName = (): string => {
  // z.B. audit.2026-02-21T14-30-00.log
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "").replace("Z", "");
  return `audit.${ts}.log`;
};

const maybeRotateAuditLog = async (): Promise<void> => {
  const maxBytes = config.auditLogMaxSizeMb * 1024 * 1024;
  if (maxBytes <= 0 || rotationInProgress) return;

  let stat: { size: number } | null = null;
  try {
    stat = await fs.stat(config.auditFile);
  } catch {
    return; // Datei existiert noch nicht – nichts zu tun
  }

  if (stat.size < maxBytes) return;

  rotationInProgress = true;
  try {
    const auditDir = path.dirname(config.auditFile);
    const rotatedPath = path.join(auditDir, buildRotatedName());

    // Aktuelle Datei umbenennen
    await fs.rename(config.auditFile, rotatedPath);

    // Alte rotierte Dateien bereinigen (falls MAX_AGE_DAYS > 0)
    if (config.auditLogMaxAgeDays > 0) {
      const cutoffMs = Date.now() - config.auditLogMaxAgeDays * 24 * 60 * 60 * 1000;
      let entries: string[] = [];
      try {
        entries = await fs.readdir(auditDir);
      } catch {
        // ignore
      }
      for (const entry of entries) {
        // Pattern: audit.YYYY-MM-DDTHH-mm-ss.log
        if (!/^audit\.\d{4}-\d{2}-\d{2}T[\d-]+\.log$/.test(entry)) continue;
        const fullPath = path.join(auditDir, entry);
        try {
          const entryStat = await fs.stat(fullPath);
          if (entryStat.mtimeMs < cutoffMs) {
            await fs.unlink(fullPath);
          }
        } catch {
          // ignore – Datei bereits weg oder Berechtigungsfehler
        }
      }
    }
  } finally {
    rotationInProgress = false;
  }
};

export const writeAuditLog = async (event: Omit<AuditEvent, "at">): Promise<void> => {
  await maybeRotateAuditLog();

  const row = {
    at: new Date().toISOString(),
    ...event
  };

  await appendTextFile(config.auditFile, `${JSON.stringify(row)}\n`);
};
