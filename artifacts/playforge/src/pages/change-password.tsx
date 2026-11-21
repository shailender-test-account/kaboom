import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { useAuthContext } from "@/contexts/AuthContext";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";

export default function RequiredPasswordChangePage() {
  const { logout } = useAuthContext();
  return (
    <main className="min-h-screen bg-background flex flex-col items-center justify-center p-6 gap-6">
      <BrandLogo className="w-40" />
      <section className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm space-y-4">
        <h1 className="text-xl font-semibold">Choose your own password</h1>
        <p className="text-sm text-muted-foreground">
          You signed in with a temporary password. Replace it before accessing your workspace.
        </p>
        <ChangePasswordForm required />
        <Button variant="ghost" className="w-full" onClick={() => void logout()}>Sign out</Button>
      </section>
    </main>
  );
}
