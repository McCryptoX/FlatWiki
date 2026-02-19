import { config } from "../config.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

export type WorkflowStatus = "draft" | "in_review" | "approved";

export interface PageWorkflow {
  slug: string;
  ownerUsername: string;
  status: WorkflowStatus;
  reviewDueAt: string;
  updatedAt: string;
  updatedBy: string;
}

interface WorkflowDocument {
  pages?: unknown;
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
  await ensureFile(config.workflowFile, '{"pages":[]}\n');
};

const normalizeSlug = (value: string): string => value.trim().toLowerCase();

const normalizeStatus = (value: unknown): WorkflowStatus => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "approved") return "approved";
  if (raw === "in_review") return "in_review";
  return "draft";
};

const normalizeIsoDate = (value: string): string => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
};

const normalizeWorkflow = (value: unknown): PageWorkflow | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const slug = normalizeSlug(String(raw.slug ?? ""));
  const ownerUsername = String(raw.ownerUsername ?? "").trim().toLowerCase();
  const status = normalizeStatus(raw.status);
  const reviewDueAt = normalizeIsoDate(String(raw.reviewDueAt ?? ""));
  const updatedAt = normalizeIsoDate(String(raw.updatedAt ?? new Date().toISOString())) || new Date().toISOString();
  const updatedBy = String(raw.updatedBy ?? "unknown").trim() || "unknown";

  if (!slug) return null;

  return {
    slug,
    ownerUsername,
    status,
    reviewDueAt,
    updatedAt,
    updatedBy
  };
};

const loadWorkflows = async (): Promise<PageWorkflow[]> => {
  await ensureStoreFile();
  const raw = await readJsonFile<WorkflowDocument>(config.workflowFile, { pages: [] });
  const entries = Array.isArray(raw.pages) ? raw.pages.map((entry) => normalizeWorkflow(entry)).filter((entry): entry is PageWorkflow => entry !== null) : [];
  return entries;
};

const saveWorkflows = async (pages: PageWorkflow[]): Promise<void> => {
  await writeJsonFile(config.workflowFile, { pages });
};

export const getPageWorkflow = async (slugInput: string): Promise<PageWorkflow | null> => {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;

  const pages = await loadWorkflows();
  return pages.find((entry) => entry.slug === slug) ?? null;
};

export const setPageWorkflow = async (input: {
  slug: string;
  ownerUsername?: string;
  status: WorkflowStatus;
  reviewDueAt?: string;
  updatedBy: string;
}): Promise<{ ok: boolean; workflow?: PageWorkflow; error?: string }> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(input.slug);
    const ownerUsername = String(input.ownerUsername ?? "").trim().toLowerCase();
    const status = normalizeStatus(input.status);
    const reviewDueAt = normalizeIsoDate(String(input.reviewDueAt ?? ""));
    const updatedBy = String(input.updatedBy ?? "").trim() || "unknown";

    if (!slug) {
      return { ok: false, error: "Ungültige Seite." };
    }

    const pages = await loadWorkflows();
    const now = new Date().toISOString();
    const existing = pages.find((entry) => entry.slug === slug);

    const workflow: PageWorkflow = {
      slug,
      ownerUsername,
      status,
      reviewDueAt,
      updatedAt: now,
      updatedBy
    };

    if (!ownerUsername && status === "draft" && !reviewDueAt) {
      const next = pages.filter((entry) => entry.slug !== slug);
      if (next.length !== pages.length) {
        await saveWorkflows(next);
      }
      return { ok: true, workflow };
    }

    if (existing) {
      existing.ownerUsername = workflow.ownerUsername;
      existing.status = workflow.status;
      existing.reviewDueAt = workflow.reviewDueAt;
      existing.updatedAt = workflow.updatedAt;
      existing.updatedBy = workflow.updatedBy;
    } else {
      pages.push(workflow);
    }

    await saveWorkflows(pages);
    return { ok: true, workflow };
  });
};

export const removeWorkflowForPage = async (slugInput: string): Promise<boolean> => {
  return withMutationLock(async () => {
    const slug = normalizeSlug(slugInput);
    if (!slug) return false;

    const pages = await loadWorkflows();
    const next = pages.filter((entry) => entry.slug !== slug);
    const changed = next.length !== pages.length;

    if (changed) {
      await saveWorkflows(next);
    }

    return changed;
  });
};
