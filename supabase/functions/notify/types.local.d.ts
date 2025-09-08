/*
  Local IDE shim for Deno globals so TypeScript stops complaining
  about "Cannot find name 'Deno'" when editing Edge Functions.

  This file is not required at runtime; Supabase Edge provides
  the real Deno types. Keep this minimal to avoid conflicts.
*/

export {};

declare global {
  /** Minimal subset used in this function */
  const Deno: {
    env: { get(name: string): string | undefined };
    serve: (handler: (req: Request) => Response | Promise<Response>) => void;
  };
}

// Minimal module declaration so TS stops complaining about the URL import.
declare module 'https://esm.sh/@supabase/supabase-js@2' {
  export function createClient(url: string, key: string, opts?: any): any;
}
