import logoUrl from "@assets/logo_kaboom_dark_1790501456925.png";

export function BrandLogo({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <span className={`block h-6 w-[22px] overflow-hidden ${className}`}>
        <img src={logoUrl} alt="KABOOM" className="block h-6 w-auto max-w-none" />
      </span>
    );
  }

  return <img src={logoUrl} alt="KABOOM" className={`block h-6 w-auto ${className}`} />;
}