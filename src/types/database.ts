export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      ads_attribution: {
        Row: {
          conversion_uploads: Json | null
          created_at: string | null
          fbclid: string | null
          gclid: string | null
          id: string
          lead_id: string | null
          li_fat_id: string | null
          updated_at: string | null
          utm: Json | null
        }
        Insert: {
          conversion_uploads?: Json | null
          created_at?: string | null
          fbclid?: string | null
          gclid?: string | null
          id?: string
          lead_id?: string | null
          li_fat_id?: string | null
          updated_at?: string | null
          utm?: Json | null
        }
        Update: {
          conversion_uploads?: Json | null
          created_at?: string | null
          fbclid?: string | null
          gclid?: string | null
          id?: string
          lead_id?: string | null
          li_fat_id?: string | null
          updated_at?: string | null
          utm?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ads_attribution_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      capacity_ledger: {
        Row: {
          created_at: string | null
          date: string
          id: string
          quota: number | null
          send_account_id: string | null
          updated_at: string | null
          used: number | null
        }
        Insert: {
          created_at?: string | null
          date: string
          id?: string
          quota?: number | null
          send_account_id?: string | null
          updated_at?: string | null
          used?: number | null
        }
        Update: {
          created_at?: string | null
          date?: string
          id?: string
          quota?: number | null
          send_account_id?: string | null
          updated_at?: string | null
          used?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "capacity_ledger_send_account_id_fkey"
            columns: ["send_account_id"]
            isOneToOne: false
            referencedRelation: "send_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          apollo_org_id: string | null
          attio_company_id: string | null
          city: string | null
          country: string | null
          created_at: string | null
          domain: string | null
          employee_range: string | null
          id: string
          industry: string | null
          linkedin_url: string | null
          name: string
          park_reason: string | null
          segment: string | null
          status: string | null
          timezone: string | null
          updated_at: string | null
        }
        Insert: {
          apollo_org_id?: string | null
          attio_company_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          domain?: string | null
          employee_range?: string | null
          id?: string
          industry?: string | null
          linkedin_url?: string | null
          name: string
          park_reason?: string | null
          segment?: string | null
          status?: string | null
          timezone?: string | null
          updated_at?: string | null
        }
        Update: {
          apollo_org_id?: string | null
          attio_company_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          domain?: string | null
          employee_range?: string | null
          id?: string
          industry?: string | null
          linkedin_url?: string | null
          name?: string
          park_reason?: string | null
          segment?: string | null
          status?: string | null
          timezone?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      enrichment_payloads: {
        Row: {
          company_id: string | null
          created_at: string | null
          fetched_at: string | null
          id: string
          lead_id: string | null
          payload: Json | null
          source: string | null
          updated_at: string | null
        }
        Insert: {
          company_id?: string | null
          created_at?: string | null
          fetched_at?: string | null
          id?: string
          lead_id?: string | null
          payload?: Json | null
          source?: string | null
          updated_at?: string | null
        }
        Update: {
          company_id?: string | null
          created_at?: string | null
          fetched_at?: string | null
          id?: string
          lead_id?: string | null
          payload?: Json | null
          source?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "enrichment_payloads_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrichment_payloads_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_events: {
        Row: {
          created_at: string | null
          detail: Json | null
          event: string | null
          id: string
          lead_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          detail?: Json | null
          event?: string | null
          id?: string
          lead_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          detail?: Json | null
          event?: string | null
          id?: string
          lead_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          apollo_person_id: string | null
          attio_person_id: string | null
          company_id: string | null
          created_at: string | null
          current_sequence_id: string | null
          current_step: number | null
          do_not_contact: boolean | null
          email: string | null
          email_status: string | null
          email_verified_at: string | null
          first_name: string | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          next_action_at: string | null
          owner: string | null
          state: string
          state_changed_at: string | null
          timezone: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          apollo_person_id?: string | null
          attio_person_id?: string | null
          company_id?: string | null
          created_at?: string | null
          current_sequence_id?: string | null
          current_step?: number | null
          do_not_contact?: boolean | null
          email?: string | null
          email_status?: string | null
          email_verified_at?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          next_action_at?: string | null
          owner?: string | null
          state?: string
          state_changed_at?: string | null
          timezone?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          apollo_person_id?: string | null
          attio_person_id?: string | null
          company_id?: string | null
          created_at?: string | null
          current_sequence_id?: string | null
          current_step?: number | null
          do_not_contact?: boolean | null
          email?: string | null
          email_status?: string | null
          email_verified_at?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          next_action_at?: string | null
          owner?: string | null
          state?: string
          state_changed_at?: string | null
          timezone?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_current_sequence_id_fkey"
            columns: ["current_sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      qualification: {
        Row: {
          created_at: string | null
          disqualify_reason: string | null
          evidence: Json | null
          fit_score: number | null
          id: string
          lead_id: string
          model: string | null
          problem_hypothesis: string
          prompt_version: number | null
          recommended_angle: string | null
          segment: string | null
          triggers: Json | null
          updated_at: string | null
          visible_tools: Json | null
        }
        Insert: {
          created_at?: string | null
          disqualify_reason?: string | null
          evidence?: Json | null
          fit_score?: number | null
          id?: string
          lead_id: string
          model?: string | null
          problem_hypothesis: string
          prompt_version?: number | null
          recommended_angle?: string | null
          segment?: string | null
          triggers?: Json | null
          updated_at?: string | null
          visible_tools?: Json | null
        }
        Update: {
          created_at?: string | null
          disqualify_reason?: string | null
          evidence?: Json | null
          fit_score?: number | null
          id?: string
          lead_id?: string
          model?: string | null
          problem_hypothesis?: string
          prompt_version?: number | null
          recommended_angle?: string | null
          segment?: string | null
          triggers?: Json | null
          updated_at?: string | null
          visible_tools?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "qualification_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      qualification_history: {
        Row: {
          created_at: string | null
          disqualify_reason: string | null
          evidence: Json | null
          fit_score: number | null
          id: string
          lead_id: string
          model: string | null
          problem_hypothesis: string
          prompt_version: number | null
          recommended_angle: string | null
          segment: string | null
          triggers: Json | null
          updated_at: string | null
          visible_tools: Json | null
        }
        Insert: {
          created_at?: string | null
          disqualify_reason?: string | null
          evidence?: Json | null
          fit_score?: number | null
          id?: string
          lead_id: string
          model?: string | null
          problem_hypothesis: string
          prompt_version?: number | null
          recommended_angle?: string | null
          segment?: string | null
          triggers?: Json | null
          updated_at?: string | null
          visible_tools?: Json | null
        }
        Update: {
          created_at?: string | null
          disqualify_reason?: string | null
          evidence?: Json | null
          fit_score?: number | null
          id?: string
          lead_id?: string
          model?: string | null
          problem_hypothesis?: string
          prompt_version?: number | null
          recommended_angle?: string | null
          segment?: string | null
          triggers?: Json | null
          updated_at?: string | null
          visible_tools?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "qualification_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      send_accounts: {
        Row: {
          bounce_rate_7d: number | null
          created_at: string | null
          daily_quota: number | null
          domain: string | null
          health: string | null
          id: string
          identifier: string | null
          kind: string | null
          paused_reason: string | null
          provider: string | null
          ramp_stage: string | null
          updated_at: string | null
        }
        Insert: {
          bounce_rate_7d?: number | null
          created_at?: string | null
          daily_quota?: number | null
          domain?: string | null
          health?: string | null
          id?: string
          identifier?: string | null
          kind?: string | null
          paused_reason?: string | null
          provider?: string | null
          ramp_stage?: string | null
          updated_at?: string | null
        }
        Update: {
          bounce_rate_7d?: number | null
          created_at?: string | null
          daily_quota?: number | null
          domain?: string | null
          health?: string | null
          id?: string
          identifier?: string | null
          kind?: string | null
          paused_reason?: string | null
          provider?: string | null
          ramp_stage?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sequence_steps: {
        Row: {
          channel: string | null
          created_at: string | null
          id: string
          requires_approval: boolean | null
          sequence_id: string
          step_no: number
          template_hint: string | null
          updated_at: string | null
          wait_days: number | null
        }
        Insert: {
          channel?: string | null
          created_at?: string | null
          id?: string
          requires_approval?: boolean | null
          sequence_id: string
          step_no: number
          template_hint?: string | null
          updated_at?: string | null
          wait_days?: number | null
        }
        Update: {
          channel?: string | null
          created_at?: string | null
          id?: string
          requires_approval?: boolean | null
          sequence_id?: string
          step_no?: number
          template_hint?: string | null
          updated_at?: string | null
          wait_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sequence_steps_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      sequences: {
        Row: {
          active: boolean | null
          channel: string | null
          created_at: string | null
          id: string
          name: string
          segment: string | null
          updated_at: string | null
          version: number | null
        }
        Insert: {
          active?: boolean | null
          channel?: string | null
          created_at?: string | null
          id?: string
          name: string
          segment?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Update: {
          active?: boolean | null
          channel?: string | null
          created_at?: string | null
          id?: string
          name?: string
          segment?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Relationships: []
      }
      settings: {
        Row: {
          active: boolean | null
          change_note: string | null
          changed_by: string | null
          created_at: string | null
          id: string
          key: string
          updated_at: string | null
          value: Json | null
          version: number
        }
        Insert: {
          active?: boolean | null
          change_note?: string | null
          changed_by?: string | null
          created_at?: string | null
          id?: string
          key: string
          updated_at?: string | null
          value?: Json | null
          version?: number
        }
        Update: {
          active?: boolean | null
          change_note?: string | null
          changed_by?: string | null
          created_at?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          value?: Json | null
          version?: number
        }
        Relationships: []
      }
      suppression_list: {
        Row: {
          created_at: string | null
          domain: string | null
          email: string | null
          id: string
          linkedin_url: string | null
          reason: string | null
          source_touch_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          domain?: string | null
          email?: string | null
          id?: string
          linkedin_url?: string | null
          reason?: string | null
          source_touch_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          domain?: string | null
          email?: string | null
          id?: string
          linkedin_url?: string | null
          reason?: string | null
          source_touch_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "suppression_list_source_touch_id_fkey"
            columns: ["source_touch_id"]
            isOneToOne: false
            referencedRelation: "touches"
            referencedColumns: ["id"]
          },
        ]
      }
      touches: {
        Row: {
          body: string | null
          channel: string | null
          created_at: string | null
          direction: string | null
          draft_body: string | null
          id: string
          lead_id: string | null
          opened_at: string | null
          prompt_version: number | null
          provider_message_id: string | null
          replied_at: string | null
          reply_body: string | null
          reply_classification: string | null
          scheduled_for: string | null
          send_account_id: string | null
          sent_at: string | null
          sequence_id: string | null
          status: string | null
          step_no: number | null
          subject: string | null
          updated_at: string | null
        }
        Insert: {
          body?: string | null
          channel?: string | null
          created_at?: string | null
          direction?: string | null
          draft_body?: string | null
          id?: string
          lead_id?: string | null
          opened_at?: string | null
          prompt_version?: number | null
          provider_message_id?: string | null
          replied_at?: string | null
          reply_body?: string | null
          reply_classification?: string | null
          scheduled_for?: string | null
          send_account_id?: string | null
          sent_at?: string | null
          sequence_id?: string | null
          status?: string | null
          step_no?: number | null
          subject?: string | null
          updated_at?: string | null
        }
        Update: {
          body?: string | null
          channel?: string | null
          created_at?: string | null
          direction?: string | null
          draft_body?: string | null
          id?: string
          lead_id?: string | null
          opened_at?: string | null
          prompt_version?: number | null
          provider_message_id?: string | null
          replied_at?: string | null
          reply_body?: string | null
          reply_classification?: string | null
          scheduled_for?: string | null
          send_account_id?: string | null
          sent_at?: string | null
          sequence_id?: string | null
          status?: string | null
          step_no?: number | null
          subject?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "touches_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "touches_send_account_id_fkey"
            columns: ["send_account_id"]
            isOneToOne: false
            referencedRelation: "send_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "touches_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          created_at: string | null
          event_type: string | null
          external_id: string | null
          id: string
          payload: Json | null
          processed: boolean | null
          processed_at: string | null
          provider: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          event_type?: string | null
          external_id?: string | null
          id?: string
          payload?: Json | null
          processed?: boolean | null
          processed_at?: string | null
          provider?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          event_type?: string | null
          external_id?: string | null
          id?: string
          payload?: Json | null
          processed?: boolean | null
          processed_at?: string | null
          provider?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      weekly_digests: {
        Row: {
          created_at: string | null
          id: string
          narrative: string | null
          stats: Json | null
          updated_at: string | null
          week_start: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          narrative?: string | null
          stats?: Json | null
          updated_at?: string | null
          week_start?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          narrative?: string | null
          stats?: Json | null
          updated_at?: string | null
          week_start?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

