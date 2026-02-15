import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { WikiPage, WikiPageSummary } from "../types.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fileStore.js";
import { getPage, listPages } from "./wikiStore.js";

export interface SearchIndexPageEntry extends WikiPageSummary {
  searchableText: string;
  updatedAtMs: number;
}

interface SearchIndexFile {
  version: number;
  generatedAt: string;
  totalPages: number;
  pages: SearchIndexPageEntry[];
}

type SearchIndexBuildPhase = "idle" | "scanning" | "building" | "writing" | "done" | "error";

export interface SearchIndexBuildStatus {
  running: boolean;
  phase: SearchIndexBuildPhase;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  total: number;
  processed: number;
  percent: number;
  error?: string;
  indexFile: string;
}

export interface SearchIndexInfo {
  exists: boolean;
  indexFile: string;
  version: number;
  generatedAt?: string;
  totalPages: number;
  fileSizeBytes: number;
}

const INDEX_VERSION = 2;

const defaultStatus = (): SearchIndexBuildStatus => ({
  running: false,
  phase: "idle",
  message: "Bereit",
  total: 0,
  processed: 0,
  percent: 0,
  indexFile: path.relative(config.rootDir, config.searchIndexFile)
});

let buildStatus: SearchIndexBuildStatus = defaultStatus();
let buildPromise: Promise<void> | null = null;

const cleanTextExcerpt = (markdown: string): string =>
  markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#>*_[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const emptyIndexFile = (): SearchIndexFile => ({
  version: INDEX_VERSION,
  generatedAt: "",
  totalPages: 0,
  pages: []
});

const normalizeIndexEntry = (entry: SearchIndexPageEntry): SearchIndexPageEntry => ({
  ...entry,
  slug: String(entry.slug ?? "").trim().toLowerCase(),
  title: String(entry.title ?? "").trim(),
  categoryId: String(entry.categoryId ?? "").trim(),
  categoryName: String(entry.categoryName ?? "").trim(),
  visibility: entry.visibility === "restricted" ? "restricted" : "all",
  allowedUsers: Array.isArray(entry.allowedUsers)
    ? entry.allowedUsers.map((value) => String(value).trim().toLowerCase()).filter((value) => value.length > 0)
    : [],
  encrypted: entry.encrypted === true,
  tags: Array.isArray(entry.tags) ? entry.tags.map((value) => String(value).trim().toLowerCase()).filter(Boolean) : [],
  excerpt: String(entry.excerpt ?? "").trim(),
  updatedAt: String(entry.updatedAt ?? "").trim(),
  searchableText: String(entry.searchableText ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
  updatedAtMs: Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : toSafeTimestamp(String(entry.updatedAt ?? ""))
});

const readSearchIndexFile = async (): Promise<SearchIndexFile> => {
  const parsed = await readJsonFile<SearchIndexFile>(config.searchIndexFile, emptyIndexFile());
  const pages = Array.isArray(parsed.pages) ? parsed.pages.map((entry) => normalizeIndexEntry(entry)) : [];
  return {
    version: Number.isFinite(parsed.version) ? parsed.version : INDEX_VERSION,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    totalPages: pages.length,
    pages
  };
};

const buildEntrySignature = (
  entry: Pick<
    WikiPageSummary,
    "slug" | "title" | "categoryId" | "categoryName" | "visibility" | "allowedUsers" | "encrypted" | "tags" | "excerpt" | "updatedAt"
  >
): string => {
  const allowedUsers = [...entry.allowedUsers].map((value) => value.trim().toLowerCase()).sort().join(",");
  const tags = [...entry.tags].map((value) => value.trim().toLowerCase()).sort().join(",");
  return [
    entry.slug.trim().toLowerCase(),
    entry.title.trim(),
    entry.categoryId.trim(),
    entry.categoryName.trim(),
    entry.visibility,
    allowedUsers,
    entry.encrypted ? "1" : "0",
    tags,
    entry.excerpt.trim(),
    entry.updatedAt.trim()
  ].join("|");
};

const toSafeTimestamp = (value: string): number => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const toSearchableText = (summary: WikiPageSummary, content: string): string =>
  `${summary.title}\n${summary.tags.join(" ")}\n${summary.excerpt}\n${content}`.toLowerCase().replace(/\s+/g, " ").trim();

const buildIndexEntryFromPage = (page: WikiPage): SearchIndexPageEntry => {
  const excerpt = page.encrypted && page.encryptionState !== "ok" ? "Verschlüsselter Inhalt" : cleanTextExcerpt(page.content).slice(0, 220);
  const summary: WikiPageSummary = {
    slug: page.slug,
    title: page.title,
    categoryId: page.categoryId,
    categoryName: page.categoryName,
    visibility: page.visibility,
    allowedUsers: page.allowedUsers,
    encrypted: page.encrypted,
    tags: page.tags,
    excerpt,
    updatedAt: page.updatedAt
  };

  const content = page.encrypted && page.encryptionState !== "ok" ? "" : page.content;
  return {
    ...summary,
    searchableText: toSearchableText(summary, content),
    updatedAtMs: toSafeTimestamp(summary.updatedAt)
  };
};

const createIndexDocument = async (): Promise<SearchIndexFile> => {
  const pages = await listPages({ forceFileScan: true });

  buildStatus = {
    ...buildStatus,
    phase: "building",
    message: pages.length > 0 ? "Artikel werden indiziert..." : "Keine Artikel gefunden.",
    total: pages.length,
    processed: 0,
    percent: pages.length > 0 ? 0 : 100
  };

  const indexedPages: SearchIndexPageEntry[] = [];

  for (const pageSummary of pages) {
    const fullPage = await getPage(pageSummary.slug);
    if (fullPage) {
      indexedPages.push(buildIndexEntryFromPage(fullPage));
    } else {
      indexedPages.push({
        ...pageSummary,
        searchableText: toSearchableText(pageSummary, ""),
        updatedAtMs: toSafeTimestamp(pageSummary.updatedAt)
      });
    }

    const processed = indexedPages.length;
    const total = pages.length;
    const percent = total > 0 ? Math.round((processed / total) * 100) : 100;

    buildStatus = {
      ...buildStatus,
      processed,
      total,
      percent,
      message: total > 0 ? `${processed}/${total} Artikel indiziert` : "Keine Artikel gefunden."
    };
  }

  indexedPages.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    totalPages: indexedPages.length,
    pages: indexedPages
  };
};

const runSearchIndexRebuild = async (): Promise<void> => {
  buildStatus = {
    ...defaultStatus(),
    running: true,
    startedAt: new Date().toISOString(),
    phase: "scanning",
    message: "Artikel werden gelesen..."
  };

  try {
    const document = await createIndexDocument();

    buildStatus = {
      ...buildStatus,
      phase: "writing",
      message: "Index-Datei wird gespeichert...",
      percent: 100
    };

    await ensureDir(path.dirname(config.searchIndexFile));
    await writeJsonFile(config.searchIndexFile, document);

    buildStatus = {
      ...buildStatus,
      running: false,
      phase: "done",
      message: `Index erfolgreich erstellt (${document.totalPages} Artikel).`,
      processed: document.totalPages,
      total: document.totalPages,
      percent: 100,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    buildStatus = {
      ...buildStatus,
      running: false,
      phase: "error",
      message: "Index-Erstellung fehlgeschlagen.",
      error: error instanceof Error ? error.message : "Unbekannter Fehler",
      finishedAt: new Date().toISOString()
    };
  }
};

export const getSearchIndexBuildStatus = (): SearchIndexBuildStatus => ({ ...buildStatus });

export const startSearchIndexRebuild = (): { started: boolean; status: SearchIndexBuildStatus; reason?: string } => {
  if (buildPromise) {
    return {
      started: false,
      reason: "Ein Rebuild läuft bereits.",
      status: getSearchIndexBuildStatus()
    };
  }

  buildPromise = runSearchIndexRebuild().finally(() => {
    buildPromise = null;
  });

  return {
    started: true,
    status: getSearchIndexBuildStatus()
  };
};

export const getSearchIndexInfo = async (): Promise<SearchIndexInfo> => {
  const indexFile = path.relative(config.rootDir, config.searchIndexFile);
  let fileSizeBytes = 0;

  try {
    const stats = await fs.stat(config.searchIndexFile);
    fileSizeBytes = stats.size;
  } catch {
    return {
      exists: false,
      indexFile,
      version: INDEX_VERSION,
      totalPages: 0,
      fileSizeBytes: 0
    };
  }

  const fallback: SearchIndexFile = {
    version: INDEX_VERSION,
    generatedAt: "",
    totalPages: 0,
    pages: []
  };
  const parsed = await readJsonFile<SearchIndexFile>(config.searchIndexFile, fallback);
  const generatedAt =
    typeof parsed.generatedAt === "string" && parsed.generatedAt.trim().length > 0 ? parsed.generatedAt : null;

  return {
    exists: true,
    indexFile,
    version: Number.isFinite(parsed.version) ? parsed.version : INDEX_VERSION,
    totalPages: Array.isArray(parsed.pages) ? parsed.pages.length : 0,
    fileSizeBytes,
    ...(generatedAt ? { generatedAt } : {})
  };
};

const writeSearchIndexDocument = async (pages: SearchIndexPageEntry[]): Promise<void> => {
  const normalizedPages = pages.map((entry) => normalizeIndexEntry(entry)).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  const document: SearchIndexFile = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    totalPages: normalizedPages.length,
    pages: normalizedPages
  };

  await ensureDir(path.dirname(config.searchIndexFile));
  await writeJsonFile(config.searchIndexFile, document);
};

const checkSearchIndexExists = async (): Promise<boolean> => {
  try {
    await fs.access(config.searchIndexFile);
    return true;
  } catch {
    return false;
  }
};

export const upsertSearchIndexBySlug = async (slug: string): Promise<{ updated: boolean; reason?: string }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return {
      updated: false,
      reason: "invalid_slug"
    };
  }

  if (buildPromise) {
    return {
      updated: false,
      reason: "rebuild_running"
    };
  }

  const page = await getPage(normalizedSlug);
  if (!page) {
    return removeSearchIndexBySlug(normalizedSlug);
  }

  const current = await readSearchIndexFile();
  const filtered = current.pages.filter((entry) => entry.slug !== normalizedSlug);
  filtered.push(buildIndexEntryFromPage(page));

  await writeSearchIndexDocument(filtered);
  return {
    updated: true
  };
};

export const removeSearchIndexBySlug = async (slug: string): Promise<{ updated: boolean; reason?: string }> => {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return {
      updated: false,
      reason: "invalid_slug"
    };
  }

  if (buildPromise) {
    return {
      updated: false,
      reason: "rebuild_running"
    };
  }

  const exists = await checkSearchIndexExists();
  if (!exists) {
    return {
      updated: false,
      reason: "index_missing"
    };
  }

  const current = await readSearchIndexFile();
  const filtered = current.pages.filter((entry) => entry.slug !== normalizedSlug);
  if (filtered.length === current.pages.length) {
    return {
      updated: false,
      reason: "entry_missing"
    };
  }

  await writeSearchIndexDocument(filtered);
  return {
    updated: true
  };
};

export const ensureSearchIndexConsistency = async (): Promise<{ rebuilt: boolean; reason: string }> => {
  if (buildPromise) {
    await buildPromise;
    return {
      rebuilt: false,
      reason: "rebuild_already_running"
    };
  }

  const exists = await checkSearchIndexExists();
  const pages = await listPages({ forceFileScan: true });
  const indexDocument = exists ? await readSearchIndexFile() : emptyIndexFile();

  let reason = "";
  if (!exists) {
    reason = "index_missing";
  } else if (indexDocument.version !== INDEX_VERSION) {
    reason = "version_mismatch";
  } else if (indexDocument.pages.length !== pages.length) {
    reason = "page_count_mismatch";
  } else {
    const indexedBySlug = new Map(indexDocument.pages.map((entry) => [entry.slug, entry]));
    for (const page of pages) {
      const indexed = indexedBySlug.get(page.slug);
      if (!indexed) {
        reason = "missing_page";
        break;
      }

      if (buildEntrySignature(indexed) !== buildEntrySignature(page)) {
        reason = "changed_page_metadata";
        break;
      }
    }
  }

  if (!reason) {
    return {
      rebuilt: false,
      reason: "up_to_date"
    };
  }

  await runSearchIndexRebuild();
  return {
    rebuilt: true,
    reason
  };
};
