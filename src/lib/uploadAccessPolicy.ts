export interface UploadAccessDecision {
  allowed: boolean;
  statusCode?: 401 | 403;
}

export const resolveUploadAccess = (input: {
  isAuthenticated: boolean;
  publicReadEnabled: boolean;
}): UploadAccessDecision => {
  if (input.isAuthenticated || input.publicReadEnabled) {
    return { allowed: true };
  }

  return { allowed: false, statusCode: 401 };
};

export const resolveUploadFileAccess = (input: {
  isAuthenticated: boolean;
  publicReadEnabled: boolean;
  hasScopedRule: boolean;
  userCanAccessScopedFile: boolean;
}): UploadAccessDecision => {
  if (input.hasScopedRule) {
    if (input.userCanAccessScopedFile) {
      return { allowed: true };
    }
    return {
      allowed: false,
      statusCode: input.isAuthenticated ? 403 : 401
    };
  }

  return resolveUploadAccess({
    isAuthenticated: input.isAuthenticated,
    publicReadEnabled: input.publicReadEnabled
  });
};
