import { Request, Response, NextFunction } from "express";
import { apiSection } from "./sectionAccess";
import { canAccess } from "@workspace/api-zod";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = req.user as any;
    const path = req.path.replace(/^\/api(?=\/|$)/, "");
    const section = apiSection(path);
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const delegated = user.sectionPermissions != null && (
      (section && section !== "settings" && canAccess(user, section, write))
      || (/^\/sales-feedback(?:\/|$)/.test(path) && canAccess(user, "sales", write)));
    if (!roles.includes(user.role) && !delegated) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
