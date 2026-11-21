import express, { type Express } from "express";
import { mountRenderFrontend, renderCorsOrigin } from "../../../deployment/render/http.mjs";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import ConnectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable, tenantsTable, pool } from "@workspace/db";
import router from "./routes";
import contestRouter from "./routes/contest";
import { logger } from "./lib/logger";
import { sectionAccess } from "./middlewares/sectionAccess";
import { clientAccess } from "./middlewares/clientAccess";
import { passwordChangeRequired } from "./middlewares/passwordChangeRequired";
import { temporaryPasswordExpired, expiredTemporaryPasswordMessage } from "./lib/temporaryPasswords";

const PgSession = ConnectPgSimple(session);

// Passport local strategy
passport.use(
  new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
    try {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email.toLowerCase()));
      if (!user) return done(null, false, { message: "Invalid credentials" });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return done(null, false, { message: "Invalid credentials" });
      if (temporaryPasswordExpired(user)) {
        return done(null, false, { message: expiredTemporaryPasswordMessage, code: "TEMPORARY_PASSWORD_EXPIRED" } as any);
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }),
);

passport.serializeUser((user: any, done) => {
  done(null, { id: user.id, version: user.sessionVersion });
});

passport.deserializeUser(async (identity: number | { id: number; version: number }, done) => {
  try {
    // Legacy ID-only sessions belong to version zero. Never upgrade them to
    // the current version: that would revive a session after a password reset.
    const id = typeof identity === "number" ? identity : identity?.id;
    const version = typeof identity === "number" ? 0 : identity?.version;
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(version) || version < 0) {
      done(null, false); return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    done(null, user && user.sessionVersion === version ? user : false);
  } catch (err) {
    done(err);
  }
});

const app: Express = express();
mountRenderFrontend(app, express);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(
  cors({
    credentials: true,
    origin: renderCorsOrigin,
    exposedHeaders: ["X-Total-Count", "X-Page", "X-Page-Size"],
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Artifact deployments probe the service's registered base path (`/api`).
// Keep both the base-path probe and the explicit health endpoint independent
// of sessions, authentication, and the database so startup readiness cannot
// fail while production dependencies are still warming up.
app.get("/api", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error("SESSION_SECRET must be set");

app.use(
  session({
    store: new PgSession({ pool, tableName: "user_sessions" }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());
app.use("/api", passwordChangeRequired);
app.use("/api", sectionAccess);
app.use("/api", clientAccess);

// Contest routes are public (no session auth required) so they are mounted
// directly on the app BEFORE the main /api router, which contains sub-routers
// that have router.use(requireAuth) as global middleware. Mounting here ensures
// the contest POST endpoint is never intercepted by those auth guards.
app.use("/api", contestRouter);
app.use("/api", router);

app.use((err: any, req: any, res: any, _next: any) => {
  req.log?.error({ err }, "Unhandled route error");
  if (res.headersSent) return;
  const status = typeof err?.status === "number" ? err.status : 500;
  const message = typeof err?.message === "string" && err.message
    ? err.message
    : "Internal server error";
  res.status(status).json({ error: message });
});

export default app;
