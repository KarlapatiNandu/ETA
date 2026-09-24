import { createClient } from "@supabase/supabase-js";

/** Uploaded CSVs are kept (SCHEMA §7 `file_path`) so apply re-reads exactly what was previewed. */
export interface FileStore {
  put(path: string, content: string, contentType: string): Promise<void>;
  get(path: string): Promise<string>;
}

export const ROSTER_BUCKET = "roster-uploads";
/** Raw 1 Hz survey traces (Stage 1), kept so a route can be re-matched from its source. */
export const SURVEY_BUCKET = "route-surveys";

export function createSupabaseFileStore(
  url: string,
  serviceRoleKey: string,
  bucket: string = ROSTER_BUCKET,
): FileStore {
  const storage = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).storage.from(bucket);
  return {
    async put(path, content, contentType) {
      const { error } = await storage.upload(path, new Blob([content], { type: contentType }), {
        contentType,
        upsert: false,
      });
      if (error) throw new Error(`storage upload failed: ${error.message}`);
    },
    async get(path) {
      const { data, error } = await storage.download(path);
      if (error || !data) throw new Error(`storage download failed: ${error?.message}`);
      return data.text();
    },
  };
}

export function createMemoryFileStore(): FileStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async put(path, content) {
      files.set(path, content);
    },
    async get(path) {
      const f = files.get(path);
      if (f === undefined) throw new Error(`no such file: ${path}`);
      return f;
    },
  };
}
