#!/usr/bin/env bash
# Builds a minimal libgbm.so.1 stub for Playwright chromium headless on NixOS/Replit.
# The real GBM (Mesa DRM) is missing from the container; chromium headless with
# --enable-unsafe-swiftshader never actually calls these functions, so returning
# NULL/0 everywhere is safe.
set -euo pipefail
OUTDIR="${1:-/tmp}"
cat > "$OUTDIR/stub_gbm.c" << 'CSRC'
#include <stdint.h>
#include <stddef.h>
typedef struct gbm_device  gbm_device;
typedef struct gbm_bo      gbm_bo;
typedef union  { void* ptr; int32_t s32; uint32_t u32; int64_t s64; uint64_t u64; } gbm_bo_handle;
struct gbm_device { int fd; };
struct gbm_bo     { uint32_t w, h; };
gbm_device*   gbm_create_device(int fd)                             { return NULL; }
void          gbm_device_destroy(gbm_device* d)                     {}
int           gbm_device_get_fd(gbm_device* d)                      { return -1; }
int           gbm_device_is_format_supported(gbm_device* d, uint32_t f, uint32_t fl) { return 0; }
gbm_bo*       gbm_bo_create(gbm_device* d, uint32_t w, uint32_t h, uint32_t f, uint32_t fl) { return NULL; }
gbm_bo*       gbm_bo_create_with_modifiers(gbm_device* d, uint32_t w, uint32_t h, uint32_t f, const uint64_t* m, unsigned int n) { return NULL; }
gbm_bo*       gbm_bo_import(gbm_device* d, uint32_t t, void* buf, uint32_t u) { return NULL; }
void          gbm_bo_destroy(gbm_bo* bo)                            {}
gbm_device*   gbm_bo_get_device(gbm_bo* bo)                         { return NULL; }
int           gbm_bo_get_fd_for_plane(gbm_bo* bo, int p)            { return -1; }
gbm_bo_handle gbm_bo_get_handle(gbm_bo* bo)                         { gbm_bo_handle h = {0}; return h; }
gbm_bo_handle gbm_bo_get_handle_for_plane(gbm_bo* bo, int p)        { gbm_bo_handle h = {0}; return h; }
uint32_t      gbm_bo_get_height(gbm_bo* bo)                         { return 0; }
uint64_t      gbm_bo_get_modifier(gbm_bo* bo)                       { return 0; }
uint32_t      gbm_bo_get_offset(gbm_bo* bo, int p)                  { return 0; }
int           gbm_bo_get_plane_count(gbm_bo* bo)                    { return 0; }
uint32_t      gbm_bo_get_stride_for_plane(gbm_bo* bo, int p)        { return 0; }
uint32_t      gbm_bo_get_width(gbm_bo* bo)                          { return 0; }
void*         gbm_bo_map(gbm_bo* bo, uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                         uint32_t fl, uint32_t* stride, void** map_data) { return NULL; }
void          gbm_bo_unmap(gbm_bo* bo, void* map_data)              {}
CSRC
gcc -shared -fPIC -Wl,-soname,libgbm.so.1 -o "$OUTDIR/libgbm.so.1" "$OUTDIR/stub_gbm.c"
echo "libgbm.so.1 stub built → $OUTDIR/libgbm.so.1"
