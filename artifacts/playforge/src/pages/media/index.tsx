import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Image, FileText, Video, Music, File, Upload, Trash2,
  Copy, Check, Link2, Loader2, FolderOpen, Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
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
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function FormatIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith("image/")) return <Image className={cn("text-violet-500", className)} />;
  if (mimeType === "application/pdf") return <FileText className={cn("text-red-500", className)} />;
  if (mimeType.startsWith("video/")) return <Video className={cn("text-blue-500", className)} />;
  if (mimeType.startsWith("audio/")) return <Music className={cn("text-emerald-500", className)} />;
  return <File className={cn("text-gray-400", className)} />;
}

function FormatBadge({ format, mimeType }: { format: string; mimeType: string }) {
  const colorMap: Record<string, string> = {
    PNG: "bg-violet-50 text-violet-700 border-violet-200",
    JPG: "bg-violet-50 text-violet-700 border-violet-200",
    GIF: "bg-violet-50 text-violet-700 border-violet-200",
    WEBP: "bg-violet-50 text-violet-700 border-violet-200",
    SVG: "bg-violet-50 text-violet-700 border-violet-200",
    PDF: "bg-red-50 text-red-700 border-red-200",
    MP4: "bg-blue-50 text-blue-700 border-blue-200",
    WEBM: "bg-blue-50 text-blue-700 border-blue-200",
    MOV: "bg-blue-50 text-blue-700 border-blue-200",
    MP3: "bg-emerald-50 text-emerald-700 border-emerald-200",
    WAV: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded border",
      colorMap[format] ?? "bg-gray-50 text-gray-700 border-gray-200",
    )}>
      <FormatIcon mimeType={mimeType} className="w-3 h-3" />
      {format}
    </span>
  );
}

function Thumbnail({ asset }: { asset: MediaAsset }) {
  const [error, setError] = useState(false);
  if (asset.mimeType.startsWith("image/") && !error) {
    return (
      <div className="w-12 h-10 rounded-md overflow-hidden border border-gray-100 bg-gray-50 shrink-0 flex items-center justify-center">
        <img
          src={asset.url}
          alt={asset.name}
          className="w-full h-full object-cover"
          onError={() => setError(true)}
        />
      </div>
    );
  }
  return (
    <div className="w-12 h-10 rounded-md border border-gray-100 bg-gray-50 shrink-0 flex items-center justify-center">
      <FormatIcon mimeType={asset.mimeType} className="w-5 h-5" />
    </div>
  );
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={handleCopy}
      title="Copy URL"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
    </Button>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function MediaPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const { data: assets = [], isLoading } = useQuery<MediaAsset[]>({
    queryKey: ["media"],
    queryFn: () => fetch("/api/media", { credentials: "include" }).then(r => r.json()),
  });

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      // Step 1: get presigned URL
      const r1 = await fetch("/api/storage/uploads/request-url", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
      });
      if (!r1.ok) throw new Error("Could not generate upload URL");
      const { uploadURL, objectPath } = await r1.json();

      // Step 2: PUT file directly to GCS via signed URL
      const r2 = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!r2.ok) throw new Error("Upload to storage failed");

      // Step 3: save metadata in our DB
      const r3 = await fetch("/api/media", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          objectPath,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
        }),
      });
      if (!r3.ok) throw new Error("Failed to save media record");

      qc.invalidateQueries({ queryKey: ["media"] });
      toast({ title: "Uploaded", description: file.name });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    files.forEach(uploadFile);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    files.forEach(uploadFile);
  }

  async function handleDelete(asset: MediaAsset) {
    if (!confirm(`Delete "${asset.name}"?`)) return;
    try {
      const r = await fetch(`/api/media/${asset.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["media"] });
      toast({ title: "Deleted", description: asset.name });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Media Hub</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Upload and manage images, videos, PDFs, and logos used across your journeys
          </p>
        </div>
        <div className="flex items-center gap-2">
          {uploading && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading…
            </div>
          )}
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="gap-2"
          >
            <Upload className="w-4 h-4" />
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
      </div>

      {/* Drop zone (shown when dragging) */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          "border-2 border-dashed rounded-xl px-8 py-6 text-center transition-all cursor-pointer",
          dragOver
            ? "border-indigo-400 bg-indigo-50 text-indigo-600"
            : "border-gray-200 text-muted-foreground hover:border-indigo-300 hover:bg-gray-50/50",
        )}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm font-medium">Drag & drop files here, or click to browse</p>
        <p className="text-xs mt-1 opacity-70">Images, Videos, PDFs, SVGs, Audio files</p>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading media…
        </div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-3 text-muted-foreground">
          <FolderOpen className="w-12 h-12 opacity-20" />
          <div>
            <p className="font-medium">No media yet</p>
            <p className="text-sm mt-1">Upload your first file to get started</p>
          </div>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="mt-2 gap-2">
            <Upload className="w-4 h-4" />
            Upload a file
          </Button>
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-16 pl-4">Preview</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Format</TableHead>
                <TableHead className="w-24">Size</TableHead>
                <TableHead className="w-32">Uploaded</TableHead>
                <TableHead className="w-32">Journeys Used</TableHead>
                <TableHead className="w-28 text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.map((asset) => (
                <TableRow key={asset.id} className="group">
                  {/* Thumbnail */}
                  <TableCell className="pl-4 py-3">
                    <Thumbnail asset={asset} />
                  </TableCell>

                  {/* Name */}
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate max-w-xs" title={asset.name}>
                        {asset.name}
                      </span>
                    </div>
                  </TableCell>

                  {/* Format */}
                  <TableCell className="py-3">
                    <FormatBadge format={asset.format} mimeType={asset.mimeType} />
                  </TableCell>

                  {/* Size */}
                  <TableCell className="py-3">
                    <span className="text-sm text-muted-foreground">
                      {asset.fileSizeLabel || "—"}
                    </span>
                  </TableCell>

                  {/* Uploaded */}
                  <TableCell className="py-3">
                    <span className="text-sm text-muted-foreground">
                      {formatDate(asset.createdAt)}
                    </span>
                  </TableCell>

                  {/* Journeys Used */}
                  <TableCell className="py-3">
                    {asset.journeysUsed > 0 ? (
                      <Badge variant="secondary" className="gap-1.5 text-xs font-medium">
                        <Link2 className="w-3 h-3" />
                        {asset.journeysUsed} {asset.journeysUsed === 1 ? "journey" : "journeys"}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground/60">Not used</span>
                    )}
                  </TableCell>

                  {/* Actions */}
                  <TableCell className="py-3 pr-4">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <CopyButton url={asset.url} />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        title="Download"
                        onClick={() => {
                          const a = document.createElement("a");
                          a.href = asset.url;
                          a.download = asset.name;
                          a.target = "_blank";
                          a.rel = "noreferrer noopener";
                          a.click();
                        }}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(asset)}
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Footer summary */}
          <div className="border-t px-4 py-2.5 bg-muted/20 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {assets.length} {assets.length === 1 ? "file" : "files"}
            </span>
            <span className="text-xs text-muted-foreground">
              Click Copy to get a URL you can paste into any journey page
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
