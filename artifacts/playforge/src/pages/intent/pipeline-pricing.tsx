import { useState, useEffect, useRef } from "react";
import { usePipelinePricing, useUpdatePipelinePricing } from "@/hooks/use-intent";
import { IntentPageHeader } from "@/components/intent/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Save, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function PipelinePricingPage() {
  const { data, isLoading, isError } = usePipelinePricing();
  const updatePricing = useUpdatePipelinePricing();
  const { toast } = useToast();
  
  const [prices, setPrices] = useState<Record<number, number>>({});
  const initRef = useRef(false);

  useEffect(() => {
    if (data && !initRef.current) {
      const p: Record<number, number> = {};
      data.categories.forEach((cat: any) => {
        cat.products.forEach((prod: any) => {
          p[prod.id] = prod.averageUnitPrice;
        });
      });
      setPrices(p);
      initRef.current = true;
    }
  }, [data]);

  const handlePriceChange = (productId: number, val: string) => {
    const num = parseFloat(val);
    setPrices(prev => ({
      ...prev,
      [productId]: isNaN(num) ? 0 : num
    }));
  };

  const handleSave = () => {
    if (!data) return;
    
    const updates = Object.entries(prices).map(([id, price]) => ({
      productId: Number(id),
      averageUnitPrice: price
    }));
    
    updatePricing.mutate({ currency: data.currency || "INR", prices: updates }, {
      onSuccess: () => {
        toast({
          title: "Pricing updated",
          description: "Pipeline pricing configuration has been saved successfully.",
        });
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Failed to save",
          description: "There was an error updating the pipeline pricing.",
        });
      }
    });
  };

  const currencySymbol = data?.currency === "USD" ? "$" : "₹";

  return (
    <div className="flex flex-col min-h-[100dvh] font-sans bg-[#F6F7F5]">
      <IntentPageHeader 
        title="Pipeline Pricing Configuration"
        subtitle="Set the average unit price for products to calculate potential pipeline value across all matched accounts."
        breadcrumbs="INTENT ENGINE"
        showUtilities={false}
        actions={
          <Button data-testid="button-save-pipeline-pricing" onClick={handleSave} disabled={updatePricing.isPending || isLoading} className="bg-stone-900 hover:bg-stone-800 text-white font-bold h-8 text-xs">
            <Save className="w-3.5 h-3.5 mr-2" />
            {updatePricing.isPending ? "Saving..." : "Save Pricing"}
          </Button>
        }
      />
      
      <div className="p-4 md:p-6 max-w-[1000px] mx-auto w-full">
        {isError ? (
           <div className="bg-rose-50 border border-rose-200 rounded-xl p-8 flex flex-col items-center justify-center text-rose-600 shadow-sm">
              <AlertCircle className="w-10 h-10 mb-3 opacity-50" />
              <p className="font-bold text-sm">Failed to load pricing data</p>
              <p className="text-xs mt-1 opacity-80">Check your connection and try again.</p>
           </div>
        ) : isLoading ? (
           <div className="space-y-6">
             <Skeleton className="h-64 w-full rounded-xl" />
             <Skeleton className="h-64 w-full rounded-xl" />
           </div>
        ) : (
           <div className="space-y-6 pb-10">
             {data?.categories.map((category: any) => (
               <div key={category.id} className="bg-white border border-stone-200 rounded-xl shadow-sm overflow-hidden">
                 <div className="px-5 py-4 border-b border-stone-200 bg-stone-50/80 flex items-center justify-between">
                    <h3 className="font-bold text-stone-900 text-sm">{category.name}</h3>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-stone-500 bg-white border border-stone-200 px-2 py-1 rounded shadow-sm">
                      {category.products.length} Products
                    </span>
                 </div>
                 <div className="p-0">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                      <thead className="bg-white text-[10px] font-bold text-stone-400 uppercase tracking-widest border-b border-stone-100">
                        <tr>
                          <th className="px-5 py-3 w-2/3">Product Name</th>
                          <th className="px-5 py-3 w-1/3">Average Unit Price ({data.currency || "INR"})</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100 bg-white">
                        {category.products.length === 0 ? (
                          <tr>
                            <td colSpan={2} className="px-5 py-8 text-center text-xs font-medium text-stone-500 bg-stone-50/30">
                              No products mapped to this category.
                            </td>
                          </tr>
                        ) : (
                          category.products.map((product: any) => (
                            <tr key={product.id} className="hover:bg-stone-50/50 transition-colors">
                              <td className="px-5 py-3.5 font-semibold text-stone-800 text-xs">
                                {product.name}
                              </td>
                              <td className="px-5 py-2.5">
                                <div className="relative max-w-[220px]">
                                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-xs font-bold pointer-events-none">
                                    {currencySymbol}
                                  </span>
                                  <Input 
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={prices[product.id] ?? ""}
                                    onChange={(e) => handlePriceChange(product.id, e.target.value)}
                                    className="pl-7 h-8 text-xs font-bold bg-white border-stone-200 focus-visible:ring-emerald-500 focus-visible:border-emerald-500 shadow-sm"
                                    data-testid={`input-price-${product.id}`}
                                  />
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                 </div>
               </div>
             ))}
           </div>
        )}
      </div>
    </div>
  );
}
