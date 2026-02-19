import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { config } from "../config.js";
import { ensureDir, readJsonFile } from "./fileStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const VIEW_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const STORE_RETENTION_DAYS = 120;
const DEFAULT_TRENDING_DAYS = 30;
const MAX_TRENDING_DAYS = 365;
const DEFAULT_TRENDING_LIMIT = 6;
const MAX_TRENDING_LIMIT = 20;
const PAGE_VIEW_DB_VERSION = 1;

interface SqlJsStatement {
  bind(params?: unknown[] | Record<string, unknown>): void;
  step(): boolean;
  getAsObject(params?: unknown[] | Record<string, unknown>): Record<string, unknown>;
  free(): void;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

type SqlJsInit = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

interface LegacyPageViewEvent {
  slug: string;
  viewedAt: string;
  viewerKey?: string;
}

interface LegacyPageViewStoreDocument {
  events?: unknown;
}

export interface RecordPageViewInput {
  slug: string;
  viewedAt?: string;
  userId?: string;
  sessionId?: string;
}

export interface TrendingTopicsInput {
  days?: number;
  limit?: number;
}

export interface TrendingTopicSummary {
  slug: string;
  views: number;
  lastViewedAt: string;
}

const require = createRequire(import.meta.url);

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS page_views_daily (
  slug TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  lastViewedAt TEXT NOT NULL,
  PRIMARY KEY (slug, day)
);
CREATE INDEX IF NOT EXISTS page_views_daily_day_idx ON page_views_daily(day);
CREATE TABLE IF NOT EXISTS viewer_hits (
  slug TEXT NOT NULL,
  viewerKey TEXT NOT NULL,
  lastSeenAtMs INTEGER NOT NULL,
  PRIMARY KEY (slug, viewerKey)
);
CREATE INDEX IF NOT EXISTS viewer_hits_seen_idx ON viewer_hits(lastSeenAtMs);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let sqlRuntimePromise: Promise<SqlJsStatic> | null = null;
let sqliteDb: SqlJsDatabase | null = null;
let sqliteLock: Promise<void> = Promise.resolve();

const withSqliteLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const current = sqliteLock;
  let release!: () => void;
  sqliteLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await current;
  try {
    return await task();
  } finally {
    release();
  }
};

const getSqlRuntime = async (): Promise<SqlJsStatic> => {
  if (!sqlRuntimePromise) {
    sqlRuntimePromise = (async () => {
      const imported = (await import("sql.js")) as { default?: SqlJsInit };
      if (typeof imported.default !== "function") {
        throw new Error("sql.js konnte nicht initialisiert werden.");
      }

      return imported.default({
        locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`)
      });
    })();
  }

  return sqlRuntimePromise;
};

const closeSqliteDb = (): void => {
  if (!sqliteDb) return;
  try {
    sqliteDb.close();
  } catch {
    // noop
  }
  sqliteDb = null;
};

const quarantineCorruptStoreFile = async (): Promise<void> => {
  try {
    await fs.access(config.pageViewsSqliteFile);
  } catch {
    return;
  }

  const corruptPath = `${config.pageViewsSqliteFile}.corrupt-${Date.now()}`;
  try {
    await fs.rename(config.pageViewsSqliteFile, corruptPath);
  } catch {
    // noop
  }
};

const ensureSchema = (db: SqlJsDatabase): void => {
  db.run(SQLITE_SCHEMA);
};

const persistSqliteDb = async (db: SqlJsDatabase): Promise<void> => {
  await ensureDir(path.dirname(config.pageViewsSqliteFile));
  const tmpPath = `${config.pageViewsSqliteFile}.${randomUUID()}.tmp`;
  const payload = Buffer.from(db.export());
  await fs.writeFile(tmpPath, payload);
  await fs.rename(tmpPath, config.pageViewsSqliteFile);
};

const toInt = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const normalizeSlug = (value: string): string => value.trim().toLowerCase();

const normalizeIsoDate = (value: string): string | null => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
};

const toDayKeyFromMs = (value: number): string => new Date(value).toISOString().slice(0, 10);

const normalizeViewerKey = (input: RecordPageViewInput): string | null => {
  if (typeof input.userId === "string" && input.userId.trim().length > 0) {
    return `user:${input.userId.trim().toLowerCase()}`;
  }

  if (typeof input.sessionId === "string" && input.sessionId.trim().length > 0) {
    return `session:${input.sessionId.trim()}`;
  }

  return null;
};

const getMetaValue = (db: SqlJsDatabase, key: string): string | null => {
  const stmt = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1");
  try {
    stmt.bind([key]);
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    return typeof row.value === "string" ? row.value : String(row.value ?? "");
  } finally {
    stmt.free();
  }
};

const setMetaValue = (db: SqlJsDatabase, key: string, value: string): void => {
  db.run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
};

const parseLegacyEvent = (value: unknown): LegacyPageViewEvent | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.slug !== "string" || typeof raw.viewedAt !== "string") return null;

  const slug = normalizeSlug(raw.slug);
  const viewedAt = normalizeIsoDate(raw.viewedAt);
  if (!slug || !viewedAt) return null;

  const viewerKey = typeof raw.viewerKey === "string" ? raw.viewerKey.trim().slice(0, 180) : "";
  if (viewerKey.length > 0) {
    return { slug, viewedAt, viewerKey };
  }

  return { slug, viewedAt };
};

const migrateLegacyJsonIfNeeded = async (db: SqlJsDatabase): Promise<boolean> => {
  const alreadyMigrated = getMetaValue(db, "legacy_json_migrated");
  if (alreadyMigrated === "1") {
    return false;
  }

  const legacy = await readJsonFile<LegacyPageViewStoreDocument>(config.pageViewsFile, {});
  const rawEvents = Array.isArray(legacy.events) ? legacy.events : [];
  const cutoffMs = Date.now() - STORE_RETENTION_DAYS * DAY_MS;
  const events = rawEvents
    .map((entry) => parseLegacyEvent(entry))
    .filter((entry): entry is LegacyPageViewEvent => {
      if (!entry) return false;
      const viewedAtMs = Date.parse(entry.viewedAt);
      return Number.isFinite(viewedAtMs) && viewedAtMs >= cutoffMs;
    });

  if (events.length < 1) {
    setMetaValue(db, "legacy_json_migrated", "1");
    setMetaValue(db, "version", String(PAGE_VIEW_DB_VERSION));
    setMetaValue(db, "updatedAt", new Date().toISOString());
    return true;
  }

  const dailyBuckets = new Map<string, { slug: string; day: string; views: number; lastViewedAt: string }>();
  const viewerSeen = new Map<string, number>();

  for (const event of events) {
    const viewedAtMs = Date.parse(event.viewedAt);
    if (!Number.isFinite(viewedAtMs)) continue;
    const day = toDayKeyFromMs(viewedAtMs);
    const bucketKey = `${event.slug}@@${day}`;
    const existing = dailyBuckets.get(bucketKey);
    if (!existing) {
      dailyBuckets.set(bucketKey, {
        slug: event.slug,
        day,
        views: 1,
        lastViewedAt: event.viewedAt
      });
    } else {
      existing.views += 1;
      if (event.viewedAt > existing.lastViewedAt) {
        existing.lastViewedAt = event.viewedAt;
      }
    }

    if (event.viewerKey) {
      const viewerKey = `${event.slug}@@${event.viewerKey}`;
      const current = viewerSeen.get(viewerKey) ?? 0;
      if (viewedAtMs > current) {
        viewerSeen.set(viewerKey, viewedAtMs);
      }
    }
  }

  db.run("BEGIN TRANSACTION");
  try {
    for (const bucket of dailyBuckets.values()) {
      db.run(
        `INSERT INTO page_views_daily(slug, day, views, lastViewedAt) VALUES(?, ?, ?, ?)
         ON CONFLICT(slug, day) DO UPDATE SET
           views = page_views_daily.views + excluded.views,
           lastViewedAt = CASE
             WHEN excluded.lastViewedAt > page_views_daily.lastViewedAt THEN excluded.lastViewedAt
             ELSE page_views_daily.lastViewedAt
           END`,
        [bucket.slug, bucket.day, bucket.views, bucket.lastViewedAt]
      );
    }

    for (const [key, lastSeenAtMs] of viewerSeen.entries()) {
      const [slug, viewerKey] = key.split("@@");
      db.run(
        `INSERT INTO viewer_hits(slug, viewerKey, lastSeenAtMs) VALUES(?, ?, ?)
         ON CONFLICT(slug, viewerKey) DO UPDATE SET
           lastSeenAtMs = CASE
             WHEN excluded.lastSeenAtMs > viewer_hits.lastSeenAtMs THEN excluded.lastSeenAtMs
             ELSE viewer_hits.lastSeenAtMs
           END`,
        [slug, viewerKey, lastSeenAtMs]
      );
    }

    setMetaValue(db, "legacy_json_migrated", "1");
    setMetaValue(db, "version", String(PAGE_VIEW_DB_VERSION));
    setMetaValue(db, "updatedAt", new Date().toISOString());
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }

  return true;
};

const openSqliteDb = async (): Promise<SqlJsDatabase> => {
  if (sqliteDb) return sqliteDb;

  const SQL = await getSqlRuntime();

  let sourceBytes: Uint8Array | null = null;
  try {
    const raw = await fs.readFile(config.pageViewsSqliteFile);
    sourceBytes = new Uint8Array(raw);
  } catch {
    sourceBytes = null;
  }

  try {
    sqliteDb = sourceBytes ? new SQL.Database(sourceBytes) : new SQL.Database();
    ensureSchema(sqliteDb);
    const migrated = await migrateLegacyJsonIfNeeded(sqliteDb);
    if (migrated) {
      await persistSqliteDb(sqliteDb);
    }
    return sqliteDb;
  } catch {
    closeSqliteDb();
    await quarantineCorruptStoreFile();
    sqliteDb = new SQL.Database();
    ensureSchema(sqliteDb);
    const migrated = await migrateLegacyJsonIfNeeded(sqliteDb);
    if (migrated) {
      await persistSqliteDb(sqliteDb);
    }
    return sqliteDb;
  }
};

const clampDays = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TRENDING_DAYS;
  const rounded = Math.round(value);
  return Math.max(1, Math.min(MAX_TRENDING_DAYS, rounded));
};

const clampLimit = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TRENDING_LIMIT;
  const rounded = Math.round(value);
  return Math.max(1, Math.min(MAX_TRENDING_LIMIT, rounded));
};

export const recordPageView = async (input: RecordPageViewInput): Promise<{ recorded: boolean }> =>
  withSqliteLock(async () => {
    const slug = normalizeSlug(input.slug);
    if (!slug) {
      return { recorded: false };
    }

    const viewedAt = normalizeIsoDate(input.viewedAt ?? new Date().toISOString());
    if (!viewedAt) {
      return { recorded: false };
    }

    const nowMs = Date.parse(viewedAt);
    const day = toDayKeyFromMs(nowMs);
    const viewerKey = normalizeViewerKey(input);
    const dailyCutoff = toDayKeyFromMs(nowMs - STORE_RETENTION_DAYS * DAY_MS);
    const viewerCutoffMs = nowMs - (STORE_RETENTION_DAYS * DAY_MS + VIEW_DEDUPE_WINDOW_MS);
    const db = await openSqliteDb();

    let recorded = true;
    db.run("BEGIN TRANSACTION");
    try {
      db.run("DELETE FROM page_views_daily WHERE day < ?", [dailyCutoff]);
      db.run("DELETE FROM viewer_hits WHERE lastSeenAtMs < ?", [viewerCutoffMs]);

      if (viewerKey) {
        const check = db.prepare("SELECT lastSeenAtMs FROM viewer_hits WHERE slug = ? AND viewerKey = ? LIMIT 1");
        try {
          check.bind([slug, viewerKey]);
          if (check.step()) {
            const row = check.getAsObject();
            const lastSeenAtMs = toInt(row.lastSeenAtMs);
            if (lastSeenAtMs > 0 && nowMs - lastSeenAtMs < VIEW_DEDUPE_WINDOW_MS) {
              recorded = false;
            }
          }
        } finally {
          check.free();
        }

        db.run(
          `INSERT INTO viewer_hits(slug, viewerKey, lastSeenAtMs) VALUES(?, ?, ?)
           ON CONFLICT(slug, viewerKey) DO UPDATE SET lastSeenAtMs = excluded.lastSeenAtMs`,
          [slug, viewerKey, nowMs]
        );
      }

      if (recorded) {
        db.run(
          `INSERT INTO page_views_daily(slug, day, views, lastViewedAt) VALUES(?, ?, 1, ?)
           ON CONFLICT(slug, day) DO UPDATE SET
             views = page_views_daily.views + 1,
             lastViewedAt = CASE
               WHEN excluded.lastViewedAt > page_views_daily.lastViewedAt THEN excluded.lastViewedAt
               ELSE page_views_daily.lastViewedAt
             END`,
          [slug, day, viewedAt]
        );
      }

      setMetaValue(db, "version", String(PAGE_VIEW_DB_VERSION));
      setMetaValue(db, "updatedAt", viewedAt);
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    await persistSqliteDb(db);
    return { recorded };
  });

export const listTrendingTopics = async (input: TrendingTopicsInput = {}): Promise<TrendingTopicSummary[]> => {
  const days = clampDays(input.days);
  const limit = clampLimit(input.limit);
  const cutoffDay = toDayKeyFromMs(Date.now() - days * DAY_MS);

  return withSqliteLock(async () => {
    try {
      const db = await openSqliteDb();
      const stmt = db.prepare(
        `SELECT slug, SUM(views) AS views, MAX(lastViewedAt) AS lastViewedAt
         FROM page_views_daily
         WHERE day >= ?
         GROUP BY slug
         ORDER BY views DESC, lastViewedAt DESC, slug ASC
         LIMIT ?`
      );

      try {
        stmt.bind([cutoffDay, limit]);
        const rows: TrendingTopicSummary[] = [];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          const slug = typeof row.slug === "string" ? row.slug.trim().toLowerCase() : "";
          const views = toInt(row.views);
          const lastViewedAt =
            typeof row.lastViewedAt === "string" && row.lastViewedAt.trim().length > 0
              ? row.lastViewedAt
              : new Date().toISOString();
          if (!slug || views < 1) continue;
          rows.push({
            slug,
            views,
            lastViewedAt
          });
        }
        return rows;
      } finally {
        stmt.free();
      }
    } catch {
      closeSqliteDb();
      return [];
    }
  });
};
