import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuthContext } from "@/contexts/AuthContext";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import LoginPage from "@/pages/login";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import RequiredPasswordChangePage from "@/pages/change-password";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";
import { canAccess, pageSection } from "@workspace/api-zod";

const IntentMonitoringPage = lazy(() => import("@/pages/intent/monitoring"));
const BuyingCommitteePage = lazy(() => import("@/pages/intent/buying-committee"));
const IntentColdAccountsPage = lazy(() => import("@/pages/intent/cold-accounts"));

const AiAnswerPage = lazy(() => import("@/pages/ai-answer/index"));
const DashboardPage = lazy(() => import("@/pages/dashboard"));
const loadAnalyticsPage = () => import("@/pages/analytics/index");
const AnalyticsPage = lazy(loadAnalyticsPage);

const ClientsPage = lazy(() => import("@/pages/clients/index"));
const ClientNewPage = lazy(() => import("@/pages/clients/new"));
const ClientEditPage = lazy(() => import("@/pages/clients/edit"));
const ClientDetailPage = lazy(() => import("@/pages/clients/detail"));

const PlaysPage = lazy(() => import("@/pages/plays/index"));
const PlayNewPage = lazy(() => import("@/pages/plays/new"));
const PlayDetailPage = lazy(() => import("@/pages/plays/detail"));

const JourneysPage = lazy(() => import("@/pages/journeys/index"));
const JourneyNewPage = lazy(() => import("@/pages/journeys/new"));
const JourneyBuilder = lazy(() => import("@/pages/journeys/builder"));
const JourneyViewer = lazy(() => import("@/pages/journeys/viewer"));

const TemplatesPage = lazy(() => import("@/pages/templates/index"));
const TemplateBuilder = lazy(() => import("@/pages/templates/builder"));

const SequencesPage = lazy(() => import("@/pages/sequences/index"));
const SequenceNewPage = lazy(() => import("@/pages/sequences/new"));
const SequenceEditor = lazy(() => import("@/pages/sequences/editor"));
const RunReportPage = lazy(() => import("@/pages/sequences/run-report"));
const RunDetailPage = lazy(() => import("@/pages/sequences/run-detail"));

const SettingsPage = lazy(() => import("@/pages/settings/index"));
const ContactsPage = lazy(() => import("@/pages/crm/contacts"));
const ContactDetailPage = lazy(() => import("@/pages/crm/contact-detail"));
const CompaniesPage = lazy(() => import("@/pages/crm/companies"));
const CompanyDetailPage = lazy(() => import("@/pages/crm/company-detail"));
const DealsPage = lazy(() => import("@/pages/crm/deals"));

// Database pages
const DatabasePage = lazy(() => import("@/pages/database/index"));
const SegmentsPage = lazy(() => import("@/pages/database/segments"));
const SegmentBuilder = lazy(() => import("@/pages/database/segment-builder"));

// Call Campaigns
const CallCampaignsPage = lazy(() => import("@/pages/calls/index"));
const CallCampaignDetailPage = lazy(() => import("@/pages/calls/detail"));
const DncListPage = lazy(() => import("@/pages/calls/dnc"));

// Intent Engine
const IntentPage = lazy(() => import("@/pages/intent/index"));
const IntentDashboardPage = lazy(() => import("@/pages/intent/dashboard"));
const SalesDashboardPage = lazy(() => import("@/pages/intent/sales-dashboard"));
const HotSalesQueuePage = lazy(() => import("@/pages/sales-dashboard"));
const PipelinePricingPage = lazy(() => import("@/pages/intent/pipeline-pricing"));
const IntentIngestPage = lazy(() => import("@/pages/intent/ingest"));
const IntentRecommendationsPage = lazy(() => import("@/pages/intent/recommendations"));
const IntentSettingsPage = lazy(() => import("@/pages/intent/settings"));
const IntentAccountPage = lazy(() => import("@/pages/intent/account-detail"));
const IntentContactPage = lazy(() => import("@/pages/intent/contact-detail"));
const IntentAccountsPage = lazy(() => import("@/pages/intent/accounts"));
const IntentInboundAccountsPage = lazy(() => import("@/pages/intent/inbound-accounts"));
const IntentSignalStreamPage = lazy(() => import("@/pages/intent/signals"));
const IntentCategoriesPage = lazy(() => import("@/pages/intent/categories"));
const IntentContactsPage = lazy(() => import("@/pages/intent/contacts"));
import IntentShell from "@/components/intent/IntentShell";

// Contest
const ContestEntriesPage = lazy(() => import("@/pages/contest/entries"));

// Library pages
const CtaButtonsLibraryPage = lazy(() => import("@/pages/library/cta-buttons"));
const PitchTemplatesPage = lazy(() => import("@/pages/library/pitch-templates"));
const MediaLibraryPage = lazy(() => import("@/pages/library/media"));
const BannersLibraryPage = lazy(() => import("@/pages/library/banners"));
const BannerEditorPage = lazy(() => import("@/pages/library/banner-editor"));
const FormsLibraryPage = lazy(() => import("@/pages/library/forms"));
const FormEditorPage = lazy(() => import("@/pages/library/form-editor"));
const FormSubmissionsPage = lazy(() => import("@/pages/library/form-submissions"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// On a direct Traffic navigation, start both the route download and the
// authenticated summary request while /auth/me is still in flight. The query
// cache lets the page join the same request instead of issuing a second one.
// Other sections and filtered deep links retain their normal query paths.
if (window.location.pathname === "/analytics") {
  const params = new URLSearchParams(window.location.search);
  void loadAnalyticsPage();
  if ([...params.keys()].every(key => key === "section" && params.get(key) === "traffic")) {
    void queryClient.prefetchQuery({
      queryKey: ["analytics", "traffic", {}],
      queryFn: async () => {
        const response = await fetch("/api/analytics/traffic?part=summary", { credentials: "include" });
        if (!response.ok) throw new Error(`Traffic analytics request failed (${response.status})`);
        return response.json();
      },
      retry: false,
    });
  }
}

function ProtectedRoutes() {
  const { user, isAuthenticated, isLoading } = useAuthContext();
  const [location] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isAuthenticated) return <LoginPage />;
  if (user?.mustChangePassword) return <RequiredPasswordChangePage />;
  if (user && location === "/" && !canAccess(user, "dashboard") && canAccess(user, "sales")) return <Redirect to="/sales-dashboard" />;
  const section = location.startsWith("/sales-dashboard") ? "sales" : pageSection(location);
  if (user && section && !canAccess(user, section)) {
    return <AppShell><div className="p-6 space-y-2"><h1 className="text-xl font-semibold">Section access restricted</h1>
      <p className="text-sm text-muted-foreground">Choose an available section in the sidebar, or ask an administrator to update your access.</p></div></AppShell>;
  }

  // Standalone sections share the platform shell, regardless of URL prefix.
  const isIntentRoute = location.startsWith("/intent") && section === "intent";

  const Content = (
    <ErrorBoundary>
      {user && section && !canAccess(user, section, true) && (
        <div className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-900" role="status">
          View-only access — you can browse this section, but cannot save changes.
        </div>
      )}
      <Switch>
        <Route path="/" component={DashboardPage} />

        {/* Clients */}
        <Route path="/clients/new" component={ClientNewPage} />
        <Route path="/clients/:id/edit">{(p) => <ClientEditPage id={p.id} />}</Route>
        <Route path="/clients/:id">{(p) => <ClientDetailPage id={p.id} />}</Route>
        <Route path="/clients" component={ClientsPage} />

        {/* Plays */}
        <Route path="/plays/new" component={PlayNewPage} />
        <Route path="/plays/:id">{(p) => <PlayDetailPage id={p.id} />}</Route>
        <Route path="/plays" component={PlaysPage} />

        {/* Journeys */}
        <Route path="/journeys/new" component={JourneyNewPage} />
        <Route path="/journeys/:id">{(p) => <JourneyBuilder id={p.id} />}</Route>
        <Route path="/journeys" component={JourneysPage} />

        {/* Templates */}
        <Route path="/templates/new">{() => <TemplateBuilder />}</Route>
        <Route path="/templates/:id/edit">{(p) => <TemplateBuilder id={p.id} />}</Route>
        <Route path="/templates/:id">{(p) => <TemplateBuilder id={p.id} defaultTab="preview" />}</Route>
        <Route path="/templates" component={TemplatesPage} />

        {/* Sequences */}
        <Route path="/sequences/new" component={SequenceNewPage} />
        <Route path="/sequences/:id/runs/:runId">{(p) => <RunDetailPage id={p.id} runId={p.runId} />}</Route>
        <Route path="/sequences/:id/runs">{(p) => <RunReportPage id={p.id} />}</Route>
        <Route path="/sequences/:id">{(p) => <SequenceEditor id={p.id} />}</Route>
        <Route path="/sequences" component={SequencesPage} />

        {/* CRM */}
        <Route path="/crm/contacts/:id">{(p) => <ContactDetailPage id={p.id} />}</Route>
        <Route path="/crm/contacts" component={ContactsPage} />
        <Route path="/crm/companies/:id">{(p) => <CompanyDetailPage id={p.id} />}</Route>
        <Route path="/crm/companies" component={CompaniesPage} />
        <Route path="/crm/deals" component={DealsPage} />
        <Route path="/crm">{() => <ContactsPage />}</Route>

        {/* Database */}
        <Route path="/database/segments/new">{() => <SegmentBuilder />}</Route>
        <Route path="/database/segments/:id">{(p) => <SegmentBuilder id={p.id} />}</Route>
        <Route path="/database/segments" component={SegmentsPage} />
        <Route path="/database" component={DatabasePage} />

        {/* Intent Engine */}
        <Route path="/intent/ingest" component={IntentIngestPage} />
        <Route path="/intent/recommendations" component={IntentRecommendationsPage} />
        <Route path="/intent/settings" component={IntentSettingsPage} />
        <Route path="/intent/accounts/:id">{(p) => <IntentAccountPage id={p.id} />}</Route>
        <Route path="/intent/accounts" component={IntentAccountsPage} />
        <Route path="/intent/sales-feedback"><Redirect to="/sales-dashboard?tab=feed" /></Route>
        <Route path="/intent/inbound-accounts" component={IntentInboundAccountsPage} />
        <Route path="/intent/signals" component={IntentSignalStreamPage} />
        <Route path="/intent/categories" component={IntentCategoriesPage} />
        <Route path="/intent/contacts/:id">{(p) => <IntentContactPage id={p.id} />}</Route>
        <Route path="/intent/contacts" component={IntentContactsPage} />
        <Route path="/intent/dashboard" component={IntentDashboardPage} />
            <Route path="/intent/sales-dashboard" component={SalesDashboardPage} />
        <Route path="/intent/monitoring" component={IntentMonitoringPage} />
        <Route path="/intent/buying-committee" component={BuyingCommitteePage} />
        <Route path="/intent/cold-accounts" component={IntentColdAccountsPage} />
            <Route path="/intent/pipeline-pricing" component={PipelinePricingPage} />
        <Route path="/intent" component={IntentPage} />

        {/* Legacy media redirect */}
        <Route path="/media">{() => <Redirect to="/library/media" />}</Route>

        {/* Library */}
        <Route path="/library/cta-buttons" component={CtaButtonsLibraryPage} />
        <Route path="/library/pitch-templates" component={PitchTemplatesPage} />
        <Route path="/library/media" component={MediaLibraryPage} />
        <Route path="/library/banners/new">{() => <BannerEditorPage />}</Route>
        <Route path="/library/banners/:id/edit">{(p) => <BannerEditorPage id={p.id} />}</Route>
        <Route path="/library/banners" component={BannersLibraryPage} />
        <Route path="/library/forms/new">{() => <FormEditorPage />}</Route>
        <Route path="/library/forms/:id/submissions">{(p) => <FormSubmissionsPage id={p.id} />}</Route>
        <Route path="/library/forms/:id/edit">{(p) => <FormEditorPage id={p.id} />}</Route>
        <Route path="/library/forms" component={FormsLibraryPage} />

        {/* Call Campaigns */}
        <Route path="/calls/dnc" component={DncListPage} />
        <Route path="/calls/:id">{(p) => <CallCampaignDetailPage id={p.id} />}</Route>
        <Route path="/calls" component={CallCampaignsPage} />

        {/* Contest */}
        <Route path="/contest/entries" component={ContestEntriesPage} />

        <Route path="/sales-dashboard" component={HotSalesQueuePage} />
        <Route path="/ai-answer" component={AiAnswerPage} />

        {/* Analytics */}
        <Route path="/analytics" component={AnalyticsPage} />

        {/* Settings */}
        <Route path="/settings" component={SettingsPage} />

        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );

  if (isIntentRoute) {
    return (
      <IntentShell>
        {Content}
        <OnboardingChecklist />
      </IntentShell>
    );
  }

  return (
    <AppShell>
      {Content}
      <OnboardingChecklist />
    </AppShell>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route path="/:clientSlug/play/:journeySlug/:pageSlug">{(p) => <JourneyViewer slug={p.journeySlug} pageSlug={p.pageSlug} />}</Route>
      <Route path="/:clientSlug/play/:journeySlug">{(p) => <JourneyViewer slug={p.journeySlug} />}</Route>
      <Route path="/play/:journeySlug/:pageSlug">{(p) => <JourneyViewer slug={p.journeySlug} pageSlug={p.pageSlug} />}</Route>
      <Route path="/play/:journeySlug">{(p) => <JourneyViewer slug={p.journeySlug} />}</Route>
      <Route path="/j/:slug">{(p) => <JourneyViewer slug={p.slug} />}</Route>
      <Route path="/j-preview/:journeyId">{(p) => {
        const id = parseInt(p.journeyId, 10);
        return Number.isFinite(id) ? <JourneyViewer previewJourneyId={id} /> : null;
      }}</Route>
      <Route component={ProtectedRoutes} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}>
              <Router />
            </Suspense>
          </WouterRouter>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
