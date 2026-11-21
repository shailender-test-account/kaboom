import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, Smartphone, Monitor, Send, ChevronDown, Users,
  Code2, Layout, X, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import EmailBlockEditor, {
  type EmailBlock, blocksToHtml, createLayoutBlocks,
} from "./EmailBlockEditor";

interface TemplateBuilderProps { id?: string; defaultTab?: "edit" | "preview"; }

const CATEGORIES = ["Outreach", "Follow-up", "Nurture", "Event", "Re-engagement"];

const MERGE_TAGS = [
  { label: "First Name",    tag: "{{firstName}}" },
  { label: "Last Name",     tag: "{{lastName}}" },
  { label: "Company Name",  tag: "{{companyName}}" },
  { label: "Journey URL",   tag: "{{journeyUrl}}" },
  { label: "Play Name",     tag: "{{playName}}" },
  { label: "Sender Name",   tag: "{{senderName}}" },
  { label: "Sender Title",  tag: "{{senderTitle}}" },
  { label: "Unsubscribe",   tag: "{{unsubscribeUrl}}" },
];

const DEFAULT_HTML = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 24px; color: #111827; margin-bottom: 8px;">Hi {{firstName}},</h1>
  <p style="color: #374151; line-height: 1.6;">
    Your email body goes here. You can use merge tags like {{firstName}}, {{companyName}}, and {{journeyUrl}}.
  </p>
  <div style="margin: 28px 0;">
    <a href="{{journeyUrl}}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
      View Your Content →
    </a>
  </div>
  <p style="color: #6b7280; font-size: 14px;">Best regards,<br/>{{senderName}}</p>
</div>`;

const SAMPLE_VARS: Record<string, string> = {
  firstName: "Jane", lastName: "Smith", companyName: "Acme Corp",
  journeyUrl: "#", playName: "Q3 Launch", senderName: "Jordan Lee",
  senderTitle: "Account Executive", senderEmail: "jordan@agency.com",
  unsubscribeUrl: "#",
};

// ── Layout picker options ─────────────────────────────────────────────────────

const LAYOUTS = [
  {
    id: "blank",
    label: "Blank",
    desc: "Start with an empty canvas",
    preview: "□",
  },
  {
    id: "cold-outreach",
    label: "Cold Outreach",
    desc: "Header · Headline · Text · Button · Footer",
    preview: "▬\n═\n≡≡≡\n▓\n─",
  },
  {
    id: "newsletter",
    label: "Newsletter",
    desc: "Header · Headline · Image · Text · Button · Footer",
    preview: "▬\n═\n▭\n≡≡≡\n▓\n─",
  },
  {
    id: "promotional",
    label: "Promotional",
    desc: "Header · Banner · Headline · Text · Button · Footer",
    preview: "▬\n■\n═\n≡≡≡\n▓\n─",
  },
];

interface Contact { id: number; firstName: string; lastName: string; email: string; }

export default function TemplateBuilder({ id, defaultTab = "edit" }: TemplateBuilderProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isEdit = !!id;

  // ── Edit state ────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Outreach");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState(DEFAULT_HTML);

  // ── Block editor state ────────────────────────────────────────────────────
  const [blocks, setBlocks] = useState<EmailBlock[]>([]);

  // ── Editor mode: design | code | preview ─────────────────────────────────
  const [editorMode, setEditorMode] = useState<"design" | "code" | "preview">(
    defaultTab === "preview" ? "preview" : "design"
  );

  // ── Layout picker (shown for new templates) ───────────────────────────────
  const [layoutPickerOpen, setLayoutPickerOpen] = useState(!isEdit);

  // ── Preview state ─────────────────────────────────────────────────────────
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "mobile">("desktop");
  const [previewContactId, setPreviewContactId] = useState<string>("__sample__");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sendTestPending, setSendTestPending] = useState(false);

  // ── Send-test dialog state ─────────────────────────────────────────────────
  const [sendTestOpen, setSendTestOpen] = useState(false);
  const [testEmails, setTestEmails] = useState<string[]>([""]);

  // ── Load template ─────────────────────────────────────────────────────────
  // Track which template id was last initialised so that navigating between
  // templates (Wouter keeps the component mounted — only the id param changes)
  // correctly re-initialises the editor instead of being stuck in the state
  // left over from the previous template.
  const lastInitializedId = useRef<string | number | null>(null);
  const { data: templateData, isLoading: loadingTemplate } = useQuery({
    queryKey: ["templates", id],
    queryFn: () => fetch(`/api/templates/${id}`, { credentials: "include" }).then(r => r.json()),
    enabled: isEdit,
  });

  useEffect(() => {
    if (templateData && lastInitializedId.current !== (id ?? null)) {
      lastInitializedId.current = id ?? null;
      setName(templateData.name ?? "");
      setCategory(templateData.category ?? "Outreach");
      setSubject(templateData.subject ?? "");
      setBodyHtml(templateData.bodyHtml ?? DEFAULT_HTML);
      if (Array.isArray(templateData.blocksJson) && templateData.blocksJson.length > 0) {
        setBlocks(templateData.blocksJson as EmailBlock[]);
        setEditorMode("design");
      } else {
        setBlocks([]);
        setEditorMode("code");
      }
    }
  }, [templateData, id]);

  // ── Load contacts for preview picker ─────────────────────────────────────
  const { data: contacts = [] } = useQuery<Contact[]>({
    queryKey: ["contacts-picker"],
    queryFn: () => fetch("/api/contacts?limit=100", { credentials: "include" })
      .then(r => r.json())
      .then(d => Array.isArray(d) ? d : (d.contacts ?? [])),
    enabled: isEdit && editorMode === "preview",
  });

  // ── Fetch server-rendered preview ─────────────────────────────────────────
  const fetchPreview = useCallback(async (
    contactId: string,
    currentBlocks: typeof blocks,
    currentBodyHtml: string,
    currentEditorMode: typeof editorMode,
  ) => {
    // Determine the best HTML source: blocks take priority when present
    const sourceHtml = currentBlocks.length > 0
      ? blocksToHtml(currentBlocks)
      : currentBodyHtml;

    // Always render client-side with sample vars when:
    //   • using sample data (not a real contact), OR
    //   • in design mode, OR
    //   • template not yet saved
    if (contactId === "__sample__" || currentEditorMode === "design" || !isEdit || !id) {
      const rendered = sourceHtml.replace(/\{\{(\w+)\}\}/g, (_, k) =>
        SAMPLE_VARS[k as keyof typeof SAMPLE_VARS] ?? `[${k}]`
      );
      setPreviewHtml(rendered);
      return;
    }

    // Saved template + real contact selected: fetch server-rendered HTML
    // (server resolves merge tags from real contact data)
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/templates/${id}/preview`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: parseInt(contactId) }),
      });
      if (!res.ok) throw new Error("Preview failed");
      setPreviewHtml(await res.text());
    } catch {
      toast({ title: "Failed to load preview", variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  }, [id, isEdit, toast]);

  useEffect(() => {
    if (editorMode === "preview") {
      fetchPreview(previewContactId, blocks, bodyHtml, editorMode);
    }
  // Re-run whenever the contact picker changes or the mode switches to preview
  }, [editorMode, previewContactId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When switching Design → Code, sync HTML from blocks
  const handleModeSwitch = (mode: "design" | "code" | "preview") => {
    if (editorMode === "design" && mode === "code" && blocks.length > 0) {
      setBodyHtml(blocksToHtml(blocks));
    }
    setEditorMode(mode);
  };

  // ── Save mutation ─────────────────────────────────────────────────────────
  const mutation = useMutation({
    mutationFn: (data: any) => {
      const url = isEdit ? `/api/templates/${id}` : "/api/templates";
      const method = isEdit ? "PATCH" : "POST";
      return fetch(url, {
        method, credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    },
    onSuccess: (tpl) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast({ title: isEdit ? "Template saved" : "Template created" });
      if (!isEdit) navigate(`/templates/${tpl.id}`);
    },
    onError: () => toast({ title: "Failed to save template", variant: "destructive" }),
  });

  function insertMergeTag(tag: string) {
    const el = textareaRef.current;
    if (!el) { setBodyHtml(prev => prev + tag); return; }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setBodyHtml(bodyHtml.substring(0, start) + tag + bodyHtml.substring(end));
    setTimeout(() => {
      el.selectionStart = el.selectionEnd = start + tag.length;
      el.focus();
    }, 0);
  }

  function insertSubjectTag(tag: string) { setSubject(prev => prev + tag); }

  const handleSave = () => {
    if (!name.trim() || !subject.trim()) {
      toast({ title: "Name and subject are required", variant: "destructive" });
      return;
    }
    if (editorMode === "design") {
      const html = blocks.length > 0 ? blocksToHtml(blocks) : bodyHtml;
      mutation.mutate({
        name, category, subject,
        bodyHtml: html,
        bodyText: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        blocksJson: blocks,
      });
    } else {
      mutation.mutate({
        name, category, subject,
        bodyHtml,
        bodyText: bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      });
    }
  };

  const handleSendTest = () => {
    if (!isEdit || !id) return;
    setSendTestOpen(true);
  };

  const handleSendTestSubmit = async () => {
    if (!isEdit || !id) return;
    const validEmails = testEmails.map(e => e.trim()).filter(e => e.includes("@"));
    if (validEmails.length === 0) {
      toast({ title: "Enter at least one valid email address", variant: "destructive" });
      return;
    }
    setSendTestPending(true);
    setSendTestOpen(false);
    try {
      const body: Record<string, unknown> = { emails: validEmails };
      if (previewContactId !== "__sample__") body.contactId = parseInt(previewContactId);
      const res = await fetch(`/api/templates/${id}/send-test`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.sent) {
        toast({ title: "Test email sent", description: `Delivered to ${data.to}` });
      } else {
        toast({ title: "Email not sent — Resend not configured", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to send test email", variant: "destructive" });
    } finally {
      setSendTestPending(false);
    }
  };

  if (isEdit && loadingTemplate) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  const staticPreviewHtml = bodyHtml.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    SAMPLE_VARS[k as keyof typeof SAMPLE_VARS] ?? `[${k}]`
  );
  const staticPreviewSubject = subject.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    SAMPLE_VARS[k as keyof typeof SAMPLE_VARS] ?? `[${k}]`
  );

  return (
    <>
      {/* ── Layout Picker Dialog ──────────────────────────────────────────── */}
      <Dialog open={layoutPickerOpen} onOpenChange={setLayoutPickerOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a starting layout</DialogTitle>
            <DialogDescription>Pick a layout to start with, or start from a blank canvas.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 pt-2">
            {LAYOUTS.map(layout => (
              <button
                key={layout.id}
                onClick={() => {
                  setBlocks(createLayoutBlocks(layout.id));
                  setEditorMode("design");
                  setLayoutPickerOpen(false);
                }}
                className="text-left border rounded-xl p-4 hover:border-indigo-400 hover:bg-indigo-50 transition-all group"
              >
                <div className="h-16 bg-gray-50 rounded-lg mb-3 flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
                  <div className="text-center leading-tight text-gray-400 text-xs font-mono whitespace-pre group-hover:text-indigo-500">
                    {layout.preview}
                  </div>
                </div>
                <p className="font-medium text-sm text-foreground">{layout.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{layout.desc}</p>
              </button>
            ))}
          </div>
          <Button
            variant="ghost" size="sm"
            className="w-full mt-1 text-muted-foreground"
            onClick={() => { setEditorMode("code"); setLayoutPickerOpen(false); }}
          >
            <Code2 className="w-3.5 h-3.5 mr-1.5" />
            Start with raw HTML instead
          </Button>
        </DialogContent>
      </Dialog>

      {/* ── Send Test Email Dialog ─────────────────────────────────────────── */}
      <Dialog open={sendTestOpen} onOpenChange={open => { setSendTestOpen(open); if (!open) setTestEmails([""]); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send test email</DialogTitle>
            <DialogDescription>
              Enter up to 5 email addresses to receive a test copy of this template.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {testEmails.map((email, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  type="email"
                  placeholder={`Recipient ${i + 1} email address`}
                  value={email}
                  onChange={e => setTestEmails(prev => prev.map((v, idx) => idx === i ? e.target.value : v))}
                  className="h-9 text-sm flex-1"
                />
                {testEmails.length > 1 && (
                  <Button
                    type="button" variant="ghost" size="icon"
                    className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setTestEmails(prev => prev.filter((_, idx) => idx !== i))}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
            {testEmails.length < 5 && (
              <Button
                type="button" variant="ghost" size="sm"
                className="text-xs text-muted-foreground h-8 px-2"
                onClick={() => setTestEmails(prev => [...prev, ""])}
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add recipient
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setSendTestOpen(false); setTestEmails([""]); }}>
              Cancel
            </Button>
            <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" onClick={handleSendTestSubmit} disabled={sendTestPending}>
              {sendTestPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col h-full overflow-hidden">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="border-b bg-card px-6 py-3 flex items-center gap-3 shrink-0">
          <Button variant="ghost" size="icon" onClick={() => navigate("/templates")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex-1">
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Template name..."
              className="h-8 text-sm font-medium max-w-xs"
            />
          </div>

          {/* Mode tabs */}
          <div className="flex items-center border rounded-lg overflow-hidden">
            {(["design", "code", "preview"] as const).map(mode => (
              <button
                key={mode}
                onClick={() => handleModeSwitch(mode)}
                className={cn(
                  "px-3.5 py-1.5 text-sm font-medium transition-colors flex items-center gap-1.5 capitalize",
                  editorMode === mode ? "bg-indigo-600 text-white" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {mode === "design" && <Layout className="w-3.5 h-3.5" />}
                {mode === "code" && <Code2 className="w-3.5 h-3.5" />}
                {mode}
              </button>
            ))}
          </div>

          <Button
            size="sm" className="bg-indigo-600 hover:bg-indigo-700"
            onClick={handleSave} disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            {isEdit ? "Save" : "Create Template"}
          </Button>
        </div>

        {/* ── Design mode ────────────────────────────────────────────────── */}
        {editorMode === "design" && (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Metadata bar */}
            <div className="border-b bg-card px-6 py-2.5 flex items-center gap-4 shrink-0 flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground shrink-0">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map(c => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Label className="text-xs text-muted-foreground shrink-0">Subject</Label>
                <div className="flex items-center flex-1 min-w-0 gap-2">
                  <Input
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                    placeholder="Subject line (supports merge tags)"
                    className="h-7 text-xs flex-1"
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 text-xs text-indigo-600 hover:text-indigo-700 px-2 shrink-0">
                        Insert tag <ChevronDown className="w-3 h-3 ml-1" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {MERGE_TAGS.map(t => (
                        <DropdownMenuItem key={t.tag} onClick={() => insertSubjectTag(t.tag)}>
                          <span className="font-mono text-xs text-muted-foreground mr-2">{t.tag}</span>
                          {t.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
            <EmailBlockEditor blocks={blocks} onChange={setBlocks} />
          </div>
        )}

        {/* ── Code mode ──────────────────────────────────────────────────── */}
        {editorMode === "code" && (
          <div className="flex flex-1 overflow-hidden">
            {/* Left: Editor */}
            <div className="w-1/2 border-r flex flex-col overflow-y-auto">
              <div className="p-5 space-y-4">
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Subject Line <span className="text-destructive">*</span></Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 text-xs text-indigo-600 hover:text-indigo-700 px-2">
                          Insert tag <ChevronDown className="w-3 h-3 ml-1" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {MERGE_TAGS.map(t => (
                          <DropdownMenuItem key={t.tag} onClick={() => insertSubjectTag(t.tag)}>
                            <span className="font-mono text-xs text-muted-foreground mr-2">{t.tag}</span>
                            {t.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <Input value={subject} onChange={e => setSubject(e.target.value)}
                    placeholder="e.g. Hi {{firstName}}, quick question about {{companyName}}" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>HTML Body <span className="text-destructive">*</span></Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 text-xs text-indigo-600 hover:text-indigo-700 px-2">
                          Insert merge tag <ChevronDown className="w-3 h-3 ml-1" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {MERGE_TAGS.map(t => (
                          <DropdownMenuItem key={t.tag} onClick={() => insertMergeTag(t.tag)}>
                            <span className="font-mono text-xs text-muted-foreground mr-2">{t.tag}</span>
                            {t.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <Textarea
                    ref={textareaRef}
                    value={bodyHtml}
                    onChange={e => setBodyHtml(e.target.value)}
                    className="font-mono text-xs leading-relaxed min-h-[480px] resize-y"
                    placeholder="Enter your HTML email body..."
                  />
                  <p className="text-xs text-muted-foreground">
                    Use merge tags like <code className="bg-muted px-1 rounded">{"{{firstName}}"}</code> to personalise emails.
                  </p>
                </div>
              </div>
            </div>
            {/* Right: Static preview */}
            <div className="w-1/2 flex flex-col bg-gray-100 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b bg-card text-xs text-muted-foreground shrink-0">
                <span>Live preview (sample data)</span>
              </div>
              <div className="flex-1 overflow-auto flex justify-center p-6">
                <div className="bg-white shadow-sm rounded-lg w-full max-w-lg overflow-hidden">
                  {subject && (
                    <div className="border-b px-4 py-2.5 text-sm font-medium text-foreground bg-gray-50">
                      {staticPreviewSubject}
                    </div>
                  )}
                  {/* Sandboxed iframe prevents any script execution in the preview */}
                  <iframe
                    srcDoc={staticPreviewHtml}
                    title="Email code preview"
                    className="w-full border-0"
                    style={{ minHeight: "400px", display: "block" }}
                    onLoad={e => {
                      const iframe = e.currentTarget;
                      const doc = iframe.contentDocument;
                      if (doc?.documentElement) {
                        iframe.style.height = doc.documentElement.scrollHeight + "px";
                      }
                    }}
                    sandbox=""
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Preview mode ────────────────────────────────────────────────── */}
        {editorMode === "preview" && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-2.5 border-b bg-card shrink-0 flex-wrap">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                <Select value={previewContactId} onValueChange={setPreviewContactId}>
                  <SelectTrigger className="w-56 h-8 text-sm"><SelectValue placeholder="Sample data" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__sample__">Sample data</SelectItem>
                    {contacts.map(c => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.firstName} {c.lastName} — {c.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center border rounded-md overflow-hidden">
                <button
                  onClick={() => setPreviewWidth("desktop")}
                  className={cn("px-2.5 py-1.5", previewWidth === "desktop" ? "bg-indigo-600 text-white" : "text-muted-foreground hover:bg-muted")}
                  title="Desktop"
                ><Monitor className="w-3.5 h-3.5" /></button>
                <button
                  onClick={() => setPreviewWidth("mobile")}
                  className={cn("px-2.5 py-1.5", previewWidth === "mobile" ? "bg-indigo-600 text-white" : "text-muted-foreground hover:bg-muted")}
                  title="Mobile (375px)"
                ><Smartphone className="w-3.5 h-3.5" /></button>
              </div>
              <Button variant="outline" size="sm" className="h-8"
                onClick={() => fetchPreview(previewContactId, blocks, bodyHtml, editorMode)} disabled={previewLoading}>
                {previewLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Refresh"}
              </Button>
              <div className="flex-1" />
              {isEdit && (
                <Button size="sm" className="h-8 bg-indigo-600 hover:bg-indigo-700"
                  onClick={handleSendTest} disabled={sendTestPending}>
                  {sendTestPending
                    ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    : <Send className="w-3.5 h-3.5 mr-1.5" />
                  }
                  Send test email
                </Button>
              )}
            </div>
            <div className="flex-1 overflow-auto bg-gray-100 flex justify-center p-6">
              {previewLoading ? (
                <div className="flex items-center justify-center w-full">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : previewHtml ? (
                <div
                  className="bg-white shadow-sm rounded-lg"
                  style={{ width: previewWidth === "mobile" ? "375px" : "100%", maxWidth: "650px" }}
                >
                  <iframe
                    srcDoc={previewHtml}
                    title="Email preview"
                    className="w-full border-0"
                    style={{ minHeight: "600px", display: "block" }}
                    onLoad={e => {
                      const iframe = e.currentTarget;
                      const resize = () => {
                        const doc = iframe.contentDocument;
                        if (doc?.documentElement) {
                          iframe.style.height = doc.documentElement.scrollHeight + "px";
                        }
                      };
                      resize();
                      // Re-measure after images finish loading so tall emails aren't cut off
                      iframe.contentWindow?.addEventListener("load", resize);
                      const imgs = iframe.contentDocument?.images;
                      if (imgs) {
                        Array.from(imgs).forEach(img => {
                          if (!img.complete) img.addEventListener("load", resize);
                        });
                      }
                    }}
                    sandbox=""
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center text-muted-foreground text-sm">No preview available</div>
              )}
            </div>
            {previewWidth === "mobile" && (
              <div className="text-center text-xs text-muted-foreground py-1.5 border-t bg-card">375px mobile view</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
