import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SectionPermissions } from "@workspace/api-zod";

export interface AuthUser {
  id: number;
  tenantId: number;
  tenantName: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  mustChangePassword?: boolean;
  sectionPermissions?: SectionPermissions | null;
  avatarUrl: string | null;
}

interface UseAuthReturn {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const accessSignature = useRef<string | null>(null);

  const fetchMe = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const signature = JSON.stringify([data.id, data.role, data.sectionPermissions, data.mustChangePassword]);
        if (accessSignature.current && accessSignature.current !== signature) queryClient.clear();
        accessSignature.current = signature;
        setUser(data);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    fetchMe();
    const refresh = () => { if (document.visibilityState === "visible") void fetchMe(); };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, [fetchMe]);

  const login = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? "Invalid credentials");
    }
    const data: AuthUser = await res.json();
    // In particular, discard a Traffic prefetch that may have failed before
    // this sign-in (and any data cached for the previous session).
    queryClient.clear();
    setUser(data);
    return data;
  }, [queryClient]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  return {
    user,
    isLoading,
    isAuthenticated: user !== null,
    login,
    logout,
    refetch: fetchMe,
  };
}
