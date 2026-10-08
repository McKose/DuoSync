// Supabase schema types for DuoSync.
// Mirrors supabase/migrations/*.sql in the shape emitted by
// `supabase gen types typescript`. After schema changes regenerate with:
//   npx supabase gen types typescript --project-id <ref> > src/types/database.types.ts
// and keep the convenience aliases at the bottom of this file.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type CoupleRow = {
  id: string;
  user_a_id: string;
  user_b_id: string | null;
  pairing_code: string | null;
  pairing_code_expires_at: string | null;
  is_active: boolean;
  user_a_battery: number | null;
  user_b_battery: number | null;
  user_a_status: Database['public']['Enums']['partner_status'];
  user_b_status: Database['public']['Enums']['partner_status'];
  user_a_seen_at: string | null;
  user_b_seen_at: string | null;
  created_at: string;
  paired_at: string | null;
};

type CourtCaseRow = {
  id: string;
  couple_id: string;
  prosecutor_id: string;
  defendant_id: string;
  title: string;
  category: string;
  prosecutor_plea: string;
  defendant_plea: string | null;
  defense_timed_out: boolean;
  status: Database['public']['Enums']['case_status'];
  verdict_judge: string | null;
  verdict_comedian: string | null;
  penalty: string | null;
  fault_ratio_prosecutor: number | null;
  fault_ratio_defendant: number | null;
  defense_deadline: string;
  defense_submitted_at: string | null;
  deliberation_started_at: string | null;
  verdict_attempts: number;
  last_error: string | null;
  created_at: string;
  judged_at: string | null;
};

type DelayedMessageRow = {
  id: string;
  couple_id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  delay_minutes: number;
  release_at: string;
  status: Database['public']['Enums']['message_status'];
  sent_at: string | null;
  cancelled_at: string | null;
  created_at: string;
};

type PendingQuestionRow = {
  id: string;
  couple_id: string;
  asker_id: string;
  question_text: string;
  answer_text: string | null;
  is_answered: boolean;
  answered_at: string | null;
  created_at: string;
};

type PlanRow = {
  id: string;
  couple_id: string;
  created_by: string | null;
  title: string;
  location: string | null;
  plan_date: string | null;
  checklist: Json;
  created_at: string;
  updated_at: string;
};

export type Database = {
  // Allows to automatically instantiate createClient with right options
  __InternalSupabase: {
    PostgrestVersion: '13.0.5';
  };
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name: string;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      push_tokens: {
        Row: {
          user_id: string;
          token: string;
          platform: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          token: string;
          platform: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          token?: string;
          platform?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'push_tokens_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      couples: {
        Row: CoupleRow;
        Insert: {
          id?: string;
          user_a_id: string;
          user_b_id?: string | null;
          pairing_code?: string | null;
          pairing_code_expires_at?: string | null;
          is_active?: boolean;
          user_a_battery?: number | null;
          user_b_battery?: number | null;
          user_a_status?: Database['public']['Enums']['partner_status'];
          user_b_status?: Database['public']['Enums']['partner_status'];
          user_a_seen_at?: string | null;
          user_b_seen_at?: string | null;
          created_at?: string;
          paired_at?: string | null;
        };
        Update: Partial<CoupleRow>;
        Relationships: [
          {
            foreignKeyName: 'couples_user_a_id_fkey';
            columns: ['user_a_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'couples_user_b_id_fkey';
            columns: ['user_b_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      pairing_attempts: {
        Row: { id: number; user_id: string; attempted_at: string };
        Insert: { id?: never; user_id: string; attempted_at?: string };
        Update: { id?: never; user_id?: string; attempted_at?: string };
        Relationships: [];
      };
      court_cases: {
        Row: CourtCaseRow;
        Insert: {
          id?: string;
          couple_id: string;
          prosecutor_id: string;
          defendant_id: string;
          title: string;
          category: string;
          prosecutor_plea: string;
          defendant_plea?: string | null;
          defense_timed_out?: boolean;
          status?: Database['public']['Enums']['case_status'];
          verdict_judge?: string | null;
          verdict_comedian?: string | null;
          penalty?: string | null;
          fault_ratio_prosecutor?: number | null;
          fault_ratio_defendant?: number | null;
          defense_deadline?: string;
          defense_submitted_at?: string | null;
          deliberation_started_at?: string | null;
          verdict_attempts?: number;
          last_error?: string | null;
          created_at?: string;
          judged_at?: string | null;
        };
        Update: Partial<CourtCaseRow>;
        Relationships: [
          {
            foreignKeyName: 'court_cases_couple_id_fkey';
            columns: ['couple_id'];
            isOneToOne: false;
            referencedRelation: 'couples';
            referencedColumns: ['id'];
          },
        ];
      };
      delayed_messages: {
        Row: DelayedMessageRow;
        Insert: {
          id?: string;
          couple_id: string;
          sender_id: string;
          recipient_id: string;
          content: string;
          delay_minutes: number;
          release_at: string;
          status?: Database['public']['Enums']['message_status'];
          sent_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
        };
        Update: Partial<DelayedMessageRow>;
        Relationships: [
          {
            foreignKeyName: 'delayed_messages_couple_id_fkey';
            columns: ['couple_id'];
            isOneToOne: false;
            referencedRelation: 'couples';
            referencedColumns: ['id'];
          },
        ];
      };
      pending_questions: {
        Row: PendingQuestionRow;
        Insert: {
          id?: string;
          couple_id: string;
          asker_id: string;
          question_text: string;
          answer_text?: string | null;
          is_answered?: boolean;
          answered_at?: string | null;
          created_at?: string;
        };
        Update: Partial<PendingQuestionRow>;
        Relationships: [
          {
            foreignKeyName: 'pending_questions_couple_id_fkey';
            columns: ['couple_id'];
            isOneToOne: false;
            referencedRelation: 'couples';
            referencedColumns: ['id'];
          },
        ];
      };
      plans: {
        Row: PlanRow;
        Insert: {
          id?: string;
          couple_id: string;
          created_by?: string | null;
          title: string;
          location?: string | null;
          plan_date?: string | null;
          checklist?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<PlanRow>;
        Relationships: [
          {
            foreignKeyName: 'plans_couple_id_fkey';
            columns: ['couple_id'];
            isOneToOne: false;
            referencedRelation: 'couples';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_couple_member: { Args: { cid: string }; Returns: boolean };
      is_my_partner: { Args: { pid: string }; Returns: boolean };
      my_active_couple: {
        Args: never;
        Returns: CoupleRow;
        SetofOptions: { from: '*'; to: 'couples'; isOneToOne: true; isSetofReturn: false };
      };
      create_pairing_code: {
        Args: never;
        Returns: CoupleRow;
        SetofOptions: { from: '*'; to: 'couples'; isOneToOne: true; isSetofReturn: false };
      };
      pair_with_code: {
        Args: { p_code: string };
        Returns: CoupleRow[];
        SetofOptions: { from: '*'; to: 'couples'; isOneToOne: false; isSetofReturn: true };
      };
      update_my_presence: {
        Args: {
          p_battery?: number | null;
          p_status?: Database['public']['Enums']['partner_status'] | null;
        };
        Returns: CoupleRow;
        SetofOptions: { from: '*'; to: 'couples'; isOneToOne: true; isSetofReturn: false };
      };
      file_case: {
        Args: { p_title: string; p_category: string; p_plea: string };
        Returns: CourtCaseRow;
        SetofOptions: { from: '*'; to: 'court_cases'; isOneToOne: true; isSetofReturn: false };
      };
      submit_defense: {
        Args: { p_case_id: string; p_plea: string };
        Returns: CourtCaseRow;
        SetofOptions: { from: '*'; to: 'court_cases'; isOneToOne: true; isSetofReturn: false };
      };
      claim_case_for_verdict: {
        Args: { p_case_id: string };
        Returns: CourtCaseRow[];
        SetofOptions: { from: '*'; to: 'court_cases'; isOneToOne: false; isSetofReturn: true };
      };
      complete_verdict: {
        Args: {
          p_case_id: string;
          p_verdict_judge: string;
          p_verdict_comedian: string;
          p_fault_prosecutor: number;
          p_fault_defendant: number;
          p_penalty: string;
        };
        Returns: CourtCaseRow[];
        SetofOptions: { from: '*'; to: 'court_cases'; isOneToOne: false; isSetofReturn: true };
      };
      fail_verdict: { Args: { p_case_id: string; p_error: string }; Returns: undefined };
      list_claimable_cases: { Args: { p_limit?: number }; Returns: string[] };
      schedule_delayed_message: {
        Args: { p_content: string; p_delay_minutes: number };
        Returns: DelayedMessageRow;
        SetofOptions: { from: '*'; to: 'delayed_messages'; isOneToOne: true; isSetofReturn: false };
      };
      cancel_delayed_message: { Args: { p_message_id: string }; Returns: boolean };
      release_due_messages: { Args: never; Returns: number };
      ask_question: {
        Args: { p_text: string };
        Returns: PendingQuestionRow;
        SetofOptions: { from: '*'; to: 'pending_questions'; isOneToOne: true; isSetofReturn: false };
      };
      answer_question: {
        Args: { p_question_id: string; p_answer: string };
        Returns: PendingQuestionRow;
        SetofOptions: { from: '*'; to: 'pending_questions'; isOneToOne: true; isSetofReturn: false };
      };
      upsert_checklist_item: {
        Args: { p_plan_id: string; p_item: Json };
        Returns: PlanRow;
        SetofOptions: { from: '*'; to: 'plans'; isOneToOne: true; isSetofReturn: false };
      };
      generate_pairing_code: { Args: never; Returns: string };
    };
    Enums: {
      case_status: 'AWAITING_DEFENSE' | 'DELIBERATING' | 'JUDGED' | 'APPEALED';
      message_status: 'PENDING' | 'SENT' | 'CANCELLED';
      partner_status: 'NORMAL' | 'BUSY' | 'LOW_BATTERY' | 'FRAGILE';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// ---------------------------------------------------------------------------
// Convenience aliases (app code imports these, never raw paths)
// ---------------------------------------------------------------------------
type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];

export type Profile = Tables<'profiles'>;
export type Couple = Tables<'couples'>;
export type CourtCase = Tables<'court_cases'>;
export type DelayedMessage = Tables<'delayed_messages'>;
export type PendingQuestion = Tables<'pending_questions'>;
export type Plan = Tables<'plans'>;
export type CaseStatus = Enums<'case_status'>;
export type MessageStatus = Enums<'message_status'>;
export type PartnerStatus = Enums<'partner_status'>;

export const CASE_CATEGORIES = ['CHORES', 'PLANS', 'COMMUNICATION', 'MONEY', 'FAMILY', 'OTHER'] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

/** Element of plans.checklist (JSONB). Per-item LWW on updated_at. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  deleted: boolean;
  updated_at: string;
}
