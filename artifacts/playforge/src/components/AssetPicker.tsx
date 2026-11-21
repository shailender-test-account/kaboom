import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, Search, Check, Loader2, Image, FileText, Video, File, X } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

export interface PickedAsset {
  assetId: number;
  filename: string;
  sizeBytes: number;
  url: string;
}

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
}

function AssetIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith("image/")) return <Image className={cn("text-violet-500", className)} />;
  if (mimeType === "application/pdf") return <FileText className={cn("text-red-500", className)} />;
  if (mimeType.startsWith("video/")) return <Video className={cn("text-blue-500", className)} />;
  return <File className={cn("text-gray-400", className)} />;
}

interface AssetPickerProps {
  value?: PickedAsset | null;
  onChange: (asset: PickedAsset | null) => void;
  accept?: string;
  label?: string;
}

export function AssetPicker({ value, onChange, accept = "*", label }: AssetPickerProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState<"all" | "images" | "pdfs" | "video" | "other">("all");

  const { data: assets = [], isLoading } = useQuery<MediaAsset[]>({
    queryKey: ["media"],
    queryFn: () => fetch("/api/media", { credentials: "include" }).then(r => r.json()),
  });

  const filtered = assets.filter(a => {
    if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (libraryFilter === "images") return a.mimeType.startsWith("image/");
    if (libraryFilter === "pdfs") return a.mimeType === "application/pdf";
    if (libraryFilter === "video") return a.mimeType.startsWith("video/");
    if (libraryFilter === "other") return !a.mimeType.startsWith("image/") && a.mimeType !== "application/pdf" && !a.mimeType.startsWith("video/");
    return true;
  });

  async function uploadFile(file: File) {
    setUploading(true);
    setUploadProgress(0);
    try {
      const r1 = await fetch("/api/storage/uploads/request-url", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
      });
      if (!r1.ok) throw new Error("Could not get upload URL");
      const { uploadURL, objectPath } = await r1.json();
      setUploadProgress(30);

      const r2 = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!r2.ok) throw new Error("Upload failed");
      setUploadProgress(80);

      const r3 = await fetch("/api/media", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, objectPath, mimeType: file.type || "application/octet-stream", fileSize: file.size }),
      });
      if (!r3.ok) throw new Error("Failed to save record");
      const media = await r3.json();
      setUploadProgress(100);

      qc.invalidateQueries({ queryKey: ["media"] });
      onChange({ assetId: media.id, filename: file.name, sizeBytes: file.size, url: media.url });
      toast({ title: "Uploaded", description: file.name });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  if (value) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-md bg-white border flex items-center justify-center shrink-0">
          <File className="w-4 h-4 text-emerald-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-emerald-900 truncate">{value.filename}</p>
          <p className="text-xs text-emerald-600">
            {value.sizeBytes ? `${(value.sizeBytes / 1024).toFixed(1)} KB` : "Selected"}
          </p>
        </div>
        <Button
          variant="ghost" size="icon" className="h-7 w-7 text-emerald-600 hover:text-destructive shrink-0"
          onClick={() => onChange(null)}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
      <Tabs defaultValue="upload">
        <TabsList className="h-7 text-xs">
          <TabsTrigger value="upload" className="text-xs h-6 px-3">Upload New</TabsTrigger>
          <TabsTrigger value="library" className="text-xs h-6 px-3">Pick from Library</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="mt-2">
          <div
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all",
              dragOver ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50/50",
              uploading && "pointer-events-none opacity-60",
            )}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !uploading && fileInputRef.current?.click()}
          >
            {uploading ? (
              <div className="space-y-2">
                <Loader2 className="w-5 h-5 mx-auto animate-spin text-indigo-600" />
                <p className="text-xs text-muted-foreground">Uploading…</p>
                {uploadProgress !== null && (
                  <div className="w-full bg-gray-200 rounded-full h-1.5 max-w-32 mx-auto">
                    <div
                      className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <>
                <Upload className="w-5 h-5 mx-auto mb-1.5 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">Drop file here or click to browse</p>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }}
          />
        </TabsContent>

        <TabsContent value="library" className="mt-2 space-y-2">
          {/* Filter row */}
          <div className="flex items-center gap-1 flex-wrap">
            {(["all", "images", "pdfs", "video", "other"] as const).map(f => {
              const labels: Record<string, string> = { all: "All", images: "Images", pdfs: "PDFs", video: "Video", other: "Other" };
              const active = libraryFilter === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setLibraryFilter(f)}
                  className={cn(
                    "text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all",
                    active ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 text-muted-foreground hover:border-gray-300",
                  )}
                >
                  {labels[f]}
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search files…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-center text-muted-foreground py-4">No files found</p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 max-h-44 overflow-y-auto">
              {filtered.map(asset => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => onChange({ assetId: asset.id, filename: asset.name, sizeBytes: asset.fileSize ?? 0, url: asset.url })}
                  className="group relative rounded-md border border-gray-200 bg-gray-50 overflow-hidden hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors text-left p-1.5 space-y-1"
                >
                  {asset.mimeType.startsWith("image/") ? (
                    <div className="w-full h-10 rounded overflow-hidden bg-white border">
                      <img src={asset.url} alt={asset.name} className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="w-full h-10 rounded border bg-white flex items-center justify-center">
                      <AssetIcon mimeType={asset.mimeType} className="w-4 h-4" />
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground truncate leading-none">{asset.name}</p>
                </button>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
