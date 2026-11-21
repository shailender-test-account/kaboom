import { useState } from "react";
import { useLocation } from "wouter";
import { useAuthContext } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const { login } = useAuthContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err.message ?? "Login failed");
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
            <CardTitle className="text-lg font-semibold">Sign in to your workspace</CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              Enter your credentials to continue
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                  <a href="/forgot-password" className="text-xs text-indigo-600 hover:text-indigo-700 hover:underline">
                    Forgot password?
                  </a>
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="h-9"
                />
              </div>

              {error && (
                <p role="alert" className="text-sm text-destructive bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
                  {error}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Temporary passwords expire. Choose a personal password after signing in.
                If yours has expired, ask your administrator to reissue it or use Forgot password.
              </p>

              <Button type="submit" className="w-full h-9" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          KABOOM ABM Platform
        </p>
      </div>
    </div>
  );
}
