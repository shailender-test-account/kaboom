import { useRef, useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Image, FileText, Video, Music, File, Upload, Trash2,
  Copy, Check, Loader2, FolderOpen, Download, Search,
  X, ExternalLink, Pencil, Link2, SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface MediaAsset {
  id: number;
  name: string;
  objectPath: string;
  url: string;
  mimeType: string;
  format: string;
  fileSize: number | null;
  fileSizeLabel: string;
  createdAt: string;
  journeysUsed: number;
  downloadCount: number;
}

interface AssetUsage {
  journeyId: number;
  journeyName: string;
  pageId: number;
  pageTitle: string;
  sortOrder: number;
}

type FilterType = "all" | "images" | "pdfs" | "gifs" | "docs" | "video" | "other";
type SortType = "newest" | "oldest" | "name" | "size";

// ── Helpers ───────────────────────────────────────────────────────────────────
function getFilterType(asset: MediaAsset): FilterType {
  const m = asset.mimeType;
  if (m === "image/gif") return "gifs";
  if (m.startsWith("image/")) return "images";
  if (m === "application/pdf") return "pdfs";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/") || m.includes("word") || m.includes("document") || m.includes("text")) return "docs";
  return "other";
}

function FormatIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType === "image/gif") return <Image className={cn("text-pink-500", className)} />;
  if (mimeType.startsWith("image/")) return <Image className={cn("text-violet-500", className)} />;
  if (mimeType === "application/pdf") return <FileText className={cn("text-red-500", className)} />;
  if (mimeType.startsWith("video/")) return <Video className={cn("text-blue-500", className)} />;
  if (mimeType.startsWith("audio/")) return <Music className={cn("text-emerald-500", className)} />;
  return <File className={cn("text-gray-400", className)} />;
}

function FormatBadge({ format, mimeType }: { format: string; mimeType: string }) {
  const color =
    mimeType.startsWith("image/") ? "bg-violet-50 text-violet-700 border-violet-200" :
    mimeType === "application/pdf" ? "bg-red-50 text-red-700 border-red-200" :
    mimeType.startsWith("video/") ? "bg-blue-50 text-blue-700 border-blue-200" :
    "bg-gray-50 text-gray-700 border-gray-200";
  return (
    <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", color)}>
      {format}
    </span>
  );
}

function Thumbnail({ asset, size = "sm" }: { asset: MediaAsset; size?: "sm" | "lg" }) {
  const [error, setError] = useState(false);
  const dim = size === "lg" ? "w-full h-40" : "w-full h-28";
  if (asset.mimeType.startsWith("image/") && !error) {
    return (
      <div className={cn("rounded-lg overflow-hidden bg-gray-50 border", size === "sm" && "w-full h-28")}>
        <img src={asset.url} alt={asset.name} className={cn(dim, "object-cover")} onError={() => setError(true)} />
      </div>
    );
  }
  return (
    <div className={cn("rounded-lg border bg-gray-50 flex items-center justify-center", size === "lg" ? "h-40 w-full" : "h-28 w-full")}>
      <FormatIcon mimeType={asset.mimeType} className="w-10 h-10" />
    </div>
  );
}

interface UploadProgress {
  file: File;
  progress: number;
  status: "uploading" | "done" | "error";
}

// ── Asset Detail Slide-over ───────────────────────────────────────────────────
function AssetSlideOver({
  asset,
  onClose,
  onDeleted,
  onUpdated,
}: {
  asset: MediaAsset;
  onClose: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(asset.name);
  const [saving, setSaving] = useState(false);
  const [signedUrlTtl, setSignedUrlTtl] = useState("3600");
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [generatingUrl, setGeneratingUrl] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function handleSaveName() {
    setSaving(true);
    try {
      const r = await fetch(`/api/media/${asset.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["media"] });
      onUpdated();
      toast({ title: "Renamed", description: name });
    } catch {
      toast({ title: "Rename failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const { data: usage = [] } = useQuery<AssetUsage[]>({
    queryKey: ["media-usage", asset.id],
    queryFn: () => fetch(`/api/media/${asset.id}/usage`, { credentials: "include" }).then(r => r.json()),
  });

  async function handleGenerateSignedUrl() {
    setGeneratingUrl(true);
    setSignedUrl(null);
    try {
      const r = await fetch(
        `/api/storage/signed-url?objectPath=${encodeURIComponent(asset.objectPath)}&ttl=${signedUrlTtl}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setSignedUrl(data.signedUrl);
    } catch (err: any) {
      toast({ title: "Could not generate signed URL", description: err.message, variant: "destructive" });
    } finally {
      setGeneratingUrl(false);
    }
  }

  function handleCopyUrl(url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function handleDelete() {
    try {
      const r = await fetch(`/api/media/${asset.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["media"] });
      onDeleted();
      toast({ title: "Deleted", description: asset.name });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
    setDeleteOpen(false);
  }

  return (
    <Sheet open onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent className="w-[400px] sm:max-w-[400px] overflow-y-auto space-y-5 p-0">
        <SheetHeader className="px-6 pt-5 pb-4 border-b">
          <SheetTitle className="text-base truncate">{asset.name}</SheetTitle>
        </SheetHeader>
        <div className="px-6 pb-6 space-y-5">
          {/* Preview */}
          <Thumbnail asset={asset} size="lg" />

          {/* Meta */}
          <div className="flex items-center gap-2 flex-wrap">
            <FormatBadge format={asset.format} mimeType={asset.mimeType} />
            {asset.fileSizeLabel && (
              <span className="text-xs text-muted-foreground">{asset.fileSizeLabel}</span>
            )}
            {asset.downloadCount > 0 && (
              <Badge variant="secondary" className="text-xs gap-1">
                <Download className="w-3 h-3" />
                {asset.downloadCount} download{asset.downloadCount > 1 ? "s" : ""}
              </Badge>
            )}
            {asset.journeysUsed > 0 && (
              <Badge variant="secondary" className="text-xs gap-1">
                <Link2 className="w-3 h-3" />
                {asset.journeysUsed} journey{asset.journeysUsed > 1 ? "s" : ""}
              </Badge>
            )}
          </div>

          {/* Used in — component list with edit links */}
          {usage.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Used in</p>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {usage.map(u => (
                  <a
                    key={u.pageId}
                    href={`/journeys/${u.journeyId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:border-indigo-200 hover:bg-indigo-50 transition-colors group"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-foreground truncate block">{u.journeyName}</span>
                      <span className="text-muted-foreground">
                        Page {u.sortOrder + 1}{u.pageTitle ? ` · ${u.pageTitle}` : ""}
                      </span>
                    </div>
                    <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0 group-hover:text-indigo-600" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Rename */}
          <div className="space-y-1.5">
            <Label className="text-xs">File name</Label>
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                className="h-8 text-sm flex-1"
              />
              <Button
                variant="outline" size="sm" className="h-8 gap-1 text-xs shrink-0"
                onClick={handleSaveName}
                disabled={saving || name === asset.name}
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pencil className="w-3 h-3" />}
                Save
              </Button>
            </div>
          </div>

          {/* Serving URL */}
          <div className="space-y-1.5">
            <Label className="text-xs">Serving URL</Label>
            <div className="flex gap-2">
              <Input value={asset.url} readOnly className="h-8 text-xs font-mono flex-1 text-muted-foreground" />
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => handleCopyUrl(asset.url)}>
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" asChild>
                <a href={asset.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </Button>
            </div>
          </div>

          {/* Signed URL generator */}
          <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
            <Label className="text-xs font-semibold">Generate Time-Limited URL</Label>
            <div className="flex gap-2">
              <Select value={signedUrlTtl} onValueChange={setSignedUrlTtl}>
                <SelectTrigger className="h-7 text-xs flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3600" className="text-xs">1 hour</SelectItem>
                  <SelectItem value="86400" className="text-xs">24 hours</SelectItem>
                  <SelectItem value="604800" className="text-xs">7 days</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline" size="sm" className="h-7 text-xs shrink-0 gap-1"
                onClick={handleGenerateSignedUrl}
                disabled={generatingUrl}
              >
                {generatingUrl ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                Generate
              </Button>
            </div>
            {signedUrl && (
              <div className="flex gap-2 mt-1">
                <Input value={signedUrl} readOnly className="h-7 text-[10px] font-mono flex-1 text-muted-foreground" />
                <Button variant="outline" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleCopyUrl(signedUrl)}>
                  {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                </Button>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2 border-t">
            <Button
              variant="outline" size="sm" className="h-7 text-xs gap-1 flex-1"
              onClick={() => {
                const a = document.createElement("a");
                a.href = asset.url;
                a.download = asset.name;
                a.target = "_blank";
                a.click();
              }}
            >
              <Download className="w-3 h-3" /> Download
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="w-3 h-3" /> Delete
            </Button>
          </div>
        </div>

        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{asset.name}"?</AlertDialogTitle>
              <AlertDialogDescription>
                {asset.journeysUsed > 0
                  ? `This file is used in ${asset.journeysUsed} journey${asset.journeysUsed > 1 ? "s" : ""}. Removing it may break those pages.`
                  : "This action cannot be undone."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={handleDelete}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
const FILTER_TABS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "images", label: "Images" },
  { key: "gifs", label: "GIFs" },
  { key: "pdfs", label: "PDFs" },
  { key: "docs", label: "Docs" },
  { key: "video", label: "Video" },
  { key: "other", label: "Other" },
];

export default function MediaLibraryPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [filterType, setFilterType] = useState<FilterType>("all");
  const [sort, setSort] = useState<SortType>("newest");
  const [search, setSearch] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);

  const { data: assets = [], isLoading } = useQuery<MediaAsset[]>({
    queryKey: ["media"],
    queryFn: () => fetch("/api/media", { credentials: "include" }).then(r => r.json()),
  });

  const filteredAssets = useMemo(() => {
    let list = [...assets];
    if (filterType !== "all") list = list.filter(a => getFilterType(a) === filterType);
    if (search) list = list.filter(a => a.name.toLowerCase().includes(search.toLowerCase()));
    switch (sort) {
      case "oldest": list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); break;
      case "name": list.sort((a, b) => a.name.localeCompare(b.name)); break;
      case "size": list.sort((a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0)); break;
      default: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return list;
  }, [assets, filterType, search, sort]);

  async function uploadFile(file: File) {
    const id = `${file.name}-${Date.now()}`;
    setUploads(u => [...u, { file, progress: 0, status: "uploading" }]);
    try {
      const r1 = await fetch("/api/storage/uploads/request-url", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
      });
      if (!r1.ok) throw new Error("Could not get upload URL");
      const { uploadURL, objectPath } = await r1.json();

      setUploads(u => u.map(up => up.file === file ? { ...up, progress: 40 } : up));

      const r2 = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!r2.ok) throw new Error("Upload to storage failed");

      setUploads(u => u.map(up => up.file === file ? { ...up, progress: 80 } : up));

      const r3 = await fetch("/api/media", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, objectPath, mimeType: file.type || "application/octet-stream", fileSize: file.size }),
      });
      if (!r3.ok) throw new Error("Failed to save media record");

      setUploads(u => u.map(up => up.file === file ? { ...up, progress: 100, status: "done" } : up));
      qc.invalidateQueries({ queryKey: ["media"] });
      setTimeout(() => setUploads(u => u.filter(up => up.file !== file)), 2000);
    } catch (err: any) {
      setUploads(u => u.map(up => up.file === file ? { ...up, status: "error" } : up));
      toast({ title: "Upload failed", description: `${file.name}: ${err.message}`, variant: "destructive" });
      setTimeout(() => setUploads(u => u.filter(up => up.file !== file)), 3000);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    Array.from(e.target.files ?? []).forEach(uploadFile);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    Array.from(e.dataTransfer.files).forEach(uploadFile);
  }

  const anyUploading = uploads.some(u => u.status === "uploading");

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-violet-100 rounded-lg flex items-center justify-center">
            <Image className="w-5 h-5 text-violet-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Media Library</h1>
            <p className="text-sm text-muted-foreground">Images, PDFs, videos and other files</p>
          </div>
        </div>
        <Button onClick={() => fileInputRef.current?.click()} disabled={anyUploading} className="gap-2">
          {anyUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Upload Files
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.svg"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {/* Upload progress bars */}
      {uploads.length > 0 && (
        <div className="space-y-1.5 border rounded-lg p-3 bg-muted/20">
          {uploads.map((up, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground truncate flex-1">{up.file.name}</span>
              <div className="w-32 bg-gray-200 rounded-full h-1.5 shrink-0">
                <div
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-300",
                    up.status === "error" ? "bg-destructive" : up.status === "done" ? "bg-emerald-500" : "bg-indigo-600",
                  )}
                  style={{ width: `${up.progress}%` }}
                />
              </div>
              <span className={cn("text-[10px] w-12 text-right shrink-0",
                up.status === "error" ? "text-destructive" : up.status === "done" ? "text-emerald-600" : "text-muted-foreground",
              )}>
                {up.status === "done" ? "Done" : up.status === "error" ? "Error" : `${up.progress}%`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Drop zone */}
      <div
        className={cn(
          "border-2 border-dashed rounded-xl px-8 py-5 text-center transition-all cursor-pointer",
          dragOver ? "border-indigo-400 bg-indigo-50 text-indigo-600" : "border-gray-200 text-muted-foreground hover:border-indigo-300 hover:bg-gray-50/50",
        )}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="w-5 h-5 mx-auto mb-1.5 opacity-50" />
        <p className="text-sm font-medium">Drag & drop files here, or click to browse</p>
        <p className="text-xs mt-0.5 opacity-70">Images, Videos, PDFs, SVGs, Audio — multiple files at once</p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Type filters */}
        <div className="flex items-center gap-1 flex-wrap">
          {FILTER_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setFilterType(tab.key)}
              className={cn(
                "text-xs px-3 py-1.5 rounded-full border font-medium transition-all",
                filterType === tab.key
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                  : "border-gray-200 hover:border-gray-300 text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search files…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 pl-8 text-xs w-44"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-2 text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort */}
          <Select value={sort} onValueChange={v => setSort(v as SortType)}>
            <SelectTrigger className="h-8 text-xs w-36 gap-1">
              <SlidersHorizontal className="w-3 h-3" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest" className="text-xs">Newest first</SelectItem>
              <SelectItem value="oldest" className="text-xs">Oldest first</SelectItem>
              <SelectItem value="name" className="text-xs">Name A–Z</SelectItem>
              <SelectItem value="size" className="text-xs">Largest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : filteredAssets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-3 text-muted-foreground">
          <FolderOpen className="w-12 h-12 opacity-20" />
          <div>
            <p className="font-medium">{assets.length === 0 ? "No media yet" : "No results"}</p>
            <p className="text-sm mt-1">
              {assets.length === 0 ? "Upload your first file to get started" : "Try a different search or filter"}
            </p>
          </div>
          {assets.length === 0 && (
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="gap-2">
              <Upload className="w-4 h-4" /> Upload a file
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredAssets.map(asset => (
              <button
                key={asset.id}
                type="button"
                onClick={() => setSelectedAsset(asset)}
                className="group text-left bg-card border rounded-xl overflow-hidden hover:border-indigo-300 hover:shadow-sm transition-all"
              >
                <Thumbnail asset={asset} />
                <div className="p-2.5 space-y-1.5">
                  <p className="text-xs font-medium truncate text-foreground" title={asset.name}>{asset.name}</p>
                  <div className="flex items-center justify-between gap-1">
                    <FormatBadge format={asset.format} mimeType={asset.mimeType} />
                    <span className="text-[10px] text-muted-foreground">{asset.fileSizeLabel || "—"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {asset.journeysUsed > 0 ? (
                      <span className="text-[10px] text-indigo-600 flex items-center gap-0.5">
                        <Link2 className="w-2.5 h-2.5" />
                        {asset.journeysUsed}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/50">Unused</span>
                    )}
                    {asset.downloadCount > 0 && (
                      <span className="text-[10px] text-emerald-600 flex items-center gap-0.5">
                        <Download className="w-2.5 h-2.5" />
                        {asset.downloadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-center text-muted-foreground">
            {filteredAssets.length} {filteredAssets.length === 1 ? "file" : "files"}
            {filterType !== "all" || search ? ` matching your filters` : ""}
          </p>
        </>
      )}

      {/* Asset slide-over */}
      {selectedAsset && (
        <AssetSlideOver
          asset={selectedAsset}
          onClose={() => setSelectedAsset(null)}
          onDeleted={() => setSelectedAsset(null)}
          onUpdated={() => {
            qc.invalidateQueries({ queryKey: ["media"] });
          }}
        />
      )}
    </div>
  );
}
