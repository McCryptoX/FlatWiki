import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

export interface PageComment {
  id: string;
  slug: string;
  body: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  status: "pending" | "approved" | "rejected";
  reviewedAt?: string;
  reviewedById?: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
}

interface CommentDocument {
  comments?: unknown;
}

const COMMENT_TEXT_MAX = 4000;
const COMMENT_MENTION_MAX = 5;
const COMMENT_LINK_MAX = 2;
const COMMENT_DUPLICATE_COOLDOWN_BY_ROLE: Record<"admin" | "user", number> = {
  admin: 0,
  user: 60_000
};
const COMMENT_MIN_INTERVAL_BY_ROLE: Record<"admin" | "user", number> = {
  admin: 0,
  user: 15_000
};
const MENTION_REGEX = /@([a-z0-9._-]{3,32})/gi;
const MARKDOWN_LINK_REGEX = /\[[^\]]+]\(([^)\s]+)(?:\s+"[^"]*")?\)/gi;
const BARE_URL_REGEX = /\bhttps?:\/\/[^\s<>()]+/gi;

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
  await ensureFile(config.commentsFile, '{"comments":[]}\n');
};

const normalizeSlug = (value: string): string => value.trim().toLowerCase();

const normalizeMentions = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];

  for (const entry of value) {
    const username = String(entry ?? "").trim().toLowerCase();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    output.push(username);
  }

  return output;
};

const normalizeComment = (value: unknown): PageComment | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const id = String(raw.id ?? "").trim();
  const slug = normalizeSlug(String(raw.slug ?? ""));
  const body = String(raw.body ?? "").trim();
  const authorId = String(raw.authorId ?? "").trim();
  const authorUsername = String(raw.authorUsername ?? "").trim().toLowerCase();
  const authorDisplayName = String(raw.authorDisplayName ?? "").trim();
  const statusRaw = String(raw.status ?? "approved").trim().toLowerCase();
  const status = statusRaw === "pending" || statusRaw === "rejected" ? statusRaw : "approved";
  const reviewedAt = String(raw.reviewedAt ?? "").trim();
  const reviewedById = String(raw.reviewedById ?? "").trim();
  const createdAt = String(raw.createdAt ?? "").trim();
  const updatedAt = String(raw.updatedAt ?? "").trim();
  const mentions = normalizeMentions(raw.mentions);

  if (!id || !slug || !body || !authorId || !authorUsername || !authorDisplayName) {
    return null;
  }

  const createdAtDate = Date.parse(createdAt);
  const updatedAtDate = Date.parse(updatedAt);

  return {
    id,
    slug,
    body: body.slice(0, COMMENT_TEXT_MAX),
    authorId,
    authorUsername,
    authorDisplayName,
    status,
    ...(reviewedAt ? { reviewedAt } : {}),
    ...(reviewedById ? { reviewedById } : {}),
    mentions,
    createdAt: Number.isFinite(createdAtDate) ? new Date(createdAtDate).toISOString() : new Date().toISOString(),
    updatedAt: Number.isFinite(updatedAtDate) ? new Date(updatedAtDate).toISOString() : new Date().toISOString()
  };
};

const loadComments = async (): Promise<PageComment[]> => {
  await ensureStoreFile();
  const raw = await readJsonFile<CommentDocument>(config.commentsFile, { comments: [] });
  const comments = Array.isArray(raw.comments) ? raw.comments.map((entry) => normalizeComment(entry)).filter((entry): entry is PageComment => entry !== null) : [];
  return comments;
};

const saveComments = async (comments: PageComment[]): Promise<void> => {
  await writeJsonFile(config.commentsFile, { comments });
};

const normalizeBodyForDuplicateCheck = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

const countLinks = (text: string): number => {
  let count = 0;
  let scrubbed = text;
  let markdownMatch: RegExpExecArray | null;

  while ((markdownMatch = MARKDOWN_LINK_REGEX.exec(text)) !== null) {
    const target = String(markdownMatch[1] ?? "").trim();
    if (target.length > 0) {
      count += 1;
    }
    scrubbed = scrubbed.replace(markdownMatch[0], " ");
  }
  MARKDOWN_LINK_REGEX.lastIndex = 0;

  let bareUrlMatch: RegExpExecArray | null;
  while ((bareUrlMatch = BARE_URL_REGEX.exec(scrubbed)) !== null) {
    count += 1;
  }
  BARE_URL_REGEX.lastIndex = 0;

  return count;
};

export const extractMentionUsernames = (text: string, maxMentions = Number.POSITIVE_INFINITY): string[] => {
  const seen = new Set<string>();
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = MENTION_REGEX.exec(text)) !== null) {
    const username = String(match[1] ?? "").trim().toLowerCase();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    mentions.push(username);
    if (mentions.length >= maxMentions) {
      break;
    }
  }

  MENTION_REGEX.lastIndex = 0;
  return mentions;
};

export const listPageComments = async (slugInput: string): Promise<PageComment[]> => {
  const slug = normalizeSlug(slugInput);
  if (!slug) return [];

  const comments = await loadComments();
  return comments
    .filter((comment) => comment.slug === slug)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
};

export const listAllComments = async (): Promise<PageComment[]> => {
  const comments = await loadComments();
  return comments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
};

export const createPageComment = async (input: {
  slug: string;
  body: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  authorRole?: "admin" | "user";
  autoApprove?: boolean;
}): Promise<{ ok: boolean; comment?: PageComment; error?: string }> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(input.slug);
    const body = String(input.body ?? "").trim();
    const authorId = String(input.authorId ?? "").trim();
    const authorUsername = String(input.authorUsername ?? "").trim().toLowerCase();
    const authorDisplayName = String(input.authorDisplayName ?? "").trim();

    if (!slug) {
      return { ok: false, error: "Ungültige Seite." };
    }

    if (!body) {
      return { ok: false, error: "Kommentar darf nicht leer sein." };
    }

    if (body.length > COMMENT_TEXT_MAX) {
      return { ok: false, error: `Kommentar darf maximal ${COMMENT_TEXT_MAX} Zeichen lang sein.` };
    }

    const linkCount = countLinks(body);
    if (linkCount > COMMENT_LINK_MAX) {
      return { ok: false, error: `Kommentar darf maximal ${COMMENT_LINK_MAX} Links enthalten.` };
    }

    const mentions = extractMentionUsernames(body, COMMENT_MENTION_MAX + 1);
    if (mentions.length > COMMENT_MENTION_MAX) {
      return { ok: false, error: `Kommentar darf maximal ${COMMENT_MENTION_MAX} Erwähnungen enthalten.` };
    }

    if (!authorId || !authorUsername || !authorDisplayName) {
      return { ok: false, error: "Ungültiger Benutzerkontext." };
    }

    const comments = await loadComments();
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const role: "admin" | "user" = input.authorRole === "admin" ? "admin" : "user";
    const minIntervalMs = COMMENT_MIN_INTERVAL_BY_ROLE[role];
    const duplicateCooldownMs = COMMENT_DUPLICATE_COOLDOWN_BY_ROLE[role];

    if (minIntervalMs > 0) {
      let latestOwnCommentMs = 0;
      for (const comment of comments) {
        if (comment.authorId !== authorId) continue;
        const createdAtMs = Date.parse(comment.createdAt);
        if (!Number.isFinite(createdAtMs)) continue;
        if (createdAtMs > latestOwnCommentMs) latestOwnCommentMs = createdAtMs;
      }
      if (latestOwnCommentMs > 0 && nowMs - latestOwnCommentMs < minIntervalMs) {
        const seconds = Math.ceil((minIntervalMs - (nowMs - latestOwnCommentMs)) / 1000);
        return { ok: false, error: `Bitte warte ${seconds}s bis zum nächsten Kommentar.` };
      }
    }

    const bodyFingerprint = normalizeBodyForDuplicateCheck(body);
    const duplicateExists =
      duplicateCooldownMs > 0 &&
      comments.some((comment) => {
        if (comment.slug !== slug || comment.authorId !== authorId) return false;
        const createdAtMs = Date.parse(comment.createdAt);
        if (!Number.isFinite(createdAtMs)) return false;
        if (nowMs - createdAtMs > duplicateCooldownMs) return false;
        return normalizeBodyForDuplicateCheck(comment.body) === bodyFingerprint;
      });

    if (duplicateExists) {
      return { ok: false, error: "Doppelter Kommentar erkannt. Bitte kurz warten, bevor du denselben Text erneut postest." };
    }

    const comment: PageComment = {
      id: randomUUID(),
      slug,
      body,
      authorId,
      authorUsername,
      authorDisplayName,
      status: input.autoApprove ? "approved" : "pending",
      mentions: mentions.slice(0, COMMENT_MENTION_MAX),
      createdAt: now,
      updatedAt: now
    };

    comments.push(comment);
    await saveComments(comments);

    return { ok: true, comment };
  });
};

export const deletePageComment = async (input: {
  slug: string;
  commentId: string;
  actorId: string;
  isAdmin: boolean;
}): Promise<{ ok: boolean; deleted: boolean; error?: string }> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(input.slug);
    const commentId = String(input.commentId ?? "").trim();
    const actorId = String(input.actorId ?? "").trim();

    if (!slug || !commentId || !actorId) {
      return { ok: false, deleted: false, error: "Ungültige Anfrage." };
    }

    const comments = await loadComments();
    const index = comments.findIndex((comment) => comment.id === commentId && comment.slug === slug);
    if (index < 0) {
      return { ok: true, deleted: false };
    }

    const target = comments[index] as PageComment;
    if (!input.isAdmin && target.authorId !== actorId) {
      return { ok: false, deleted: false, error: "Nur Autor oder Admin kann den Kommentar löschen." };
    }

    comments.splice(index, 1);
    await saveComments(comments);

    return { ok: true, deleted: true };
  });
};

export const deleteCommentsForPage = async (slugInput: string): Promise<number> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(slugInput);
    if (!slug) return 0;

    const comments = await loadComments();
    const remaining = comments.filter((comment) => comment.slug !== slug);
    const removed = comments.length - remaining.length;

    if (removed > 0) {
      await saveComments(remaining);
    }

    return removed;
  });
};

export const reviewPageComment = async (input: {
  slug: string;
  commentId: string;
  reviewerId: string;
  approve: boolean;
}): Promise<{ ok: boolean; updated?: PageComment; previousStatus?: PageComment["status"]; error?: string }> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(input.slug);
    const commentId = String(input.commentId ?? "").trim();
    const reviewerId = String(input.reviewerId ?? "").trim();
    if (!slug || !commentId || !reviewerId) {
      return { ok: false, error: "Ungültige Anfrage." };
    }

    const comments = await loadComments();
    const target = comments.find((comment) => comment.slug === slug && comment.id === commentId);
    if (!target) {
      return { ok: false, error: "Kommentar nicht gefunden." };
    }

    const previousStatus = target.status;
    target.status = input.approve ? "approved" : "rejected";
    target.reviewedAt = new Date().toISOString();
    target.reviewedById = reviewerId;
    target.updatedAt = new Date().toISOString();
    await saveComments(comments);

    return { ok: true, updated: target, previousStatus };
  });
};
