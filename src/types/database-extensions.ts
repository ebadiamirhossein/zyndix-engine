import type { Database } from "@/types/database";

/** Table added in 0004_source_cursors.sql — merge into database.ts after gen:types. */
export type DatabaseWithSourceCursors = Database & {
  public: Database["public"] & {
    Tables: Database["public"]["Tables"] & {
      source_cursors: {
        Row: {
          segment_key: string;
          page: number;
          updated_at: string | null;
        };
        Insert: {
          segment_key: string;
          page?: number;
          updated_at?: string | null;
        };
        Update: {
          segment_key?: string;
          page?: number;
          updated_at?: string | null;
        };
        Relationships: [];
      };
    };
  };
};
