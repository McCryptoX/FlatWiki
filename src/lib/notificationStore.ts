import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

export type NotificationType = "mention" | "comment" | "page_update" | "workflow";

export interface UserNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  url: string;
  sourceSlug: string;
  actorId: string;
  createdAt: string;
  readAt?: string;
  dedupeKey?: string;
}

interface NotificationDocument {
  notifications?: unknown;
}

const MAX_NOTIFICATIONS_PER_USER = 300;

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
  await ensureFile(config.notificationsFile, '{"notifications":[]}\n');
};

const normalizeType = (value: unknown): NotificationType => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "mention") return "mention";
  if (raw === "comment") return "comment";
  if (raw === "workflow") return "workflow";
  return "page_update";
};

const normalizeIsoDate = (value: unknown): string => {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString();
};

const normalizeNotification = (value: unknown): UserNotification | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const id = String(raw.id ?? "").trim();
  const userId = String(raw.userId ?? "").trim();
  const type = normalizeType(raw.type);
  const title = String(raw.title ?? "").trim();
  const body = String(raw.body ?? "").trim();
  const url = String(raw.url ?? "").trim();
  const sourceSlug = String(raw.sourceSlug ?? "").trim().toLowerCase();
  const actorId = String(raw.actorId ?? "").trim();
  const createdAt = normalizeIsoDate(raw.createdAt) || new Date().toISOString();
  const readAt = normalizeIsoDate(raw.readAt);
  const dedupeKey = String(raw.dedupeKey ?? "").trim();

  if (!id || !userId || !title || !url) {
    return null;
  }

  return {
    id,
    userId,
    type,
    title,
    body,
    url,
    sourceSlug,
    actorId,
    createdAt,
    ...(readAt ? { readAt } : {}),
    ...(dedupeKey ? { dedupeKey } : {})
  };
};

const loadNotifications = async (): Promise<UserNotification[]> => {
  await ensureStoreFile();
  const raw = await readJsonFile<NotificationDocument>(config.notificationsFile, { notifications: [] });
  const notifications = Array.isArray(raw.notifications)
    ? raw.notifications.map((entry) => normalizeNotification(entry)).filter((entry): entry is UserNotification => entry !== null)
    : [];

  return notifications;
};

const saveNotifications = async (notifications: UserNotification[]): Promise<void> => {
  await writeJsonFile(config.notificationsFile, { notifications });
};

const trimNotificationBacklog = (notifications: UserNotification[]): UserNotification[] => {
  const byUser = new Map<string, UserNotification[]>();

  for (const notification of notifications) {
    const bucket = byUser.get(notification.userId) ?? [];
    bucket.push(notification);
    byUser.set(notification.userId, bucket);
  }

  const output: UserNotification[] = [];
  for (const bucket of byUser.values()) {
    bucket.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    output.push(...bucket.slice(0, MAX_NOTIFICATIONS_PER_USER));
  }

  return output;
};

export const listNotificationsForUser = async (userIdInput: string, limit = 80): Promise<UserNotification[]> => {
  const userId = String(userIdInput ?? "").trim();
  if (!userId) return [];

  const safeLimit = Math.max(1, Math.min(limit, 200));
  const notifications = await loadNotifications();

  return notifications
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, safeLimit);
};

export const countUnreadNotifications = async (userIdInput: string): Promise<number> => {
  const userId = String(userIdInput ?? "").trim();
  if (!userId) return 0;

  const notifications = await loadNotifications();
  return notifications.filter((entry) => entry.userId === userId && !entry.readAt).length;
};

export const createNotification = async (input: {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  url: string;
  sourceSlug?: string;
  actorId?: string;
  dedupeKey?: string;
}): Promise<{ ok: boolean; created: boolean; notification?: UserNotification; error?: string }> => {
  return withMutationLock(async () => {
    const userId = String(input.userId ?? "").trim();
    const title = String(input.title ?? "").trim();
    const body = String(input.body ?? "").trim();
    const url = String(input.url ?? "").trim();
    const sourceSlug = String(input.sourceSlug ?? "").trim().toLowerCase();
    const actorId = String(input.actorId ?? "").trim();
    const dedupeKey = String(input.dedupeKey ?? "").trim();

    if (!userId || !title || !url) {
      return { ok: false, created: false, error: "Ungültige Notification." };
    }

    const notifications = await loadNotifications();
    if (dedupeKey) {
      const duplicate = notifications.find((entry) => entry.userId === userId && entry.dedupeKey === dedupeKey && !entry.readAt);
      if (duplicate) {
        return { ok: true, created: false, notification: duplicate };
      }
    }

    const notification: UserNotification = {
      id: randomUUID(),
      userId,
      type: normalizeType(input.type),
      title: title.slice(0, 220),
      body: body.slice(0, 800),
      url,
      sourceSlug,
      actorId,
      createdAt: new Date().toISOString(),
      ...(dedupeKey ? { dedupeKey } : {})
    };

    notifications.push(notification);
    await saveNotifications(trimNotificationBacklog(notifications));

    return { ok: true, created: true, notification };
  });
};

export const markNotificationRead = async (input: { userId: string; notificationId: string }): Promise<{ ok: boolean; changed: boolean }> => {
  return withMutationLock(async () => {
    const userId = String(input.userId ?? "").trim();
    const notificationId = String(input.notificationId ?? "").trim();
    if (!userId || !notificationId) {
      return { ok: true, changed: false };
    }

    const notifications = await loadNotifications();
    const target = notifications.find((entry) => entry.userId === userId && entry.id === notificationId);
    if (!target || target.readAt) {
      return { ok: true, changed: false };
    }

    target.readAt = new Date().toISOString();
    await saveNotifications(notifications);
    return { ok: true, changed: true };
  });
};

export const markAllNotificationsRead = async (userIdInput: string): Promise<number> => {
  return withMutationLock(async () => {
    const userId = String(userIdInput ?? "").trim();
    if (!userId) return 0;

    const notifications = await loadNotifications();
    let changed = 0;

    for (const notification of notifications) {
      if (notification.userId !== userId || notification.readAt) continue;
      notification.readAt = new Date().toISOString();
      changed += 1;
    }

    if (changed > 0) {
      await saveNotifications(notifications);
    }

    return changed;
  });
};

export const deleteNotificationsForPage = async (slugInput: string): Promise<number> => {
  return withMutationLock(async () => {
    const slug = String(slugInput ?? "").trim().toLowerCase();
    if (!slug) return 0;

    const notifications = await loadNotifications();
    const next = notifications.filter((entry) => entry.sourceSlug !== slug);
    const removed = notifications.length - next.length;

    if (removed > 0) {
      await saveNotifications(next);
    }

    return removed;
  });
};
