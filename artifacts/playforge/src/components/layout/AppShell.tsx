import { Sidebar } from "./Sidebar";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotificationsBell } from "@/components/NotificationsBell";
import { GlobalSearch, useGlobalSearch } from "@/components/GlobalSearch";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { open, setOpen } = useGlobalSearch();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="h-12 border-b bg-card flex items-center justify-between px-4 shrink-0 gap-3">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs text-muted-foreground gap-2 pl-2.5 pr-3 w-52 justify-start font-normal"
            onClick={() => setOpen(true)}
          >
            <Search className="w-3 h-3" />
            Search…
            <kbd className="ml-auto text-[10px] font-mono bg-muted px-1 rounded border text-muted-foreground">⌘K</kbd>
          </Button>
          <div className="flex items-center gap-1">
            <NotificationsBell />
          </div>
        </header>
        {/* Page content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
      <GlobalSearch open={open} onOpenChange={setOpen} />
    </div>
  );
}
