import React from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends React.Component<React.PropsWithChildren<{ fallback?: React.ReactNode }>, State> {
  constructor(props: React.PropsWithChildren<{ fallback?: React.ReactNode }>) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full min-h-[300px] p-8 text-center">
          <div className="w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-destructive" />
          </div>
          <h2 className="text-base font-semibold text-foreground mb-1">Something went wrong</h2>
          <p className="text-sm text-muted-foreground mb-4 max-w-xs">
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { this.setState({ hasError: false, error: undefined }); window.location.reload(); }}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-2" />
            Reload page
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
