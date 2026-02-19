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
  mentions: string[];
  createdAt: string;
  updatedAt: string;
}

interface CommentDocument {
  comments?: unknown;
}

const COMMENT_TEXT_MAX = 4000;
const MENTION_REGEX = /@([a-z0-9._-]{3,32})/gi;

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

export const extractMentionUsernames = (text: string): string[] => {
  const seen = new Set<string>();
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = MENTION_REGEX.exec(text)) !== null) {
    const username = String(match[1] ?? "").trim().toLowerCase();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    mentions.push(username);
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

export const createPageComment = async (input: {
  slug: string;
  body: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
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

    if (!authorId || !authorUsername || !authorDisplayName) {
      return { ok: false, error: "Ungültiger Benutzerkontext." };
    }

    const comments = await loadComments();
    const now = new Date().toISOString();
    const comment: PageComment = {
      id: randomUUID(),
      slug,
      body,
      authorId,
      authorUsername,
      authorDisplayName,
      mentions: extractMentionUsernames(body),
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
