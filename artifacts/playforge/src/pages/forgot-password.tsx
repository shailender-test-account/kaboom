import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, ArrowLeft, MailCheck } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Something went wrong"); return; }
      setSent(true);
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
            <CardTitle className="text-lg font-semibold">Forgot password</CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              {sent ? "Check your inbox" : "Enter your email and we'll send you a reset link"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center text-center py-4 gap-3">
                  <div className="w-12 h-12 rounded-full bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                    <MailCheck className="w-6 h-6 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Reset link sent!</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      We sent a link to <strong>{email}</strong>.<br />
                      It expires in 1 hour. Check your spam folder if you don't see it.
                    </p>
                  </div>
                </div>
                <Link href="/login">
                  <Button variant="outline" className="w-full h-9 text-sm">
                    <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back to sign in
                  </Button>
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-sm font-medium">Work email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    autoComplete="email"
                    className="h-9"
                  />
                </div>

                {error && (
                  <p className="text-sm text-destructive bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full h-9" disabled={loading || !email}>
                  {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…</> : "Send reset link"}
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
