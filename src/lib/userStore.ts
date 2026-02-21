import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { PublicUser, Role, Theme, UserRecord } from "../types.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { canEncryptSecrets, decryptSecret, encryptSecret } from "./secretCrypto.js";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

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

const toPublicUser = (user: UserRecord): PublicUser => {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
};

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const VALID_THEMES: Theme[] = ["light", "dark", "system"];

interface PersistedUserRecord extends UserRecord {
  emailEnc?: string;
}

const loadUsers = async (): Promise<UserRecord[]> => {
  await ensureFile(config.usersFile, "[]\n");
  const users = await readJsonFile<PersistedUserRecord[]>(config.usersFile, []);
  // Migration: add theme field to any record that lacks it (no save here — callers handle persistence)
  const normalizedUsers: UserRecord[] = [];
  for (const user of users) {
    const normalizedTheme = VALID_THEMES.includes(user.theme) ? user.theme : "system";
    const encryptedEmail = typeof user.emailEnc === "string" ? decryptSecret(user.emailEnc) : null;
    const rawEmail = typeof encryptedEmail === "string" ? encryptedEmail : user.email;
    const normalizedEmail = normalizeEmail(rawEmail);

    normalizedUsers.push({
      ...user,
      theme: normalizedTheme,
      email: normalizedEmail || undefined
    });
  }
  return normalizedUsers;
};

const saveUsers = async (users: UserRecord[]): Promise<void> => {
  if (!canEncryptSecrets() && users.some((user) => Boolean(user.email))) {
    console.warn("[user-store] CONTENT_ENCRYPTION_KEY fehlt oder ungültig. E-Mail-Adressen werden als Klartext gespeichert.");
  }

  const persistable: PersistedUserRecord[] = users.map((user) => {
    const { email: _email, ...base } = user;
    const normalizedEmail = normalizeEmail(user.email);
    const encryptedEmail = normalizedEmail ? encryptSecret(normalizedEmail) : null;
    if (encryptedEmail) {
      return {
        ...base,
        emailEnc: encryptedEmail
      };
    }
    if (normalizedEmail) {
      return {
        ...base,
        email: normalizedEmail
      };
    }
    return base;
  });

  await writeJsonFile(config.usersFile, persistable);
};

export const listUsers = async (): Promise<PublicUser[]> => {
  const users = await loadUsers();
  return users.map(toPublicUser);
};

export const hasAnyUser = async (): Promise<boolean> => {
  const users = await loadUsers();
  return users.length > 0;
};

export const migrateUserSecretStorage = async (): Promise<void> => {
  const users = await loadUsers();
  await saveUsers(users);
};

export const findUserById = async (id: string): Promise<PublicUser | null> => {
  const users = await loadUsers();
  const user = users.find((candidate) => candidate.id === id);
  return user ? toPublicUser(user) : null;
};

export const findUserByUsername = async (username: string): Promise<PublicUser | null> => {
  const normalized = normalizeUsername(username);
  const users = await loadUsers();
  const user = users.find((candidate) => normalizeUsername(candidate.username) === normalized);
  return user ? toPublicUser(user) : null;
};

export interface CreateUserInput {
  username: string;
  displayName: string;
  role: Role;
  password: string;
}

export const validateUserInput = (input: Pick<CreateUserInput, "username" | "displayName">): string | null => {
  const username = normalizeUsername(input.username);
  const displayName = input.displayName.trim();

  if (!USERNAME_PATTERN.test(username)) {
    return "Benutzername muss 3-32 Zeichen lang sein und nur a-z, 0-9, '.', '_' oder '-' enthalten.";
  }

  if (displayName.length < 2 || displayName.length > 80) {
    return "Anzeigename muss zwischen 2 und 80 Zeichen lang sein.";
  }

  return null;
};

export const createUser = async (input: CreateUserInput): Promise<{ user?: PublicUser; error?: string }> => {
  return withMutationLock(async () => {
    const validationError = validateUserInput(input);
    if (validationError) {
      return { error: validationError };
    }

    const normalizedUsername = normalizeUsername(input.username);
    const users = await loadUsers();

    if (users.some((candidate) => normalizeUsername(candidate.username) === normalizedUsername)) {
      return { error: "Benutzername existiert bereits." };
    }

    const now = new Date().toISOString();
    const newUser: UserRecord = {
      id: randomUUID(),
      username: normalizedUsername,
      displayName: input.displayName.trim(),
      role: input.role,
      passwordHash: await hashPassword(input.password),
      createdAt: now,
      updatedAt: now,
      disabled: false,
      theme: "system"
    };

    users.push(newUser);
    await saveUsers(users);

    return { user: toPublicUser(newUser) };
  });
};

export const setupInitialAdmin = async (input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<{ user?: PublicUser; error?: string }> => {
  return withMutationLock(async () => {
    const users = await loadUsers();
    if (users.length > 0) {
      return { error: "Setup bereits abgeschlossen." };
    }

    const validationError = validateUserInput({
      username: input.username,
      displayName: input.displayName
    });
    if (validationError) {
      return { error: validationError };
    }

    const normalizedUsername = normalizeUsername(input.username);
    const now = new Date().toISOString();
    const admin: UserRecord = {
      id: randomUUID(),
      username: normalizedUsername,
      displayName: input.displayName.trim(),
      role: "admin",
      passwordHash: await hashPassword(input.password),
      createdAt: now,
      updatedAt: now,
      disabled: false,
      theme: "system"
    };

    await saveUsers([admin]);
    return { user: toPublicUser(admin) };
  });
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const normalizeEmail = (value: string | undefined): string => {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) return "";
  return trimmed;
};

export interface UpdateUserInput {
  displayName: string;
  role: Role;
  disabled: boolean;
  theme?: Theme;
  email?: string;
}

export const updateUser = async (userId: string, input: UpdateUserInput): Promise<{ user?: PublicUser; error?: string }> => {
  return withMutationLock(async () => {
    const displayName = input.displayName.trim();
    if (displayName.length < 2 || displayName.length > 80) {
      return { error: "Anzeigename muss zwischen 2 und 80 Zeichen lang sein." };
    }

    const users = await loadUsers();
    const target = users.find((candidate) => candidate.id === userId);
    if (!target) {
      return { error: "Benutzer nicht gefunden." };
    }

    target.displayName = displayName;
    target.role = input.role;
    target.disabled = input.disabled;
    if (input.theme !== undefined) target.theme = input.theme;
    if (input.email !== undefined) target.email = normalizeEmail(input.email) || undefined;
    target.updatedAt = new Date().toISOString();

    await saveUsers(users);
    return { user: toPublicUser(target) };
  });
};

export const deleteUser = async (userId: string): Promise<boolean> => {
  return withMutationLock(async () => {
    const users = await loadUsers();
    const nextUsers = users.filter((candidate) => candidate.id !== userId);
    if (nextUsers.length === users.length) {
      return false;
    }

    await saveUsers(nextUsers);
    return true;
  });
};

export const verifyUserCredentials = async (
  username: string,
  password: string
): Promise<{ user?: PublicUser; error?: string }> => {
  const normalizedUsername = normalizeUsername(username);
  const users = await loadUsers();

  const user = users.find((candidate) => normalizeUsername(candidate.username) === normalizedUsername);
  if (!user) {
    return { error: "Ungültige Zugangsdaten." };
  }

  if (user.disabled) {
    return { error: "Dieses Konto ist deaktiviert." };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { error: "Ungültige Zugangsdaten." };
  }

  if (needsRehash(user.passwordHash)) {
    user.passwordHash = await hashPassword(password);
    user.updatedAt = new Date().toISOString();
    await saveUsers(users);
  }

  return { user: toPublicUser(user) };
};

export const changeUserPassword = async (
  userId: string,
  oldPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> => {
  return withMutationLock(async () => {
    const users = await loadUsers();
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) {
      return { ok: false, error: "Benutzer nicht gefunden." };
    }

    const valid = await verifyPassword(oldPassword, user.passwordHash);
    if (!valid) {
      return { ok: false, error: "Aktuelles Passwort ist falsch." };
    }

    user.passwordHash = await hashPassword(newPassword);
    user.updatedAt = new Date().toISOString();

    await saveUsers(users);
    return { ok: true };
  });
};

export const setUserPasswordByAdmin = async (userId: string, password: string): Promise<{ ok: boolean; error?: string }> => {
  return withMutationLock(async () => {
    const users = await loadUsers();
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) {
      return { ok: false, error: "Benutzer nicht gefunden." };
    }

    user.passwordHash = await hashPassword(password);
    user.updatedAt = new Date().toISOString();
    await saveUsers(users);

    return { ok: true };
  });
};

export const updateUserTheme = async (userId: string, theme: Theme): Promise<void> => {
  await withMutationLock(async () => {
    const users = await loadUsers();
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) return;
    user.theme = theme;
    user.updatedAt = new Date().toISOString();
    await saveUsers(users);
  });
};

export const touchLastLogin = async (userId: string): Promise<void> => {
  await withMutationLock(async () => {
    const users = await loadUsers();
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) {
      return;
    }

    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    await saveUsers(users);
  });
};

export const ensureInitialAdmin = async (): Promise<{ created: boolean; username?: string; pendingSetup: boolean }> => {
  return withMutationLock(async () => {
    const users = await loadUsers();
    if (users.length > 0) {
      return { created: false, pendingSetup: false };
    }

    const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!bootstrapPassword) {
      return { created: false, pendingSetup: true };
    }

    const username = normalizeUsername(process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin");

    const now = new Date().toISOString();
    const admin: UserRecord = {
      id: randomUUID(),
      username,
      displayName: "Administrator",
      role: "admin",
      passwordHash: await hashPassword(bootstrapPassword),
      createdAt: now,
      updatedAt: now,
      disabled: false,
      theme: "system"
    };

    await saveUsers([admin]);

    const result: { created: true; username: string; pendingSetup: false } = {
      created: true,
      username,
      pendingSetup: false
    };

    return result;
  });
};
