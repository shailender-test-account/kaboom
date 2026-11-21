import type { Request, Response, NextFunction } from "express";
import { temporaryPasswordExpired, expiredTemporaryPasswordMessage } from "../lib/temporaryPasswords";

// Runs before section/client permissions so even an admin cannot bypass the
// first-login restriction by requesting a protected endpoint directly.
export function passwordChangeRequired(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated() || !(req.user as { mustChangePassword?: boolean })?.mustChangePassword) {
    next(); return;
  }
  // An already signed-in user must not redeem an expired password through
  // the change-password endpoint. Public recovery links remain independent.
  const publicRecovery = [
    ["POST", "/auth/login"], ["POST", "/auth/logout"], ["POST", "/auth/logout-all"], ["POST", "/auth/forgot-password"],
    ["POST", "/auth/setup-password"], ["POST", "/auth/reset-password"],
  ].some(([method, path]) => req.method === method && req.path === path);
  if (publicRecovery) { next(); return; }
  if (temporaryPasswordExpired(req.user as any)) {
    res.status(401).json({ error: expiredTemporaryPasswordMessage, code: "TEMPORARY_PASSWORD_EXPIRED" });
    return;
  }
  const allowed = [
    ["GET", "/auth/me"], ["PATCH", "/auth/password"],
  ].some(([method, path]) => req.method === method && req.path === path);
  if (allowed) { next(); return; }
  res.status(403).json({ error: "Change your temporary password before accessing the app.", code: "PASSWORD_CHANGE_REQUIRED" });
}
