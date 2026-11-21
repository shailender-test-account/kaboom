import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Eye, EyeOff, CheckCircle2, ArrowLeft } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const [welcome] = useState(() => new URLSearchParams(window.location.search).get("welcome") === "1");
  const [token] = useState(() => welcome
    ? new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""
    : new URLSearchParams(window.location.search).get("token") ?? "");
  useEffect(() => {
    if (welcome && window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [welcome]);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = token && password.length >= 8 && password === confirm && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/auth/${welcome ? "setup-password" : "reset-password"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Reset failed — the link may have expired"); return; }
      setDone(true);
      setTimeout(() => navigate("/login"), 3000);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4 pt-24">
      <div className="absolute left-6 top-6"><BrandLogo className="h-7" /></div>
      <div className="w-full max-w-sm">
        <Card className="border shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-semibold">Set new password</CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              {done ? "Password updated — redirecting to sign in…" : "Choose a new password for your account"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!token ? (
              <div className="space-y-4">
                <p className="text-sm text-destructive bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
                  Invalid reset link. Please request a new one.
                </p>
                <Link href="/forgot-password">
                  <Button variant="outline" className="w-full h-9 text-sm">Request new link</Button>
                </Link>
              </div>
            ) : done ? (
              <div className="flex flex-col items-center text-center py-4 gap-3">
                <div className="w-12 h-12 rounded-full bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Password updated!</p>
                  <p className="text-xs text-muted-foreground mt-1">Redirecting you to sign in…</p>
                </div>
                <Link href="/login">
                  <Button variant="outline" size="sm" className="mt-1 text-xs">Sign in now</Button>
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-sm font-medium">
                    New password <span className="text-muted-foreground font-normal text-xs">(min 8 chars)</span>
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPw ? "text" : "password"}
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoFocus
                      className="h-9 pr-9"
                    />
                    <button
                      type="button"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPw(v => !v)}
                    >
                      {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirm" className="text-sm font-medium">Confirm password</Label>
                  <Input
                    id="confirm"
                    type={showPw ? "text" : "password"}
                    placeholder="••••••••"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    required
                    className={`h-9 ${mismatch ? "border-destructive focus-visible:ring-destructive" : ""}`}
                  />
                  {mismatch && <p className="text-xs text-destructive">Passwords don't match</p>}
                </div>

                {error && (
                  <p className="text-sm text-destructive bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full h-9" disabled={!canSubmit}>
                  {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Updating…</> : "Update password"}
                </Button>

                <Link href="/login">
                  <Button type="button" variant="ghost" className="w-full h-9 text-sm text-muted-foreground">
                    <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back to sign in
                  </Button>
                </Link>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          KABOOM ABM Platform
        </p>
      </div>
    </div>
  );
}
