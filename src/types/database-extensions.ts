import type { Database } from "@/types/database";
import type { AppRole } from "@/types/enums";

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

/** Table added in 0005_app_users_roles.sql — merge into database.ts after gen:types. */
export type DatabaseWithAppUsers = DatabaseWithSourceCursors & {
  public: DatabaseWithSourceCursors["public"] & {
    Tables: DatabaseWithSourceCursors["public"]["Tables"] & {
      app_users: {
        Row: {
          id: string;
          user_id: string;
          email: string;
          role: AppRole;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          email: string;
          role?: AppRole;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          email?: string;
          role?: AppRole;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
    };
  };
};
