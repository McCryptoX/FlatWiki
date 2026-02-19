import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

export interface PageWatchEntry {
  id: string;
  slug: string;
  userId: string;
  createdAt: string;
}

interface WatchDocument {
  watches?: unknown;
}

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

const ensureStoreFile = async (): Promise<void> => {
  await ensureFile(config.watchFile, '{"watches":[]}\n');
};

const normalizeSlug = (value: string): string => value.trim().toLowerCase();

const normalizeWatch = (value: unknown): PageWatchEntry | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const id = String(raw.id ?? "").trim();
  const slug = normalizeSlug(String(raw.slug ?? ""));
  const userId = String(raw.userId ?? "").trim();
  const createdAt = String(raw.createdAt ?? "").trim();
  if (!id || !slug || !userId) return null;

  const parsedCreatedAt = Date.parse(createdAt);

  return {
    id,
    slug,
    userId,
    createdAt: Number.isFinite(parsedCreatedAt) ? new Date(parsedCreatedAt).toISOString() : new Date().toISOString()
  };
};

const loadWatches = async (): Promise<PageWatchEntry[]> => {
  await ensureStoreFile();
  const raw = await readJsonFile<WatchDocument>(config.watchFile, { watches: [] });
  const watches = Array.isArray(raw.watches) ? raw.watches.map((entry) => normalizeWatch(entry)).filter((entry): entry is PageWatchEntry => entry !== null) : [];
  return watches;
};

const saveWatches = async (watches: PageWatchEntry[]): Promise<void> => {
  await writeJsonFile(config.watchFile, { watches });
};

export const listWatchedSlugsByUser = async (userIdInput: string): Promise<string[]> => {
  const userId = String(userIdInput ?? "").trim();
  if (!userId) return [];

  const watches = await loadWatches();
  const slugSet = new Set<string>();
  const output: string[] = [];

  for (const entry of watches) {
    if (entry.userId !== userId || slugSet.has(entry.slug)) continue;
    slugSet.add(entry.slug);
    output.push(entry.slug);
  }

  return output;
};

export const listWatchersForPage = async (slugInput: string): Promise<string[]> => {
  const slug = normalizeSlug(slugInput);
  if (!slug) return [];

  const watches = await loadWatches();
  const userSet = new Set<string>();
  const output: string[] = [];

  for (const entry of watches) {
    if (entry.slug !== slug || userSet.has(entry.userId)) continue;
    userSet.add(entry.userId);
    output.push(entry.userId);
  }

  return output;
};

export const isUserWatchingPage = async (input: { userId: string; slug: string }): Promise<boolean> => {
  const userId = String(input.userId ?? "").trim();
  const slug = normalizeSlug(input.slug);
  if (!userId || !slug) return false;

  const watches = await loadWatches();
  return watches.some((entry) => entry.userId === userId && entry.slug === slug);
};

export const watchPage = async (input: { userId: string; slug: string }): Promise<{ ok: boolean; changed: boolean; error?: string }> => {
  return withMutationLock(async () => {
    const userId = String(input.userId ?? "").trim();
    const slug = normalizeSlug(input.slug);
    if (!userId || !slug) {
      return { ok: false, changed: false, error: "Ungültige Watch-Anfrage." };
    }

    const watches = await loadWatches();
    if (watches.some((entry) => entry.userId === userId && entry.slug === slug)) {
      return { ok: true, changed: false };
    }

    watches.push({
      id: randomUUID(),
      userId,
      slug,
      createdAt: new Date().toISOString()
    });

    await saveWatches(watches);
    return { ok: true, changed: true };
  });
};

export const unwatchPage = async (input: { userId: string; slug: string }): Promise<{ ok: boolean; changed: boolean; error?: string }> => {
  return withMutationLock(async () => {
    const userId = String(input.userId ?? "").trim();
    const slug = normalizeSlug(input.slug);
    if (!userId || !slug) {
      return { ok: false, changed: false, error: "Ungültige Watch-Anfrage." };
    }

    const watches = await loadWatches();
    const next = watches.filter((entry) => !(entry.userId === userId && entry.slug === slug));
    const changed = next.length !== watches.length;

    if (changed) {
      await saveWatches(next);
    }

    return { ok: true, changed };
  });
};

export const deleteWatchesForPage = async (slugInput: string): Promise<number> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(slugInput);
    if (!slug) return 0;

    const watches = await loadWatches();
    const remaining = watches.filter((entry) => entry.slug !== slug);
    const removed = watches.length - remaining.length;

    if (removed > 0) {
      await saveWatches(remaining);
    }

    return removed;
  });
};
