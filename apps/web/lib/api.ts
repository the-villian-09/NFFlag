/**
 * Browser-side API helpers. Everything goes to same-origin /api/*, which
 * Next.js proxies to the API on Cloud Run.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // App API: { error: { code, message } }. Auth API: { code, message }.
    const err = data.error ?? data;
    throw new ApiError(res.status, err.code ?? "ERROR", err.message ?? "Something went wrong.", err);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", `/api/v1${path}`),
  post: <T>(path: string, body?: unknown) => request<T>("POST", `/api/v1${path}`, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", `/api/v1${path}`, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", `/api/v1${path}`, body),
};

/** Auth endpoints (Better Auth on the API). */
export const authApi = {
  signUp: (b: { name: string; email: string; password: string }) =>
    request<unknown>("POST", "/api/auth/sign-up/email", b),
  signIn: (b: { email: string; password: string }) =>
    request<{ twoFactorRedirect?: boolean }>("POST", "/api/auth/sign-in/email", b),
  signOut: () => request<unknown>("POST", "/api/auth/sign-out", {}),
  requestReset: (email: string) =>
    request<unknown>("POST", "/api/auth/request-password-reset", {
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    }),
  resetPassword: (token: string, newPassword: string) =>
    request<unknown>("POST", "/api/auth/reset-password", { token, newPassword }),
  sendEmailCode: () => request<unknown>("POST", "/api/auth/two-factor/send-otp", {}),
  verifyEmailCode: (code: string, trustDevice: boolean) =>
    request<unknown>("POST", "/api/auth/two-factor/verify-otp", { code, trustDevice }),
  verifyTotp: (code: string, trustDevice = false) =>
    request<unknown>("POST", "/api/auth/two-factor/verify-totp", { code, trustDevice }),
  verifyBackupCode: (code: string) => request<unknown>("POST", "/api/auth/two-factor/verify-backup-code", { code }),
  enableTotp: (password: string) =>
    request<{ totpURI: string; backupCodes: string[] }>("POST", "/api/auth/two-factor/enable", { password }),
  disableTwoStep: (password: string) => request<unknown>("POST", "/api/auth/two-factor/disable", { password }),
};

export interface Me {
  user: { id: string; name: string; email: string; locale: string };
  roles: string[];
  permissions: string[];
  /**
   * required: "none" = optional (default); "totp" = one of the user's roles
   * requires an authenticator app. enabled = the user has turned it on.
   */
  mfa: { required: "none" | "totp"; complete: boolean; enabled: boolean; totpEnrolled: boolean };
  emailVerified: boolean;
  householdId: string | null;
}
