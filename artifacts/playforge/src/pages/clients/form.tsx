import { useForm } from "react-hook-form";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Loader2 } from "lucide-react";

export interface ClientFormValues {
  name: string;
  domain: string;
  industry: string;
  companySize: string;
  website: string;
  description: string;
  icpNotes: string;
}

const INDUSTRIES = [
  "Technology", "Finance", "Healthcare", "Manufacturing",
  "Retail", "Education", "Real Estate", "Media", "Other",
];

const COMPANY_SIZES = [
  "1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+",
];

interface ClientFormProps {
  defaultValues?: Partial<ClientFormValues>;
  onSubmit: (values: ClientFormValues) => void;
  isLoading?: boolean;
  title: string;
  submitLabel: string;
}

export function ClientForm({ defaultValues, onSubmit, isLoading, title, submitLabel }: ClientFormProps) {
  const [, navigate] = useLocation();
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<ClientFormValues>({
    defaultValues: {
      name: "",
      domain: "",
      industry: "",
      companySize: "",
      website: "",
      description: "",
      icpNotes: "",
      ...defaultValues,
    },
  });

  const industry = watch("industry");
  const companySize = watch("companySize");

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/clients")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">Fill in the client details below</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardContent className="pt-6 space-y-4">
            <h2 className="text-sm font-semibold text-foreground">Basic Information</h2>

            <div className="space-y-1.5">
              <Label htmlFor="name" className="text-xs font-medium">
                Company Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                placeholder="e.g. Acme Corp"
                className="h-9 text-sm"
                {...register("name", { required: "Company name is required" })}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="domain" className="text-xs font-medium">Domain</Label>
                <Input
                  id="domain"
                  placeholder="e.g. acmecorp.com"
                  className="h-9 text-sm"
                  {...register("domain")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="website" className="text-xs font-medium">Website URL</Label>
                <Input
                  id="website"
                  placeholder="https://acmecorp.com"
                  className="h-9 text-sm"
                  {...register("website")}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Industry</Label>
                <Select value={industry} onValueChange={(v) => setValue("industry", v)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select industry" />
                  </SelectTrigger>
                  <SelectContent>
                    {INDUSTRIES.map((i) => (
                      <SelectItem key={i} value={i}>{i}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Company Size</Label>
                <Select value={companySize} onValueChange={(v) => setValue("companySize", v)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select size" />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPANY_SIZES.map((s) => (
                      <SelectItem key={s} value={s}>{s} employees</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description" className="text-xs font-medium">Description</Label>
              <Textarea
                id="description"
                placeholder="Brief description of the client and their business..."
                className="text-sm resize-none"
                rows={3}
                {...register("description")}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">ICP Notes</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ideal customer profile — key decision makers, pain points, goals
              </p>
            </div>
            <div className="space-y-1.5">
              <Textarea
                id="icpNotes"
                placeholder="e.g. Decision maker: VP of Marketing. Pain points: lead attribution. Looking for: pipeline visibility tools..."
                className="text-sm resize-none"
                rows={4}
                {...register("icpNotes")}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => navigate("/clients")}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isLoading}>
            {isLoading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
