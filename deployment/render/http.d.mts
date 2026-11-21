export function renderGuard(req: any, res: any, next: () => void): void;
export function mountRenderFrontend(app: any, express: any, publicDir?: string): void;
export function renderCorsOrigin(origin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void): void;
