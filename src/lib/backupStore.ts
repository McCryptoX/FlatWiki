import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { ensureDir, removeFile } from "./fileStore.js";

const BACKUP_MAGIC = "FLATWIKI_BACKUP_V1";
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;
const SAFE_BACKUP_FILE_PATTERN = /^flatwiki-backup-[0-9]{8}-[0-9]{6}\.tar\.gz\.enc$/;

type BackupPhase = "idle" | "preparing" | "packing" | "encrypting" | "writing" | "done" | "error";

export interface BackupStatus {
  running: boolean;
  phase: BackupPhase;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  percent: number;
  processedFiles: number;
  totalFiles: number;
  archiveFileName?: string;
  archiveSizeBytes?: number;
  error?: string;
}

export interface BackupFileInfo {
  fileName: string;
  sizeBytes: number;
  modifiedAt: string;
  hasChecksum: boolean;
}

const defaultStatus = (): BackupStatus => ({
  running: false,
  phase: "idle",
  message: "Bereit",
  percent: 0,
  processedFiles: 0,
  totalFiles: 0
});

let backupStatus: BackupStatus = defaultStatus();
let backupPromise: Promise<void> | null = null;

const toSafePercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const updateStatus = (patch: Partial<BackupStatus>): void => {
  backupStatus = {
    ...backupStatus,
    ...patch,
    percent: patch.percent === undefined ? backupStatus.percent : toSafePercent(patch.percent)
  };
};

const listDataFiles = async (root: string, current = root): Promise<string[]> => {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await fs.readdir(current, {
      withFileTypes: true,
      encoding: "utf8"
    })) as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (path.normalize(fullPath) === path.normalize(config.backupDir)) {
        continue;
      }
      files.push(...(await listDataFiles(root, fullPath)));
      continue;
    }

    if (!entry.isFile()) continue;
    files.push(path.relative(config.rootDir, fullPath).replace(/\\/g, "/"));
  }

  return files;
};

const runTarArchive = async (tmpArchivePath: string, totalFiles: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const tarArgs = ["-czvf", tmpArchivePath, "--exclude=data/backups", "-C", config.rootDir, "data"];
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let processed = 0;

    const handleStdoutChunk = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        processed += 1;
        const percentBase = totalFiles > 0 ? 10 + (processed / totalFiles) * 55 : 65;
        updateStatus({
          phase: "packing",
          message: totalFiles > 0 ? `Dateien werden gepackt (${Math.min(processed, totalFiles)}/${totalFiles})...` : "Dateien werden gepackt...",
          processedFiles: Math.min(processed, totalFiles),
          percent: Math.min(percentBase, 65)
        });
      }
    };

    tar.stdout.on("data", handleStdoutChunk);
    tar.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    tar.on("error", (error) => {
      reject(error);
    });

    tar.on("close", (code) => {
      if (code === 0) {
        updateStatus({
          phase: "packing",
          message: "Packen abgeschlossen.",
          processedFiles: totalFiles,
          percent: 65
        });
        resolve();
        return;
      }

      reject(new Error(stderrBuffer.trim() || `tar beendet mit Exit-Code ${code ?? -1}`));
    });
  });
};

const buildEncryptedBackup = async (input: {
  tmpArchivePath: string;
  targetFilePath: string;
  backupPassphrase: string;
}): Promise<void> => {
  const stats = await fs.stat(input.tmpArchivePath);
  const totalBytes = Math.max(stats.size, 1);

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(input.backupPassphrase, salt, 32, {
    N: KDF_N,
    r: KDF_R,
    p: KDF_P,
    maxmem: 96 * 1024 * 1024
  });

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const tmpCipherPath = `${input.targetFilePath}.cipherpart`;
  const tmpOutputPath = `${input.targetFilePath}.tmp`;
  try {
    let processedBytes = 0;
    const source = createReadStream(input.tmpArchivePath);
  source.on("data", (chunk: Buffer | string) => {
    processedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      const ratio = Math.min(processedBytes / totalBytes, 1);
      updateStatus({
        phase: "encrypting",
        message: "Backup wird verschlüsselt...",
        percent: 65 + ratio * 25
      });
    });

    await pipeline(source, cipher, createWriteStream(tmpCipherPath, { flags: "wx" }));
    const authTag = cipher.getAuthTag();

    const metadata = {
      v: 1,
      alg: "aes-256-gcm",
      kdf: {
        name: "scrypt",
        n: KDF_N,
        r: KDF_R,
        p: KDF_P
      },
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: authTag.toString("base64"),
      createdAt: new Date().toISOString(),
      source: "data"
    };

    await new Promise<void>((resolve, reject) => {
      const destination = createWriteStream(tmpOutputPath, { flags: "wx" });
      destination.on("error", reject);

      destination.write(`${BACKUP_MAGIC}\n${JSON.stringify(metadata)}\n`, "utf8", (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }

        const cipherStatsPromise = fs.stat(tmpCipherPath);
        cipherStatsPromise
          .then((cipherStats) => {
            const cipherTotal = Math.max(cipherStats.size, 1);
            let copied = 0;
            const encryptedSource = createReadStream(tmpCipherPath);
          encryptedSource.on("data", (chunk: Buffer | string) => {
            copied += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
              const ratio = Math.min(copied / cipherTotal, 1);
              updateStatus({
                phase: "writing",
                message: "Backup-Datei wird geschrieben...",
                percent: 90 + ratio * 8
              });
            });

            encryptedSource.on("error", reject);
            encryptedSource.on("end", () => {
              destination.end();
            });
            encryptedSource.pipe(destination, { end: false });
          })
          .catch(reject);
      });

      destination.on("finish", resolve);
    });

    await fs.rename(tmpOutputPath, input.targetFilePath);

    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
    const encryptedStream = createReadStream(input.targetFilePath);
    encryptedStream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
      encryptedStream.on("error", reject);
      encryptedStream.on("end", () => resolve());
    });

    const digest = hash.digest("hex");
    await fs.writeFile(`${input.targetFilePath}.sha256`, `${digest}  ${path.basename(input.targetFilePath)}\n`, "utf8");
  } finally {
    await removeFile(tmpCipherPath);
    await removeFile(tmpOutputPath);
  }
};

const runBackup = async (): Promise<void> => {
  const backupPassphrase = (process.env.BACKUP_ENCRYPTION_KEY ?? "").trim();
  if (!backupPassphrase) {
    throw new Error("BACKUP_ENCRYPTION_KEY fehlt. Backup kann nicht gestartet werden.");
  }

  if (config.contentEncryptionKey) {
    const contentKeyHex = config.contentEncryptionKey.toString("hex");
    if (backupPassphrase === contentKeyHex) {
      throw new Error("BACKUP_ENCRYPTION_KEY darf nicht identisch mit CONTENT_ENCRYPTION_KEY sein.");
    }
  }

  await ensureDir(config.backupDir);

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const outputFileName = `flatwiki-backup-${timestamp}.tar.gz.enc`;
  const outputFilePath = path.join(config.backupDir, outputFileName);
  const tmpArchivePath = path.join(config.backupDir, `.tmp-${outputFileName}.tar.gz`);

  const files = await listDataFiles(config.dataDir);
  const totalFiles = files.length;

  updateStatus({
    phase: "preparing",
    message: "Backup wird vorbereitet...",
    percent: 10,
    totalFiles,
    processedFiles: 0,
    archiveFileName: outputFileName
  });

  try {
    await runTarArchive(tmpArchivePath, totalFiles);
    await buildEncryptedBackup({
      tmpArchivePath,
      targetFilePath: outputFilePath,
      backupPassphrase
    });

    const encryptedStats = await fs.stat(outputFilePath);
    updateStatus({
      running: false,
      phase: "done",
      message: "Backup erfolgreich erstellt.",
      percent: 100,
      finishedAt: new Date().toISOString(),
      archiveFileName: outputFileName,
      archiveSizeBytes: encryptedStats.size
    });
  } finally {
    await removeFile(tmpArchivePath);
  }
};

export const getBackupStatus = (): BackupStatus => ({ ...backupStatus });

export const startBackupJob = (): { started: boolean; reason?: string; status: BackupStatus } => {
  if (backupPromise) {
    return {
      started: false,
      reason: "Ein Backup läuft bereits.",
      status: getBackupStatus()
    };
  }

  if (!(process.env.BACKUP_ENCRYPTION_KEY ?? "").trim()) {
    return {
      started: false,
      reason: "BACKUP_ENCRYPTION_KEY ist nicht gesetzt.",
      status: getBackupStatus()
    };
  }

  backupStatus = {
    ...defaultStatus(),
    running: true,
    phase: "preparing",
    message: "Backup wird gestartet...",
    startedAt: new Date().toISOString(),
    percent: 3
  };

  backupPromise = runBackup()
    .catch((error) => {
      updateStatus({
        running: false,
        phase: "error",
        message: "Backup fehlgeschlagen.",
        finishedAt: new Date().toISOString(),
        percent: 100,
        error: error instanceof Error ? error.message : "Unbekannter Fehler"
      });
    })
    .finally(() => {
      backupPromise = null;
    });

  return {
    started: true,
    status: getBackupStatus()
  };
};

export const listBackupFiles = async (): Promise<BackupFileInfo[]> => {
  await ensureDir(config.backupDir);

  let entries: string[];
  try {
    entries = await fs.readdir(config.backupDir, { encoding: "utf8" });
  } catch {
    return [];
  }

  const files = entries.filter((name) => SAFE_BACKUP_FILE_PATTERN.test(name));
  const items = await Promise.all(
    files.map(async (fileName) => {
      const fullPath = path.join(config.backupDir, fileName);
      try {
        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) return null;

        const checksumPath = `${fullPath}.sha256`;
        let hasChecksum = false;
        try {
          const checksumStats = await fs.stat(checksumPath);
          hasChecksum = checksumStats.isFile();
        } catch {
          hasChecksum = false;
        }

        return {
          fileName,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          hasChecksum
        } satisfies BackupFileInfo;
      } catch {
        return null;
      }
    })
  );

  return items
    .filter((entry): entry is BackupFileInfo => entry !== null)
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
};

export const resolveBackupFilePath = async (fileNameInput: string): Promise<string | null> => {
  const fileName = path.basename(String(fileNameInput ?? "").trim());
  if (!SAFE_BACKUP_FILE_PATTERN.test(fileName)) return null;

  const fullPath = path.join(config.backupDir, fileName);
  try {
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) return null;
    return fullPath;
  } catch {
    return null;
  }
};

export const deleteBackupFile = async (fileNameInput: string): Promise<boolean> => {
  const fullPath = await resolveBackupFilePath(fileNameInput);
  if (!fullPath) return false;

  await removeFile(fullPath);
  await removeFile(`${fullPath}.sha256`);
  return true;
};
