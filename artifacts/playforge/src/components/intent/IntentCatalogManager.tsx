import { useState } from "react";
import { useIntentCatalog, useCreateCatalogItem, useUpdateCatalogItem, useDeleteCatalogItem } from "@/hooks/use-intent";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, Edit2, ChevronRight, Package, Grid, ListTree } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export function IntentCatalogManager() {
  const { data: catalog, isLoading } = useIntentCatalog();
  const createMutation = useCreateCatalogItem();
  const updateMutation = useUpdateCatalogItem();
  const deleteMutation = useDeleteCatalogItem();
  const { toast } = useToast();

  const [expandedCategory, setExpandedCategory] = useState<number | null>(null);
  const [expandedSubcategory, setExpandedSubcategory] = useState<number | null>(null);

  const [editModal, setEditModal] = useState<{ open: boolean, type: 'category' | 'subcategory' | 'product', id?: number, parentId?: number, initialName: string }>({
    open: false, type: 'category', initialName: ''
  });

  const [deleteModal, setDeleteModal] = useState<{ open: boolean, type: 'category' | 'subcategory' | 'product', id?: number }>({
    open: false, type: 'category'
  });

  const handleSave = () => {
    if (!editModal.initialName) return;

    if (editModal.id) {
      const data: any = { name: editModal.initialName };
      if (editModal.type === 'subcategory') data.categoryId = editModal.parentId;
      if (editModal.type === 'product') {
        data.categoryId = expandedCategory;
        data.subcategoryId = editModal.parentId;
      }

      updateMutation.mutate({
        type: editModal.type,
        id: editModal.id,
        data
      }, {
        onSuccess: () => setEditModal({ ...editModal, open: false }),
        onError: (err) => toast({ title: "Failed to update", description: err.message, variant: "destructive" })
      });
    } else {
      const data: any = { name: editModal.initialName };
      if (editModal.type === 'subcategory') data.categoryId = editModal.parentId;
      if (editModal.type === 'product') {
        data.categoryId = expandedCategory;
        data.subcategoryId = editModal.parentId;
        data.active = true;
      }

      createMutation.mutate({
        type: editModal.type,
        data
      }, {
        onSuccess: () => setEditModal({ ...editModal, open: false }),
        onError: (err) => toast({ title: "Failed to create", description: err.message, variant: "destructive" })
      });
    }
  };

  const confirmDelete = () => {
    if (deleteModal.id) {
      deleteMutation.mutate({ type: deleteModal.type, id: deleteModal.id }, {
        onSuccess: () => {
          setDeleteModal({ ...deleteModal, open: false });
          if (deleteModal.type === 'category' && expandedCategory === deleteModal.id) {
            setExpandedCategory(null);
            setExpandedSubcategory(null);
          }
          if (deleteModal.type === 'subcategory' && expandedSubcategory === deleteModal.id) {
            setExpandedSubcategory(null);
          }
        },
        onError: (err) => {
          toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  if (isLoading) return <div className="p-4 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>;

  return (
    <Card className="shadow-xs border mt-6">
      <CardHeader className="border-b bg-muted/20 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Product Catalog</CardTitle>
            <CardDescription>Manage categories, subcategories, and products for intent tracking.</CardDescription>
          </div>
          <Button data-testid="button-add-category" variant="outline" size="sm" onClick={() => setEditModal({ open: true, type: 'category', initialName: '' })}>
            <Plus className="w-4 h-4 mr-2" /> Add Category
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex flex-col md:flex-row h-[600px] md:h-[400px]">
          {/* Categories */}
          <div className="w-full md:w-1/3 border-b md:border-b-0 md:border-r overflow-y-auto bg-slate-50 flex-[1_1_0]">
            <div className="p-3 text-xs font-semibold text-slate-500 uppercase flex items-center gap-2">
              <Grid className="w-3 h-3" /> Categories
            </div>
            {(catalog?.categories || []).length === 0 && (
              <div className="text-xs text-center text-slate-400 p-8">No categories added</div>
            )}
            {(catalog?.categories || []).map((cat: any) => (
              <div
                key={cat.id}
                className={cn(
                  "px-4 py-2 flex items-center justify-between cursor-pointer border-l-2 transition-colors group",
                  expandedCategory === cat.id ? "bg-white border-indigo-600 font-medium" : "border-transparent hover:bg-slate-100"
                )}
                onClick={() => {
                  setExpandedCategory(cat.id);
                  setExpandedSubcategory(null);
                }}
              >
                <span className="truncate pr-2">{cat.name}</span>
                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                  <Edit2 className="w-3 h-3 text-slate-400 hover:text-indigo-600" onClick={(e) => { e.stopPropagation(); setEditModal({ open: true, type: 'category', id: cat.id, initialName: cat.name }); }} />
                  <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-600" onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, type: 'category', id: cat.id }); }} />
                </div>
                <ChevronRight className={cn("w-4 h-4 text-slate-400 ml-2", expandedCategory === cat.id ? "text-indigo-600" : "")} />
              </div>
            ))}
          </div>

          {/* Subcategories */}
          <div className="w-full md:w-1/3 border-b md:border-b-0 md:border-r overflow-y-auto bg-white flex-[1_1_0]">
            <div className="p-3 text-xs font-semibold text-slate-500 uppercase flex items-center gap-2">
              <ListTree className="w-3 h-3" /> Subcategories
            </div>
            {!expandedCategory ? (
              <div className="text-xs text-center text-slate-400 p-8">Select a category</div>
            ) : (
              <>
                <div className="px-4 pb-2">
                  <Button data-testid="button-add-subcategory" variant="ghost" size="sm" className="w-full text-indigo-600 border border-indigo-100 border-dashed" onClick={() => setEditModal({ open: true, type: 'subcategory', parentId: expandedCategory, initialName: '' })}>
                    <Plus className="w-3 h-3 mr-2" /> Add Subcategory
                  </Button>
                </div>
                {(catalog?.subcategories || []).filter((s: any) => s.categoryId === expandedCategory).length === 0 && (
                  <div className="text-xs text-center text-slate-400 p-4">No subcategories</div>
                )}
                {(catalog?.subcategories || []).filter((s: any) => s.categoryId === expandedCategory).map((sub: any) => (
                  <div
                    key={sub.id}
                    className={cn(
                      "px-4 py-2 flex items-center justify-between cursor-pointer border-l-2 transition-colors group",
                      expandedSubcategory === sub.id ? "bg-indigo-50 border-indigo-600 font-medium text-indigo-900" : "border-transparent hover:bg-slate-50"
                    )}
                    onClick={() => setExpandedSubcategory(sub.id)}
                  >
                    <span className="truncate pr-2">{sub.name}</span>
                    <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                      <Edit2 className="w-3 h-3 text-slate-400 hover:text-indigo-600" onClick={(e) => { e.stopPropagation(); setEditModal({ open: true, type: 'subcategory', id: sub.id, parentId: expandedCategory, initialName: sub.name }); }} />
                      <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-600" onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, type: 'subcategory', id: sub.id }); }} />
                    </div>
                    <ChevronRight className={cn("w-4 h-4 text-slate-400 ml-2", expandedSubcategory === sub.id ? "text-indigo-600" : "")} />
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Products */}
          <div className="w-full md:w-1/3 overflow-y-auto bg-slate-50 flex-[1_1_0]">
            <div className="p-3 text-xs font-semibold text-slate-500 uppercase flex items-center gap-2">
              <Package className="w-3 h-3" /> Products
            </div>
            {!expandedSubcategory ? (
              <div className="text-xs text-center text-slate-400 p-8">Select a subcategory</div>
            ) : (
              <>
                <div className="px-4 pb-2">
                  <Button data-testid="button-add-product" variant="ghost" size="sm" className="w-full text-emerald-600 border border-emerald-100 border-dashed" onClick={() => setEditModal({ open: true, type: 'product', parentId: expandedSubcategory, initialName: '' })}>
                    <Plus className="w-3 h-3 mr-2" /> Add Product
                  </Button>
                </div>
                {(catalog?.products || []).filter((p: any) => p.subcategoryId === expandedSubcategory).length === 0 && (
                  <div className="text-xs text-center text-slate-400 p-4">No products</div>
                )}
                {(catalog?.products || []).filter((p: any) => p.subcategoryId === expandedSubcategory).map((prod: any) => (
                  <div key={prod.id} className="px-4 py-2 border-b border-slate-100 bg-white group hover:bg-slate-50 transition-colors">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="text-sm font-medium">{prod.name}</div>
                      </div>
                      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity gap-1 mt-0.5">
                        <Edit2 className="w-3 h-3 text-slate-400 hover:text-indigo-600 cursor-pointer" onClick={() => setEditModal({ open: true, type: 'product', id: prod.id, parentId: expandedSubcategory, initialName: prod.name })} />
                        <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-600 cursor-pointer" onClick={() => setDeleteModal({ open: true, type: 'product', id: prod.id })} />
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </CardContent>

      <Dialog open={editModal.open} onOpenChange={(o) => setEditModal({ ...editModal, open: o })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editModal.id ? 'Edit' : 'Add'} {editModal.type}</DialogTitle>
            <DialogDescription>
              {editModal.id ? "Update" : "Create"} this {editModal.type} in the Intent product catalog.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={editModal.initialName}
                onChange={(e) => setEditModal({ ...editModal, initialName: e.target.value })}
                placeholder={`Enter ${editModal.type} name...`}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModal({ ...editModal, open: false })}>Cancel</Button>
            <Button data-testid="button-save-catalog-item" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteModal.open} onOpenChange={(o) => setDeleteModal({ ...deleteModal, open: o })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the {deleteModal.type}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}