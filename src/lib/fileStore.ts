import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const writeLocks = new Map<string, Promise<void>>();
const rootDirResolved = path.resolve(config.rootDir);

export const safeResolve = (baseDir: string, relativePath: string): string => {
  const baseResolved = path.resolve(baseDir);
  const candidateResolved = path.resolve(baseResolved, relativePath);
  const baseBoundary = `${baseResolved}${path.sep}`;

  // Resolve + boundary check prevents escaping from the configured base directory.
  if (candidateResolved !== baseResolved && !candidateResolved.startsWith(baseBoundary)) {
    throw new Error("Unsicherer Pfad außerhalb des Basisverzeichnisses.");
  }

  return candidateResolved;
};

const resolveInsideRoot = (targetPath: string): string => {
  const absoluteTarget = path.resolve(targetPath);
  const relativeToRoot = path.relative(rootDirResolved, absoluteTarget);
  return safeResolve(rootDirResolved, relativeToRoot || ".");
};

const withWriteLock = async <T>(filePath: string, task: () => Promise<T>): Promise<T> => {
  const current = writeLocks.get(filePath) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = current.then(() => next);
  writeLocks.set(filePath, queued);
  await current;

  try {
    return await task();
  } finally {
    release();
    if (writeLocks.get(filePath) === queued) {
      writeLocks.delete(filePath);
    }
  }
};

export const ensureDir = async (dirPath: string): Promise<void> => {
  const safeDirPath = resolveInsideRoot(dirPath);
  await fs.mkdir(safeDirPath, { recursive: true });
};

export const ensureFile = async (filePath: string, defaultContent: string): Promise<void> => {
  const safeFilePath = resolveInsideRoot(filePath);
  try {
    await fs.access(safeFilePath);
  } catch {
    await ensureDir(path.dirname(safeFilePath));
    await fs.writeFile(safeFilePath, defaultContent, "utf8");
  }
};

export const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  const safeFilePath = resolveInsideRoot(filePath);
  try {
    const content = await fs.readFile(safeFilePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
};

export const writeJsonFile = async <T>(filePath: string, data: T): Promise<void> => {
  const safeFilePath = resolveInsideRoot(filePath);
  await ensureDir(path.dirname(safeFilePath));

  await withWriteLock(safeFilePath, async () => {
    const tempFile = `${safeFilePath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    await fs.writeFile(tempFile, serialized, "utf8");
    await fs.rename(tempFile, safeFilePath);
  });
};

export const writeTextFile = async (filePath: string, content: string): Promise<void> => {
  const safeFilePath = resolveInsideRoot(filePath);
  await ensureDir(path.dirname(safeFilePath));

  await withWriteLock(safeFilePath, async () => {
    const tempFile = `${safeFilePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempFile, content, "utf8");
    await fs.rename(tempFile, safeFilePath);
  });
};

export const appendTextFile = async (filePath: string, content: string): Promise<void> => {
  const safeFilePath = resolveInsideRoot(filePath);
  await ensureDir(path.dirname(safeFilePath));
  await withWriteLock(safeFilePath, async () => {
    await fs.appendFile(safeFilePath, content, "utf8");
  });
};

export const listFiles = async (dirPath: string): Promise<string[]> => {
  const safeDirPath = resolveInsideRoot(dirPath);
  try {
    const entries = await fs.readdir(safeDirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(safeDirPath, entry.name));
  } catch {
    return [];
  }
};

export const readTextFile = async (filePath: string): Promise<string | null> => {
  const safeFilePath = resolveInsideRoot(filePath);
  try {
    return await fs.readFile(safeFilePath, "utf8");
  } catch {
    return null;
  }
};

export const removeFile = async (filePath: string): Promise<void> => {
  const safeFilePath = resolveInsideRoot(filePath);
  try {
    await fs.unlink(safeFilePath);
  } catch {
    // noop
  }
};
