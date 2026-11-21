import { useState, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateAudience, useIntentScopeOptions, useIntentCompanies } from "@/hooks/use-intent";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, X, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx";
import Papa from "papaparse";

interface AudienceBuilderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultClientId?: number;
}

export function AudienceBuilderModal({ open, onOpenChange, defaultClientId }: AudienceBuilderModalProps) {
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string>("all");
  const [selectedSegments, setSelectedSegments] = useState<number[]>([]);
  const [selectedCompanies, setSelectedCompanies] = useState<{ id: number; name: string }[]>([]);
  const [companySearch, setCompanySearch] = useState("");
  const [fileData, setFileData] = useState<{ rows: any[]; mapping: Record<string, string>; fileName: string; autoMappedCount: number } | null>(null);

  useEffect(() => {
    if (open) {
      setClientId(defaultClientId ? String(defaultClientId) : "all");
    }
  }, [open, defaultClientId]);

  const { data: scopeOptions } = useIntentScopeOptions();
  const { data: companies, isLoading: companiesLoading } = useIntentCompanies({
    clientId: clientId !== "all" ? Number(clientId) : undefined,
    search: companySearch
  });

  const createMutation = useCreateAudience();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result;
      const processRows = (rows: any[], headers: string[]) => {
        if (rows.length === 0) {
          toast({ title: "Empty file", description: "No data found.", variant: "destructive" });
          return;
        }
        if (rows.length > 5000) {
          toast({ title: "File too large", description: "Maximum 5000 rows allowed.", variant: "destructive" });
          return;
        }

        const mapping: Record<string, string> = {};
        let autoMappedCount = 0;
        headers.forEach(h => {
          const l = h.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (l.includes("domain") || l.includes("website")) {
             mapping[h] = "domain";
             autoMappedCount++;
          }
          else if (l.includes("company") || l.includes("account")) {
             mapping[h] = "account_name";
             autoMappedCount++;
          }
        });
        setFileData({ rows, mapping, fileName: f.name, autoMappedCount });
      };

      if (f.name.toLowerCase().endsWith('.csv')) {
        const text = new TextDecoder().decode(result as ArrayBuffer);
        Papa.parse(text, { header: true, skipEmptyLines: true, complete: (res) => processRows(res.data, res.meta.fields || []) });
      } else {
        const workbook = XLSX.read(result, { type: 'array' });
        const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
        if (json.length > 0) processRows(json, Object.keys(json[0] as object));
        else toast({ title: "Empty file", description: "No data found in spreadsheet.", variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(f);
  };

  const handleCreate = () => {
    if (!name) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }

    createMutation.mutate({
      name,
      clientId: clientId !== "all" ? Number(clientId) : undefined,
      segmentIds: selectedSegments,
      companyIds: selectedCompanies.map(c => c.id),
      ...(fileData ? { rows: fileData.rows, mapping: fileData.mapping } : {})
    }, {
      onSuccess: (data) => {
        const validationMsg = data?.validationErrors?.length
          ? ` (${data.inserted} imported, ${data.failed} failed)`
          : "";
        toast({ title: "Audience created", description: `Saved successfully${validationMsg}.` });
        onOpenChange(false);
        // Reset
        setName("");
        setSelectedSegments([]);
        setSelectedCompanies([]);
        setFileData(null);
      },
      onError: (err) => {
        toast({ title: "Failed to create", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Build New Audience</DialogTitle>
          <DialogDescription>Combine segments, specific companies, and uploaded lists to define a precise target audience.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Audience Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 Healthcare Surge" />
            </div>
            <div className="space-y-2">
              <Label>Client Scope (Optional)</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger>
                  <SelectValue placeholder="Global (No Client)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Global (No Client)</SelectItem>
                  {scopeOptions?.clients.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-4 border-t pt-4">
            <Label className="text-base font-semibold">1. Select Segments</Label>
            <div className="max-h-32 overflow-y-auto border rounded-md p-2 grid grid-cols-2 gap-2 bg-slate-50">
              {scopeOptions?.segments.map(s => (
                <label key={s.id} className="flex items-center gap-2 p-2 hover:bg-slate-100 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedSegments.includes(s.id)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedSegments([...selectedSegments, s.id]);
                      else setSelectedSegments(selectedSegments.filter(id => id !== s.id));
                    }}
                  />
                  <span className="text-sm">{s.name} <span className="text-muted-foreground text-xs">({s.memberCount} members)</span></span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-4 border-t pt-4">
            <Label className="text-base font-semibold">2. Hand-pick Companies</Label>
            <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                <Input
                  placeholder="Search companies..."
                  value={companySearch}
                  onChange={(e) => setCompanySearch(e.target.value)}
                />
                <div className="h-32 overflow-y-auto border rounded-md p-2 bg-slate-50 space-y-1">
                  {companiesLoading ? (
                    <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
                  ) : companies?.length === 0 ? (
                    <div className="text-center text-xs text-muted-foreground p-4">No companies found</div>
                  ) : companies?.map(c => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between p-2 hover:bg-indigo-50 rounded cursor-pointer group"
                      onClick={() => {
                        if (!selectedCompanies.some(sc => sc.id === c.id)) setSelectedCompanies([...selectedCompanies, { id: c.id, name: c.name }]);
                      }}
                    >
                      <div>
                        <div className="text-sm font-medium">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.domain}</div>
                      </div>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100">+</Button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="w-1/3 flex flex-col space-y-2">
                <Label className="text-xs text-muted-foreground">Selected ({selectedCompanies.length})</Label>
                <div className="flex-1 border rounded-md p-2 bg-white overflow-y-auto space-y-1">
                  {selectedCompanies.map(c => (
                    <div key={c.id} className="flex items-center justify-between bg-indigo-50 text-indigo-700 px-2 py-1 rounded text-xs">
                      <span className="truncate mr-2">{c.name}</span>
                      <X
                        className="w-3 h-3 cursor-pointer hover:text-indigo-900"
                        onClick={() => setSelectedCompanies(selectedCompanies.filter(x => x.id !== c.id))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 border-t pt-4">
            <Label className="text-base font-semibold">3. Upload Target List</Label>
            <div
              className={cn(
                "border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center transition-colors cursor-pointer",
                fileData ? "border-emerald-300 bg-emerald-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"
              )}
              onClick={() => fileRef.current?.click()}
            >
              <input type="file" ref={fileRef} className="hidden" accept=".csv,.xls,.xlsx" onChange={handleFileChange} />
              {fileData ? (
                <>
                  <div className="w-8 h-8 rounded-full bg-emerald-200 flex items-center justify-center mb-2 text-emerald-700">
                    <CheckCircle className="w-5 h-5" />
                  </div>
                  <p className="text-sm font-semibold">{fileData.fileName}</p>
                  <p className="text-xs text-muted-foreground">{fileData.rows.length} rows loaded, {fileData.autoMappedCount} columns mapped automatically</p>
                </>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-indigo-400 mb-2" />
                  <p className="text-sm font-semibold text-foreground">Click to upload CSV/XLS</p>
                  <p className="text-xs text-muted-foreground">Will be matched by domain/name</p>
                </>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={createMutation.isPending} className="bg-indigo-600 hover:bg-indigo-700">
            {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Audience
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}