import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

const STRIP_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-security-policy",
  "x-webkit-csp",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

router.get(
  "/proxy-embed",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawUrl = (req.query.url as string | undefined) ?? "";
      if (!rawUrl) {
        res.status(400).send("url parameter required");
        return;
      }

      let targetUrl: URL;
      try {
        targetUrl = new URL(rawUrl);
      } catch {
        res.status(400).send("Invalid URL");
        return;
      }

      if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        res.status(400).send("Only http/https URLs are supported");
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);

      let upstream: globalThis.Response;
      try {
        upstream = await fetch(targetUrl.href, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Cache-Control": "no-cache",
          },
          redirect: "follow",
        });
      } finally {
        clearTimeout(timer);
      }

      // Forward safe headers, drop frame-blocking ones
      for (const [key, value] of upstream.headers.entries()) {
        if (!STRIP_HEADERS.has(key.toLowerCase())) {
          try {
            res.setHeader(key, value);
          } catch {
            // ignore malformed header values
          }
        }
      }

      // Explicitly allow framing from our own origin
      res.removeHeader("X-Frame-Options");
      res.setHeader(
        "Content-Security-Policy",
        "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors *;"
      );

      const contentType = upstream.headers.get("content-type") ?? "";
      const isHtml =
        contentType.includes("text/html") ||
        contentType === "" ||
        (!contentType.includes("application/") && !contentType.includes("image/"));

      if (isHtml) {
        let body = await upstream.text();

        // Derive the base href — directory portion of the proxied URL so relative
        // paths (CSS, JS, images) resolve against the original origin correctly.
        const pathDir = targetUrl.pathname.endsWith("/")
          ? targetUrl.pathname
          : targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf("/") + 1);
        const baseHref = `${targetUrl.origin}${pathDir}`;
        const baseTag = `<base href="${baseHref}">`;

        // Inject before any existing <base> or at the top of <head>
        if (/<base\b/i.test(body)) {
          // leave existing base tag untouched — already has a base
        } else if (/<head\b[^>]*>/i.test(body)) {
          body = body.replace(/(<head\b[^>]*>)/i, `$1${baseTag}`);
        } else if (/<html\b[^>]*>/i.test(body)) {
          body = body.replace(/(<html\b[^>]*>)/i, `$1<head>${baseTag}</head>`);
        } else {
          body = baseTag + body;
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(upstream.status).send(body);
      } else {
        // Binary / non-HTML resource — stream through as-is
        res.status(upstream.status);
        const buffer = await upstream.arrayBuffer();
        res.send(Buffer.from(buffer));
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        res.status(504).send("Upstream request timed out");
        return;
      }
      next(err);
    }
  }
);

export default router;
