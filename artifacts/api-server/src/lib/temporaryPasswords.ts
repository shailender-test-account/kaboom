import { z } from "zod";

// A deadline is assigned only when a credential is explicitly issued. NULL
// means untracked legacy credentials, not an invitation to infer their age.
export const temporaryPasswordHours = z.number().int().min(1).max(168).default(72);
export function temporaryPasswordDeadline(hours: number = 72): Date {
  return new Date(Date.now() + temporaryPasswordHours.parse(hours) * 60 * 60 * 1000);
}
export function temporaryPasswordExpired(user: {
  mustChangePassword?: boolean;
  temporaryPasswordExpiresAt?: Date | null;
}): boolean {
  return user.mustChangePassword === true && user.temporaryPasswordExpiresAt != null
    && user.temporaryPasswordExpiresAt.getTime() <= Date.now();
}
export const expiredTemporaryPasswordMessage =
  "Your temporary password has expired. Ask your workspace administrator to reissue it, or use Forgot password to choose a personal password.";
