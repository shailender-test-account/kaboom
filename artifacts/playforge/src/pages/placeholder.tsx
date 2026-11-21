interface PlaceholderPageProps {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
}

export function PlaceholderPage({ title, description, icon: Icon }: PlaceholderPageProps) {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div className="flex flex-col items-center justify-center h-64 rounded-lg border border-dashed border-border bg-card">
        {Icon && <Icon className="w-10 h-10 text-muted-foreground mb-3" />}
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-1">Coming in the next phase</p>
      </div>
    </div>
  );
}
