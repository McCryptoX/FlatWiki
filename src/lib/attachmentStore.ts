import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { ensureDir, ensureFile, readJsonFile, removeFile, safeResolve, writeJsonFile } from "./fileStore.js";

export type AttachmentScanStatus = "clean" | "skipped" | "failed";

export interface PageAttachment {
  id: string;
  slug: string;
  storageName: string;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedById: string;
  uploadedByUsername: string;
  uploadedByDisplayName: string;
  scanStatus: AttachmentScanStatus;
  scanner: string;
}

interface AttachmentDocument {
  attachments?: unknown;
}

interface AntivirusScanResult {
  ok: boolean;
  clean: boolean;
  skipped: boolean;
  reason: string;
}

export interface FinalizeAttachmentInput {
  slug: string;
  quarantinePath: string;
  originalName: string;
  mimeType: string;
  uploadedById: string;
  uploadedByUsername: string;
  uploadedByDisplayName: string;
}

export interface FinalizeAttachmentResult {
  ok: boolean;
  attachment?: PageAttachment;
  error?: string;
}

const FILE_NAME_SANITIZE_PATTERN = /[^a-zA-Z0-9._-]/g;
const NULL_BYTE_PATTERN = /\x00/;

const ALLOWED_EXTENSION_TO_MIME = new Map<string, Set<string>>([
  ["pdf", new Set(["application/pdf", "application/x-pdf", "application/octet-stream"])],
  ["txt", new Set(["text/plain", "application/octet-stream"])],
  ["md", new Set(["text/markdown", "text/plain", "application/octet-stream"])],
  ["csv", new Set(["text/csv", "application/csv", "text/plain", "application/octet-stream"])],
  [
    "docx",
    new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
      "application/octet-stream"
    ])
  ],
  [
    "xlsx",
    new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
      "application/octet-stream"
    ])
  ],
  [
    "pptx",
    new Set([
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
      "application/octet-stream"
    ])
  ]
]);

let mutationQueue: Promise<void> = Promise.resolve();

const withMutationLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const waitFor = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await waitFor;
  try {
    return await task();
  } finally {
    release();
  }
};

const normalizeSlug = (value: string): string => value.trim().toLowerCase();

const normalizeExtension = (fileName: string): string => path.extname(fileName).replace(/^\./, "").trim().toLowerCase();

const normalizeAttachment = (value: unknown): PageAttachment | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const id = String(raw.id ?? "").trim();
  const slug = normalizeSlug(String(raw.slug ?? ""));
  const storageName = String(raw.storageName ?? "").trim();
  const originalName = String(raw.originalName ?? "").trim();
  const mimeType = String(raw.mimeType ?? "").trim();
  const extension = String(raw.extension ?? "").trim().toLowerCase();
  const sizeBytes = Number(raw.sizeBytes ?? 0);
  const sha256 = String(raw.sha256 ?? "").trim().toLowerCase();
  const uploadedAt = String(raw.uploadedAt ?? "").trim();
  const uploadedById = String(raw.uploadedById ?? "").trim();
  const uploadedByUsername = String(raw.uploadedByUsername ?? "").trim().toLowerCase();
  const uploadedByDisplayName = String(raw.uploadedByDisplayName ?? "").trim();
  const scanStatusRaw = String(raw.scanStatus ?? "clean").trim().toLowerCase();
  const scanStatus: AttachmentScanStatus = scanStatusRaw === "failed" ? "failed" : scanStatusRaw === "skipped" ? "skipped" : "clean";
  const scanner = String(raw.scanner ?? "").trim();

  if (!id || !slug || !storageName || !originalName || !mimeType || !extension || !uploadedById || !uploadedByUsername) {
    return null;
  }

  const parsedUploadedAt = Date.parse(uploadedAt);

  return {
    id,
    slug,
    storageName,
    originalName,
    mimeType,
    extension,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : 0,
    sha256,
    uploadedAt: Number.isFinite(parsedUploadedAt) ? new Date(parsedUploadedAt).toISOString() : new Date().toISOString(),
    uploadedById,
    uploadedByUsername,
    uploadedByDisplayName: uploadedByDisplayName || uploadedByUsername,
    scanStatus,
    scanner
  };
};

const ensureStoreFile = async (): Promise<void> => {
  await ensureFile(config.attachmentsFile, '{"attachments":[]}\n');
  await ensureDir(config.attachmentsRootDir);
  await ensureDir(config.attachmentsFileDir);
  await ensureDir(config.attachmentsQuarantineDir);
};

const loadAttachments = async (): Promise<PageAttachment[]> => {
  await ensureStoreFile();
  const raw = await readJsonFile<AttachmentDocument>(config.attachmentsFile, { attachments: [] });
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map((entry) => normalizeAttachment(entry)).filter((entry): entry is PageAttachment => entry !== null)
    : [];

  return attachments;
};

const saveAttachments = async (attachments: PageAttachment[]): Promise<void> => {
  await writeJsonFile(config.attachmentsFile, { attachments });
};

const sanitizeOriginalFileName = (name: string): string => {
  const base = path.basename(String(name ?? "").trim());
  const cleaned = base.replace(FILE_NAME_SANITIZE_PATTERN, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 180) || "datei";
};

const sniffMagic = async (filePath: string): Promise<Buffer> => {
  const handle = await fs.open(filePath, "r");
  try {
    const chunk = Buffer.alloc(16);
    const read = await handle.read(chunk, 0, chunk.length, 0);
    return chunk.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
};

const looksLikePdf = (chunk: Buffer): boolean => chunk.length >= 5 && chunk.subarray(0, 5).equals(Buffer.from("%PDF-"));

const looksLikeZip = (chunk: Buffer): boolean => {
  if (chunk.length < 4) return false;
  return (
    chunk.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    chunk.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    chunk.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
  );
};

const looksLikeText = async (filePath: string): Promise<boolean> => {
  const handle = await fs.open(filePath, "r");
  try {
    const chunk = Buffer.alloc(4096);
    const read = await handle.read(chunk, 0, chunk.length, 0);
    const sample = chunk.subarray(0, read.bytesRead);

    for (const byte of sample) {
      if (byte === 0x00) return false;
    }

    const maybeString = sample.toString("utf8");
    return !NULL_BYTE_PATTERN.test(maybeString);
  } finally {
    await handle.close();
  }
};

const validateMimeAndMagic = async (filePath: string, extension: string, mimeType: string): Promise<{ ok: boolean; error?: string }> => {
  const allowedMimes = ALLOWED_EXTENSION_TO_MIME.get(extension);
  if (!allowedMimes) {
    return { ok: false, error: "Dateityp nicht erlaubt." };
  }

  const normalizedMime = (mimeType || "application/octet-stream").trim().toLowerCase();
  if (!allowedMimes.has(normalizedMime)) {
    return { ok: false, error: `MIME-Typ nicht erlaubt (${normalizedMime || "unbekannt"}).` };
  }

  const magic = await sniffMagic(filePath);

  if (extension === "pdf" && !looksLikePdf(magic)) {
    return { ok: false, error: "Datei ist kein valides PDF." };
  }

  if (["docx", "xlsx", "pptx"].includes(extension) && !looksLikeZip(magic)) {
    return { ok: false, error: "Office-Datei hat keine valide ZIP-Signatur." };
  }

  if (["txt", "md", "csv"].includes(extension)) {
    const textLike = await looksLikeText(filePath);
    if (!textLike) {
      return { ok: false, error: "Textdatei enthält unerlaubte Binärdaten." };
    }
  }

  return { ok: true };
};

const commandExists = async (commandName: string): Promise<boolean> => {
  const normalized = commandName.trim();
  if (!normalized) return false;
  if (/[\r\n\t]/.test(normalized)) return false;

  const isPath = normalized.includes("/") || normalized.startsWith(".");
  const candidates = isPath
    ? [path.resolve(normalized)]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((segment) => path.join(segment, normalized));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // continue
    }
  }

  return false;
};

const runClamAvScan = async (filePath: string): Promise<AntivirusScanResult> => {
  const mode = config.attachmentScanMode;
  if (mode === "off") {
    return { ok: true, clean: true, skipped: true, reason: "scan_off" };
  }

  const scanner = config.attachmentScannerCommand;
  const hasScanner = await commandExists(scanner);
  if (!hasScanner) {
    if (mode === "required") {
      return { ok: false, clean: false, skipped: false, reason: `${scanner}_not_found` };
    }
    return { ok: true, clean: true, skipped: true, reason: `${scanner}_not_found` };
  }

  return new Promise<AntivirusScanResult>((resolve) => {
    const proc = spawn(scanner, ["--no-summary", "--infected", filePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    proc.on("error", (error) => {
      if (mode === "required") {
        resolve({ ok: false, clean: false, skipped: false, reason: error.message || "scan_error" });
        return;
      }
      resolve({ ok: true, clean: true, skipped: true, reason: error.message || "scan_error" });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, clean: true, skipped: false, reason: "clean" });
        return;
      }

      if (code === 1) {
        resolve({ ok: true, clean: false, skipped: false, reason: "infected" });
        return;
      }

      if (mode === "required") {
        resolve({ ok: false, clean: false, skipped: false, reason: stderr.trim() || "scan_failed" });
        return;
      }

      resolve({ ok: true, clean: true, skipped: true, reason: stderr.trim() || "scan_failed" });
    });
  });
};

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  return new Promise<string>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
};

const buildAttachmentStorageName = (extension: string): string => `${Date.now()}-${randomUUID().replaceAll("-", "")}.${extension}`;

const resolveAttachmentPath = (storageName: string): string => {
  const normalizedStorageName = path.basename(String(storageName ?? "").trim());
  if (!normalizedStorageName || normalizedStorageName !== String(storageName ?? "").trim()) {
    throw new Error("Ungültiger Attachment-Pfad.");
  }
  return safeResolve(config.attachmentsFileDir, normalizedStorageName);
};

const resolveQuarantinePath = (inputPath: string): string => {
  const normalizedName = path.basename(String(inputPath ?? "").trim());
  if (!normalizedName) {
    throw new Error("Ungültiger Quarantäne-Pfad.");
  }
  // Quarantine input must stay within the configured quarantine directory.
  return safeResolve(config.attachmentsQuarantineDir, normalizedName);
};

export const listAttachmentsBySlug = async (slugInput: string): Promise<PageAttachment[]> => {
  const slug = normalizeSlug(slugInput);
  if (!slug) return [];

  const entries = await loadAttachments();
  return entries
    .filter((entry) => entry.slug === slug)
    .sort((a, b) => Date.parse(a.uploadedAt) - Date.parse(b.uploadedAt));
};

export const getAttachmentById = async (idInput: string): Promise<PageAttachment | null> => {
  const id = String(idInput ?? "").trim();
  if (!id) return null;

  const entries = await loadAttachments();
  return entries.find((entry) => entry.id === id) ?? null;
};

export const finalizeAttachmentFromQuarantine = async (input: FinalizeAttachmentInput): Promise<FinalizeAttachmentResult> => {
  return withMutationLock(async () => {
    let quarantinePath = "";
    try {
      quarantinePath = resolveQuarantinePath(input.quarantinePath);
    } catch {
      return { ok: false, error: "Ungültiger Upload-Kontext." };
    }

    const slug = normalizeSlug(input.slug);
    const originalName = sanitizeOriginalFileName(input.originalName);
    const mimeType = String(input.mimeType ?? "application/octet-stream").trim().toLowerCase();
    const uploadedById = String(input.uploadedById ?? "").trim();
    const uploadedByUsername = String(input.uploadedByUsername ?? "").trim().toLowerCase();
    const uploadedByDisplayName = String(input.uploadedByDisplayName ?? "").trim() || uploadedByUsername;

    if (!slug || !uploadedById || !uploadedByUsername) {
      await removeFile(quarantinePath);
      return { ok: false, error: "Ungültiger Upload-Kontext." };
    }

    await ensureStoreFile();

    const extension = normalizeExtension(originalName);
    if (!extension || !ALLOWED_EXTENSION_TO_MIME.has(extension)) {
      await removeFile(quarantinePath);
      return { ok: false, error: "Dateityp nicht erlaubt." };
    }

    const stat = await fs.stat(quarantinePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size < 1) {
      await removeFile(quarantinePath);
      return { ok: false, error: "Leere oder ungültige Datei." };
    }

    const mimeCheck = await validateMimeAndMagic(quarantinePath, extension, mimeType);
    if (!mimeCheck.ok) {
      await removeFile(quarantinePath);
      return { ok: false, error: mimeCheck.error ?? "Datei konnte nicht validiert werden." };
    }

    const scan = await runClamAvScan(quarantinePath);
    if (!scan.ok) {
      await removeFile(quarantinePath);
      return { ok: false, error: `Virenscan fehlgeschlagen (${scan.reason}).` };
    }

    if (!scan.clean) {
      await removeFile(quarantinePath);
      return { ok: false, error: "Virenscan hat potenziell schädliche Datei erkannt." };
    }

    const storageName = buildAttachmentStorageName(extension);
    const finalPath = resolveAttachmentPath(storageName);
    await fs.rename(quarantinePath, finalPath);

    const sha256 = await hashFileSha256(finalPath);

    const scanStatus: AttachmentScanStatus = scan.skipped ? "skipped" : "clean";

    const attachment: PageAttachment = {
      id: randomUUID(),
      slug,
      storageName,
      originalName,
      mimeType,
      extension,
      sizeBytes: stat.size,
      sha256,
      uploadedAt: new Date().toISOString(),
      uploadedById,
      uploadedByUsername,
      uploadedByDisplayName,
      scanStatus,
      scanner: scan.skipped ? "none" : config.attachmentScannerCommand
    };

    const entries = await loadAttachments();
    entries.push(attachment);
    await saveAttachments(entries);

    return { ok: true, attachment };
  });
};

export const deleteAttachmentById = async (input: {
  attachmentId: string;
  actorId: string;
  isAdmin: boolean;
}): Promise<{ ok: boolean; deleted: boolean; attachment?: PageAttachment; error?: string }> => {
  return withMutationLock(async () => {
    const attachmentId = String(input.attachmentId ?? "").trim();
    const actorId = String(input.actorId ?? "").trim();
    if (!attachmentId || !actorId) {
      return { ok: false, deleted: false, error: "Ungültige Anfrage." };
    }

    const entries = await loadAttachments();
    const index = entries.findIndex((entry) => entry.id === attachmentId);
    if (index < 0) {
      return { ok: true, deleted: false };
    }

    const target = entries[index] as PageAttachment;
    if (!input.isAdmin && target.uploadedById !== actorId) {
      return { ok: false, deleted: false, error: "Nur Uploader oder Admin darf löschen." };
    }

    entries.splice(index, 1);
    await saveAttachments(entries);
    try {
      await removeFile(resolveAttachmentPath(target.storageName));
    } catch {
      // Keep metadata deletion successful even if storageName is malformed legacy data.
    }

    return { ok: true, deleted: true, attachment: target };
  });
};

export const deleteAttachmentsForPage = async (slugInput: string): Promise<number> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(slugInput);
    if (!slug) return 0;

    const entries = await loadAttachments();
    const targets = entries.filter((entry) => entry.slug === slug);
    const remaining = entries.filter((entry) => entry.slug !== slug);

    if (targets.length < 1) return 0;

    await saveAttachments(remaining);

    for (const attachment of targets) {
      try {
        await removeFile(resolveAttachmentPath(attachment.storageName));
      } catch {
        // Ignore malformed legacy storage names during cleanup.
      }
    }

    return targets.length;
  });
};

export const getAttachmentFilePath = (attachment: Pick<PageAttachment, "storageName">): string => resolveAttachmentPath(attachment.storageName);

export const buildAttachmentDownloadName = (name: string): string => {
  const sanitized = sanitizeOriginalFileName(name).replace(/"/g, "");
  if (!sanitized) return "download.bin";
  return sanitized;
};

export const createAttachmentQuarantinePath = async (originalName: string): Promise<{ path: string; safeOriginalName: string }> => {
  await ensureStoreFile();
  const safeOriginalName = sanitizeOriginalFileName(originalName);
  const extension = normalizeExtension(safeOriginalName) || "bin";
  const fileName = `${Date.now()}-${randomUUID().replaceAll("-", "")}.${extension}`;
  return {
    path: safeResolve(config.attachmentsQuarantineDir, fileName),
    safeOriginalName
  };
};
