export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.5';
  };
  public: {
    Tables: {
      account_legal_holds: {
        Row: {
          account_id: string;
          active: boolean;
          created_at: string;
          id: string;
          reason: string | null;
          released_at: string | null;
          set_at: string;
          set_by: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          active?: boolean;
          created_at?: string;
          id?: string;
          reason?: string | null;
          released_at?: string | null;
          set_at?: string;
          set_by?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          active?: boolean;
          created_at?: string;
          id?: string;
          reason?: string | null;
          released_at?: string | null;
          set_at?: string;
          set_by?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'account_legal_holds_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: true;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      account_members: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          role: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          role: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          role?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'account_members_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      accounts: {
        Row: {
          auto_charge_enabled: boolean;
          created_at: string;
          deleted_at: string | null;
          email_subdomain: string | null;
          id: string;
          name: string;
          persona_local_part: string | null;
          sender_display_name: string | null;
          updated_at: string;
        };
        Insert: {
          auto_charge_enabled?: boolean;
          created_at?: string;
          deleted_at?: string | null;
          email_subdomain?: string | null;
          id?: string;
          name: string;
          persona_local_part?: string | null;
          sender_display_name?: string | null;
          updated_at?: string;
        };
        Update: {
          auto_charge_enabled?: boolean;
          created_at?: string;
          deleted_at?: string | null;
          email_subdomain?: string | null;
          id?: string;
          name?: string;
          persona_local_part?: string | null;
          sender_display_name?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_grants: {
        Row: {
          account_id: string;
          agent_principal_id: string;
          agent_user_id: string;
          granted_at: string;
          granted_by: string | null;
          id: string;
          revoked_at: string | null;
          revoked_by: string | null;
          scopes: string[];
        };
        Insert: {
          account_id: string;
          agent_principal_id: string;
          agent_user_id: string;
          granted_at?: string;
          granted_by?: string | null;
          id?: string;
          revoked_at?: string | null;
          revoked_by?: string | null;
          scopes?: string[];
        };
        Update: {
          account_id?: string;
          agent_principal_id?: string;
          agent_user_id?: string;
          granted_at?: string;
          granted_by?: string | null;
          id?: string;
          revoked_at?: string | null;
          revoked_by?: string | null;
          scopes?: string[];
        };
        Relationships: [
          {
            foreignKeyName: 'agent_grants_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_grants_agent_principal_id_fkey';
            columns: ['agent_principal_id'];
            isOneToOne: false;
            referencedRelation: 'agent_principals';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_grants_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_grants_revoked_by_fkey';
            columns: ['revoked_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_principals: {
        Row: {
          created_at: string;
          description: string | null;
          disabled_at: string | null;
          id: string;
          name: string;
          secret_hash: string | null;
          secret_set_at: string | null;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          disabled_at?: string | null;
          id?: string;
          name: string;
          secret_hash?: string | null;
          secret_set_at?: string | null;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          disabled_at?: string | null;
          id?: string;
          name?: string;
          secret_hash?: string | null;
          secret_set_at?: string | null;
        };
        Relationships: [];
      };
      areas: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          kind: string;
          name: string;
          property_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind: string;
          name: string;
          property_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind?: string;
          name?: string;
          property_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'areas_account_id_property_id_fkey';
            columns: ['account_id', 'property_id'];
            isOneToOne: false;
            referencedRelation: 'properties';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      assets: {
        Row: {
          account_id: string;
          area_id: string;
          attributes: Json;
          created_at: string;
          deleted_at: string | null;
          id: string;
          kind: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          area_id: string;
          attributes?: Json;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          area_id?: string;
          attributes?: Json;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'assets_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      attachments: {
        Row: {
          account_id: string;
          content_hash: string;
          created_at: string;
          deleted_at: string | null;
          derived_from: string | null;
          entity_id: string;
          entity_type: string;
          filename: string | null;
          id: string;
          mime_type: string | null;
          received_at: string;
          size_bytes: number | null;
          storage_path: string;
          updated_at: string;
          uploaded_by: string | null;
        };
        Insert: {
          account_id: string;
          content_hash: string;
          created_at?: string;
          deleted_at?: string | null;
          derived_from?: string | null;
          entity_id: string;
          entity_type: string;
          filename?: string | null;
          id?: string;
          mime_type?: string | null;
          received_at?: string;
          size_bytes?: number | null;
          storage_path: string;
          updated_at?: string;
          uploaded_by?: string | null;
        };
        Update: {
          account_id?: string;
          content_hash?: string;
          created_at?: string;
          deleted_at?: string | null;
          derived_from?: string | null;
          entity_id?: string;
          entity_type?: string;
          filename?: string | null;
          id?: string;
          mime_type?: string | null;
          received_at?: string;
          size_bytes?: number | null;
          storage_path?: string;
          updated_at?: string;
          uploaded_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'attachments_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attachments_derived_from_fk';
            columns: ['account_id', 'derived_from'];
            isOneToOne: false;
            referencedRelation: 'attachments';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      chain_verification_alerts: {
        Row: {
          account_id: string;
          broken_event_id: string | null;
          broken_event_no: number | null;
          created_at: string;
          first_detected_at: string;
          id: string;
          last_detected_at: string;
          reason: string;
          resolved_at: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          broken_event_id?: string | null;
          broken_event_no?: number | null;
          created_at?: string;
          first_detected_at?: string;
          id?: string;
          last_detected_at?: string;
          reason: string;
          resolved_at?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          broken_event_id?: string | null;
          broken_event_no?: number | null;
          created_at?: string;
          first_detected_at?: string;
          id?: string;
          last_detected_at?: string;
          reason?: string;
          resolved_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'chain_verification_alerts_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      chain_watermarks: {
        Row: {
          account_id: string;
          created_at: string;
          last_full_at: string;
          last_verified_hash: string;
          last_verified_seq: number;
          updated_at: string;
          verified_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          last_full_at?: string;
          last_verified_hash: string;
          last_verified_seq: number;
          updated_at?: string;
          verified_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          last_full_at?: string;
          last_verified_hash?: string;
          last_verified_seq?: number;
          updated_at?: string;
          verified_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'chain_watermarks_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: true;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      channel_identities: {
        Row: {
          account_id: string;
          address: string;
          channel: string;
          created_at: string;
          id: string;
          label: string | null;
          party_id: string;
          party_type: string;
          updated_at: string;
          verified_at: string | null;
        };
        Insert: {
          account_id: string;
          address: string;
          channel: string;
          created_at?: string;
          id?: string;
          label?: string | null;
          party_id: string;
          party_type: string;
          updated_at?: string;
          verified_at?: string | null;
        };
        Update: {
          account_id?: string;
          address?: string;
          channel?: string;
          created_at?: string;
          id?: string;
          label?: string | null;
          party_id?: string;
          party_type?: string;
          updated_at?: string;
          verified_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'channel_identities_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      charges: {
        Row: {
          account_id: string;
          amount_cents: number;
          created_at: string;
          currency: string;
          deleted_at: string | null;
          description: string | null;
          due_date: string;
          id: string;
          period_end: string | null;
          period_start: string | null;
          source_schedule_id: string | null;
          tenancy_id: string;
          type: string;
          updated_at: string;
          void_reason: string | null;
          voided_at: string | null;
        };
        Insert: {
          account_id: string;
          amount_cents: number;
          created_at?: string;
          currency: string;
          deleted_at?: string | null;
          description?: string | null;
          due_date: string;
          id?: string;
          period_end?: string | null;
          period_start?: string | null;
          source_schedule_id?: string | null;
          tenancy_id: string;
          type: string;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
        };
        Update: {
          account_id?: string;
          amount_cents?: number;
          created_at?: string;
          currency?: string;
          deleted_at?: string | null;
          description?: string | null;
          due_date?: string;
          id?: string;
          period_end?: string | null;
          period_start?: string | null;
          source_schedule_id?: string | null;
          tenancy_id?: string;
          type?: string;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'charges_account_id_source_schedule_id_fkey';
            columns: ['account_id', 'source_schedule_id'];
            isOneToOne: false;
            referencedRelation: 'rent_schedules';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'charges_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      comm_opt_outs: {
        Row: {
          address: string;
          channel: string;
          keyword: string | null;
          opted_out_at: string;
          source_ref: string | null;
        };
        Insert: {
          address: string;
          channel: string;
          keyword?: string | null;
          opted_out_at?: string;
          source_ref?: string | null;
        };
        Update: {
          address?: string;
          channel?: string;
          keyword?: string | null;
          opted_out_at?: string;
          source_ref?: string | null;
        };
        Relationships: [];
      };
      comm_outbox: {
        Row: {
          account_id: string;
          approval_ref: string;
          approved_by: string | null;
          author_type: string;
          body: string;
          channel: string;
          client_ref: string;
          created_at: string;
          delivered_at: string | null;
          error_code: string | null;
          error_message: string | null;
          group_addresses: string[] | null;
          id: string;
          interaction_id: string | null;
          maintenance_request_id: string | null;
          not_before: string | null;
          participant_id: string | null;
          provider: string | null;
          provider_sid: string | null;
          recipient_snapshot: Json | null;
          relay_of_interaction_id: string | null;
          rfc822_message_id: string | null;
          status: string;
          subject: string | null;
          template_id: string | null;
          tenancy_id: string | null;
          thread_id: string | null;
          to_address: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          approval_ref: string;
          approved_by?: string | null;
          author_type: string;
          body: string;
          channel: string;
          client_ref?: string;
          created_at?: string;
          delivered_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          group_addresses?: string[] | null;
          id?: string;
          interaction_id?: string | null;
          maintenance_request_id?: string | null;
          not_before?: string | null;
          participant_id?: string | null;
          provider?: string | null;
          provider_sid?: string | null;
          recipient_snapshot?: Json | null;
          relay_of_interaction_id?: string | null;
          rfc822_message_id?: string | null;
          status?: string;
          subject?: string | null;
          template_id?: string | null;
          tenancy_id?: string | null;
          thread_id?: string | null;
          to_address?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          approval_ref?: string;
          approved_by?: string | null;
          author_type?: string;
          body?: string;
          channel?: string;
          client_ref?: string;
          created_at?: string;
          delivered_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          group_addresses?: string[] | null;
          id?: string;
          interaction_id?: string | null;
          maintenance_request_id?: string | null;
          not_before?: string | null;
          participant_id?: string | null;
          provider?: string | null;
          provider_sid?: string | null;
          recipient_snapshot?: Json | null;
          relay_of_interaction_id?: string | null;
          rfc822_message_id?: string | null;
          status?: string;
          subject?: string | null;
          template_id?: string | null;
          tenancy_id?: string | null;
          thread_id?: string | null;
          to_address?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comm_outbox_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_interaction_id_fkey';
            columns: ['account_id', 'interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_interaction_id_fkey';
            columns: ['account_id', 'interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_interaction_id_fkey';
            columns: ['account_id', 'interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_participant_id_fkey';
            columns: ['account_id', 'participant_id'];
            isOneToOne: false;
            referencedRelation: 'comm_thread_participants';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_relay_of_interaction_id_fkey';
            columns: ['account_id', 'relay_of_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_relay_of_interaction_id_fkey';
            columns: ['account_id', 'relay_of_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_relay_of_interaction_id_fkey';
            columns: ['account_id', 'relay_of_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
          {
            foreignKeyName: 'comm_outbox_account_id_thread_id_fkey';
            columns: ['account_id', 'thread_id'];
            isOneToOne: false;
            referencedRelation: 'comm_threads';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_outbox_mreq_fk';
            columns: ['account_id', 'maintenance_request_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_requests';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_outbox_tenancy_fk';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      comm_policies: {
        Row: {
          account_id: string;
          approved_at: string;
          approved_by: string;
          channel: string;
          created_at: string;
          id: string;
          params: Json;
          policy_kind: string;
          quiet_hours: Json | null;
          revoked_at: string | null;
          revoked_by: string | null;
          status: string;
          template_id: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          approved_at?: string;
          approved_by: string;
          channel: string;
          created_at?: string;
          id?: string;
          params?: Json;
          policy_kind: string;
          quiet_hours?: Json | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          status?: string;
          template_id?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          approved_at?: string;
          approved_by?: string;
          channel?: string;
          created_at?: string;
          id?: string;
          params?: Json;
          policy_kind?: string;
          quiet_hours?: Json | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          status?: string;
          template_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comm_policies_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      comm_thread_participants: {
        Row: {
          account_id: string;
          created_at: string;
          id: string;
          joined_at: string;
          left_at: string | null;
          party_id: string | null;
          party_type: string;
          thread_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          id?: string;
          joined_at?: string;
          left_at?: string | null;
          party_id?: string | null;
          party_type: string;
          thread_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          id?: string;
          joined_at?: string;
          left_at?: string | null;
          party_id?: string | null;
          party_type?: string;
          thread_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comm_thread_participants_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comm_thread_participants_account_id_thread_id_fkey';
            columns: ['account_id', 'thread_id'];
            isOneToOne: false;
            referencedRelation: 'comm_threads';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      comm_threads: {
        Row: {
          account_id: string;
          channel: string;
          created_at: string;
          group_routing_key: string | null;
          id: string;
          kind: string;
          maintenance_request_id: string | null;
          mode: string;
          status: string;
          subject: string | null;
          tenancy_id: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          channel?: string;
          created_at?: string;
          group_routing_key?: string | null;
          id?: string;
          kind: string;
          maintenance_request_id?: string | null;
          mode?: string;
          status?: string;
          subject?: string | null;
          tenancy_id?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          channel?: string;
          created_at?: string;
          group_routing_key?: string | null;
          id?: string;
          kind?: string;
          maintenance_request_id?: string | null;
          mode?: string;
          status?: string;
          subject?: string | null;
          tenancy_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comm_threads_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comm_threads_account_id_maintenance_request_id_fkey';
            columns: ['account_id', 'maintenance_request_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_requests';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_threads_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      comm_unmatched_inbound: {
        Row: {
          account_id: string;
          auto_acked_at: string | null;
          body: string | null;
          cc_addresses: string[];
          created_at: string;
          dkim: string | null;
          dmarc: string | null;
          from_address: string;
          from_display_name: string | null;
          id: string;
          linked_interaction_id: string | null;
          linked_party_id: string | null;
          linked_party_type: string | null;
          linked_thread_id: string | null;
          media: Json;
          persona_address: string;
          provider: string;
          provider_msg_id: string;
          reason: string;
          received_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
          rfc822_message_id: string | null;
          spf: string | null;
          status: string;
          subject: string | null;
          to_addresses: string[];
          updated_at: string;
        };
        Insert: {
          account_id: string;
          auto_acked_at?: string | null;
          body?: string | null;
          cc_addresses?: string[];
          created_at?: string;
          dkim?: string | null;
          dmarc?: string | null;
          from_address: string;
          from_display_name?: string | null;
          id?: string;
          linked_interaction_id?: string | null;
          linked_party_id?: string | null;
          linked_party_type?: string | null;
          linked_thread_id?: string | null;
          media?: Json;
          persona_address: string;
          provider: string;
          provider_msg_id: string;
          reason?: string;
          received_at: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          rfc822_message_id?: string | null;
          spf?: string | null;
          status?: string;
          subject?: string | null;
          to_addresses?: string[];
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          auto_acked_at?: string | null;
          body?: string | null;
          cc_addresses?: string[];
          created_at?: string;
          dkim?: string | null;
          dmarc?: string | null;
          from_address?: string;
          from_display_name?: string | null;
          id?: string;
          linked_interaction_id?: string | null;
          linked_party_id?: string | null;
          linked_party_type?: string | null;
          linked_thread_id?: string | null;
          media?: Json;
          persona_address?: string;
          provider?: string;
          provider_msg_id?: string;
          reason?: string;
          received_at?: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          rfc822_message_id?: string | null;
          spf?: string | null;
          status?: string;
          subject?: string | null;
          to_addresses?: string[];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comm_unmatched_inbound_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comm_unmatched_inbound_account_id_linked_interaction_id_fkey';
            columns: ['account_id', 'linked_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_unmatched_inbound_account_id_linked_interaction_id_fkey';
            columns: ['account_id', 'linked_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'comm_unmatched_inbound_account_id_linked_interaction_id_fkey';
            columns: ['account_id', 'linked_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
          {
            foreignKeyName: 'comm_unmatched_inbound_account_id_linked_thread_id_fkey';
            columns: ['account_id', 'linked_thread_id'];
            isOneToOne: false;
            referencedRelation: 'comm_threads';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      document_access_events: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          document_id: string;
          document_version_id: string | null;
          event_type: string;
          id: string;
          ip: string | null;
          occurred_at: string;
          tenancy_id: string;
          tenant_id: string | null;
          token_id: string;
          updated_at: string;
          user_agent: string | null;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          document_id: string;
          document_version_id?: string | null;
          event_type: string;
          id?: string;
          ip?: string | null;
          occurred_at?: string;
          tenancy_id: string;
          tenant_id?: string | null;
          token_id: string;
          updated_at?: string;
          user_agent?: string | null;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          document_id?: string;
          document_version_id?: string | null;
          event_type?: string;
          id?: string;
          ip?: string | null;
          occurred_at?: string;
          tenancy_id?: string;
          tenant_id?: string | null;
          token_id?: string;
          updated_at?: string;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'document_access_events_account_id_document_id_fkey';
            columns: ['account_id', 'document_id'];
            isOneToOne: false;
            referencedRelation: 'documents';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'document_access_events_account_id_document_version_id_fkey';
            columns: ['account_id', 'document_version_id'];
            isOneToOne: false;
            referencedRelation: 'document_versions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'document_access_events_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'document_access_events_account_id_tenant_id_fkey';
            columns: ['account_id', 'tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'document_access_events_account_id_token_id_fkey';
            columns: ['account_id', 'token_id'];
            isOneToOne: false;
            referencedRelation: 'document_access_tokens';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      document_access_tokens: {
        Row: {
          account_id: string;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          expires_at: string;
          id: string;
          last_used_at: string | null;
          revoked_at: string | null;
          secret_hash: string;
          tenancy_id: string;
          tenant_id: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          expires_at: string;
          id?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          secret_hash: string;
          tenancy_id: string;
          tenant_id?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          expires_at?: string;
          id?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          secret_hash?: string;
          tenancy_id?: string;
          tenant_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'document_access_tokens_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'document_access_tokens_account_id_tenant_id_fkey';
            columns: ['account_id', 'tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      document_versions: {
        Row: {
          account_id: string;
          attachment_id: string | null;
          content_hash: string;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          document_id: string;
          id: string;
          mime_type: string;
          size_bytes: number;
          source: string;
          static_asset_path: string | null;
          static_template_id: string | null;
          updated_at: string;
          version_no: number;
        };
        Insert: {
          account_id: string;
          attachment_id?: string | null;
          content_hash: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          document_id: string;
          id?: string;
          mime_type?: string;
          size_bytes: number;
          source: string;
          static_asset_path?: string | null;
          static_template_id?: string | null;
          updated_at?: string;
          version_no: number;
        };
        Update: {
          account_id?: string;
          attachment_id?: string | null;
          content_hash?: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          document_id?: string;
          id?: string;
          mime_type?: string;
          size_bytes?: number;
          source?: string;
          static_asset_path?: string | null;
          static_template_id?: string | null;
          updated_at?: string;
          version_no?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'document_versions_account_id_attachment_id_fkey';
            columns: ['account_id', 'attachment_id'];
            isOneToOne: false;
            referencedRelation: 'attachments';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'document_versions_account_id_document_id_fkey';
            columns: ['account_id', 'document_id'];
            isOneToOne: false;
            referencedRelation: 'documents';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      documents: {
        Row: {
          account_id: string;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          document_type: string;
          id: string;
          inspection_id: string | null;
          published_at: string | null;
          requires_ack: boolean;
          tenancy_id: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          document_type: string;
          id?: string;
          inspection_id?: string | null;
          published_at?: string | null;
          requires_ack?: boolean;
          tenancy_id: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          document_type?: string;
          id?: string;
          inspection_id?: string | null;
          published_at?: string | null;
          requires_ack?: boolean;
          tenancy_id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'documents_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'documents_inspection_fk';
            columns: ['account_id', 'inspection_id'];
            isOneToOne: false;
            referencedRelation: 'inspections';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      events: {
        Row: {
          account_id: string;
          account_seq: number;
          actor: string;
          entity_id: string;
          entity_type: string;
          event_hash: string;
          event_type: string;
          id: string;
          occurred_at: string;
          payload: Json;
          prev_event_hash: string | null;
        };
        Insert: {
          account_id: string;
          account_seq: number;
          actor: string;
          entity_id: string;
          entity_type: string;
          event_hash: string;
          event_type: string;
          id?: string;
          occurred_at?: string;
          payload: Json;
          prev_event_hash?: string | null;
        };
        Update: {
          account_id?: string;
          account_seq?: number;
          actor?: string;
          entity_id?: string;
          entity_type?: string;
          event_hash?: string;
          event_type?: string;
          id?: string;
          occurred_at?: string;
          payload?: Json;
          prev_event_hash?: string | null;
        };
        Relationships: [];
      };
      evidence_exports: {
        Row: {
          account_id: string;
          area_id: string | null;
          attachment_id: string | null;
          chain_message: string | null;
          chain_verified: boolean | null;
          created_at: string;
          deleted_at: string | null;
          error: string | null;
          exporter: string | null;
          from_date: string | null;
          generated_at: string;
          id: string;
          status: string;
          tenancy_id: string | null;
          to_date: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          area_id?: string | null;
          attachment_id?: string | null;
          chain_message?: string | null;
          chain_verified?: boolean | null;
          created_at?: string;
          deleted_at?: string | null;
          error?: string | null;
          exporter?: string | null;
          from_date?: string | null;
          generated_at?: string;
          id?: string;
          status?: string;
          tenancy_id?: string | null;
          to_date?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          area_id?: string | null;
          attachment_id?: string | null;
          chain_message?: string | null;
          chain_verified?: boolean | null;
          created_at?: string;
          deleted_at?: string | null;
          error?: string | null;
          exporter?: string | null;
          from_date?: string | null;
          generated_at?: string;
          id?: string;
          status?: string;
          tenancy_id?: string | null;
          to_date?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'evidence_exports_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'evidence_exports_account_id_attachment_id_fkey';
            columns: ['account_id', 'attachment_id'];
            isOneToOne: false;
            referencedRelation: 'attachments';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'evidence_exports_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'evidence_exports_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      idempotency_keys: {
        Row: {
          account_id: string;
          body: Json | null;
          completed_at: string | null;
          created_at: string;
          expires_at: string;
          key: string;
          request_fingerprint: string;
          status_code: number | null;
        };
        Insert: {
          account_id: string;
          body?: Json | null;
          completed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          key: string;
          request_fingerprint: string;
          status_code?: number | null;
        };
        Update: {
          account_id?: string;
          body?: Json | null;
          completed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          key?: string;
          request_fingerprint?: string;
          status_code?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'idempotency_keys_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      import_provenance: {
        Row: {
          account_id: string;
          created_at: string;
          entity_id: string;
          entity_type: string;
          id: string;
          region_index: number | null;
          row_index: number | null;
          session_id: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          entity_id: string;
          entity_type: string;
          id?: string;
          region_index?: number | null;
          row_index?: number | null;
          session_id: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          entity_id?: string;
          entity_type?: string;
          id?: string;
          region_index?: number | null;
          row_index?: number | null;
          session_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'import_provenance_account_id_session_id_fkey';
            columns: ['account_id', 'session_id'];
            isOneToOne: false;
            referencedRelation: 'import_sessions';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      import_rows: {
        Row: {
          account_id: string;
          blockers: Json;
          created_at: string;
          excluded: boolean;
          id: string;
          raw: Json;
          region_index: number;
          row_index: number;
          session_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          blockers?: Json;
          created_at?: string;
          excluded?: boolean;
          id?: string;
          raw?: Json;
          region_index: number;
          row_index: number;
          session_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          blockers?: Json;
          created_at?: string;
          excluded?: boolean;
          id?: string;
          raw?: Json;
          region_index?: number;
          row_index?: number;
          session_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'import_rows_account_id_session_id_fkey';
            columns: ['account_id', 'session_id'];
            isOneToOne: false;
            referencedRelation: 'import_sessions';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      import_sessions: {
        Row: {
          account_id: string;
          chat: Json;
          created_at: string;
          deleted_at: string | null;
          error: string | null;
          id: string;
          mapping: Json;
          parent_resolutions: Json;
          preview_summary: Json | null;
          recognition: Json;
          regions: Json;
          result: Json | null;
          source_bytes: number | null;
          source_filename: string;
          source_mime: string | null;
          source_path: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          chat?: Json;
          created_at?: string;
          deleted_at?: string | null;
          error?: string | null;
          id?: string;
          mapping?: Json;
          parent_resolutions?: Json;
          preview_summary?: Json | null;
          recognition?: Json;
          regions?: Json;
          result?: Json | null;
          source_bytes?: number | null;
          source_filename: string;
          source_mime?: string | null;
          source_path?: string | null;
          status: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          chat?: Json;
          created_at?: string;
          deleted_at?: string | null;
          error?: string | null;
          id?: string;
          mapping?: Json;
          parent_resolutions?: Json;
          preview_summary?: Json | null;
          recognition?: Json;
          regions?: Json;
          result?: Json | null;
          source_bytes?: number | null;
          source_filename?: string;
          source_mime?: string | null;
          source_path?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'import_sessions_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      inbound_provenance: {
        Row: {
          account_id: string;
          body_sha256: string;
          created_at: string;
          id: string;
          provider: string;
          provider_msg_id: string;
          purged_at: string | null;
          received_at: string;
          signature: string | null;
          signature_timestamp: string | null;
          storage_path: string;
        };
        Insert: {
          account_id: string;
          body_sha256: string;
          created_at?: string;
          id?: string;
          provider: string;
          provider_msg_id: string;
          purged_at?: string | null;
          received_at: string;
          signature?: string | null;
          signature_timestamp?: string | null;
          storage_path: string;
        };
        Update: {
          account_id?: string;
          body_sha256?: string;
          created_at?: string;
          id?: string;
          provider?: string;
          provider_msg_id?: string;
          purged_at?: string | null;
          received_at?: string;
          signature?: string | null;
          signature_timestamp?: string | null;
          storage_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inbound_provenance_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      inbound_raw: {
        Row: {
          disposition: string | null;
          id: string;
          matched_account_id: string | null;
          matched_interaction_id: string | null;
          matched_participant_id: string | null;
          matched_thread_id: string | null;
          payload: Json;
          provider: string;
          provider_msg_id: string;
          received_at: string;
          rfc822_message_id: string | null;
        };
        Insert: {
          disposition?: string | null;
          id?: string;
          matched_account_id?: string | null;
          matched_interaction_id?: string | null;
          matched_participant_id?: string | null;
          matched_thread_id?: string | null;
          payload: Json;
          provider: string;
          provider_msg_id: string;
          received_at?: string;
          rfc822_message_id?: string | null;
        };
        Update: {
          disposition?: string | null;
          id?: string;
          matched_account_id?: string | null;
          matched_interaction_id?: string | null;
          matched_participant_id?: string | null;
          matched_thread_id?: string | null;
          payload?: Json;
          provider?: string;
          provider_msg_id?: string;
          received_at?: string;
          rfc822_message_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'inbound_raw_matched_account_id_fkey';
            columns: ['matched_account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      inspection_capture_tokens: {
        Row: {
          account_id: string;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          expires_at: string;
          id: string;
          inspection_id: string;
          last_used_at: string | null;
          revoked_at: string | null;
          secret_hash: string;
          tenant_id: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          expires_at: string;
          id?: string;
          inspection_id: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          secret_hash: string;
          tenant_id?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          expires_at?: string;
          id?: string;
          inspection_id?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          secret_hash?: string;
          tenant_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inspection_capture_tokens_account_id_inspection_id_fkey';
            columns: ['account_id', 'inspection_id'];
            isOneToOne: false;
            referencedRelation: 'inspections';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'inspection_capture_tokens_account_id_tenant_id_fkey';
            columns: ['account_id', 'tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      inspection_checks: {
        Row: {
          account_id: string;
          answered_at: string | null;
          answered_by: string | null;
          created_at: string;
          deleted_at: string | null;
          field_key: string;
          group_label: string | null;
          id: string;
          inspection_id: string;
          label: string;
          sort_order: number | null;
          updated_at: string;
          value: Json | null;
        };
        Insert: {
          account_id: string;
          answered_at?: string | null;
          answered_by?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          field_key: string;
          group_label?: string | null;
          id?: string;
          inspection_id: string;
          label: string;
          sort_order?: number | null;
          updated_at?: string;
          value?: Json | null;
        };
        Update: {
          account_id?: string;
          answered_at?: string | null;
          answered_by?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          field_key?: string;
          group_label?: string | null;
          id?: string;
          inspection_id?: string;
          label?: string;
          sort_order?: number | null;
          updated_at?: string;
          value?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: 'inspection_checks_account_id_inspection_id_fkey';
            columns: ['account_id', 'inspection_id'];
            isOneToOne: false;
            referencedRelation: 'inspections';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      inspection_items: {
        Row: {
          account_id: string;
          change_type: string | null;
          condition: string | null;
          created_at: string;
          deleted_at: string | null;
          group_label: string | null;
          id: string;
          inspection_id: string;
          item_key: string | null;
          label: string;
          notes: string | null;
          sort_order: number | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          change_type?: string | null;
          condition?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          group_label?: string | null;
          id?: string;
          inspection_id: string;
          item_key?: string | null;
          label: string;
          notes?: string | null;
          sort_order?: number | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          change_type?: string | null;
          condition?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          group_label?: string | null;
          id?: string;
          inspection_id?: string;
          item_key?: string | null;
          label?: string;
          notes?: string | null;
          sort_order?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inspection_items_account_id_inspection_id_fkey';
            columns: ['account_id', 'inspection_id'];
            isOneToOne: false;
            referencedRelation: 'inspections';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      inspection_room_confirmations: {
        Row: {
          account_id: string;
          confirmed_at: string;
          confirmed_by: string | null;
          created_at: string;
          deleted_at: string | null;
          group_label: string;
          id: string;
          inspection_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          confirmed_at?: string;
          confirmed_by?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          group_label: string;
          id?: string;
          inspection_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          confirmed_at?: string;
          confirmed_by?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          group_label?: string;
          id?: string;
          inspection_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inspection_room_confirmations_account_id_inspection_id_fkey';
            columns: ['account_id', 'inspection_id'];
            isOneToOne: false;
            referencedRelation: 'inspections';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      inspection_templates: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          jurisdiction: string | null;
          name: string;
          schema: Json;
          updated_at: string;
          version: string | null;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          jurisdiction?: string | null;
          name: string;
          schema?: Json;
          updated_at?: string;
          version?: string | null;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          jurisdiction?: string | null;
          name?: string;
          schema?: Json;
          updated_at?: string;
          version?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'inspection_templates_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      inspections: {
        Row: {
          account_id: string;
          area_id: string;
          baseline_inspection_id: string | null;
          capture_mode: string;
          completed_at: string | null;
          created_at: string;
          deleted_at: string | null;
          form_opened_at: string | null;
          form_started_at: string | null;
          id: string;
          kind: string;
          link_delivered_at: string | null;
          notes: string | null;
          performed_at: string | null;
          performed_by: string | null;
          status: string;
          subject_snapshot: Json | null;
          submitted_at: string | null;
          supersedes_inspection_id: string | null;
          template_id: string | null;
          template_snapshot: Json | null;
          tenancy_id: string | null;
          updated_at: string;
          void_reason: string | null;
          voided_at: string | null;
        };
        Insert: {
          account_id: string;
          area_id: string;
          baseline_inspection_id?: string | null;
          capture_mode?: string;
          completed_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          form_opened_at?: string | null;
          form_started_at?: string | null;
          id?: string;
          kind?: string;
          link_delivered_at?: string | null;
          notes?: string | null;
          performed_at?: string | null;
          performed_by?: string | null;
          status?: string;
          subject_snapshot?: Json | null;
          submitted_at?: string | null;
          supersedes_inspection_id?: string | null;
          template_id?: string | null;
          template_snapshot?: Json | null;
          tenancy_id?: string | null;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
        };
        Update: {
          account_id?: string;
          area_id?: string;
          baseline_inspection_id?: string | null;
          capture_mode?: string;
          completed_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          form_opened_at?: string | null;
          form_started_at?: string | null;
          id?: string;
          kind?: string;
          link_delivered_at?: string | null;
          notes?: string | null;
          performed_at?: string | null;
          performed_by?: string | null;
          status?: string;
          subject_snapshot?: Json | null;
          submitted_at?: string | null;
          supersedes_inspection_id?: string | null;
          template_id?: string | null;
          template_snapshot?: Json | null;
          tenancy_id?: string | null;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'inspections_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'inspections_account_id_template_id_fkey';
            columns: ['account_id', 'template_id'];
            isOneToOne: false;
            referencedRelation: 'inspection_templates';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'inspections_baseline_fk';
            columns: ['account_id', 'baseline_inspection_id'];
            isOneToOne: false;
            referencedRelation: 'inspections';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'inspections_supersedes_fk';
            columns: ['account_id', 'supersedes_inspection_id'];
            isOneToOne: false;
            referencedRelation: 'inspections';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'inspections_tenancy_fk';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      intake_tokens: {
        Row: {
          account_id: string;
          created_at: string;
          id: string;
          last_used_at: string | null;
          property_id: string;
          revoked_at: string | null;
          secret_hash: string;
          tenancy_id: string;
          updated_at: string;
          use_count: number;
          use_window_start: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          property_id: string;
          revoked_at?: string | null;
          secret_hash: string;
          tenancy_id: string;
          updated_at?: string;
          use_count?: number;
          use_window_start?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          property_id?: string;
          revoked_at?: string | null;
          secret_hash?: string;
          tenancy_id?: string;
          updated_at?: string;
          use_count?: number;
          use_window_start?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'intake_tokens_account_id_property_id_fkey';
            columns: ['account_id', 'property_id'];
            isOneToOne: false;
            referencedRelation: 'properties';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'intake_tokens_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      interaction_participants: {
        Row: {
          account_id: string;
          address: string | null;
          created_at: string;
          id: string;
          interaction_id: string;
          label: string | null;
          party_id: string | null;
          party_type: string;
          role: string;
          source: string;
        };
        Insert: {
          account_id: string;
          address?: string | null;
          created_at?: string;
          id?: string;
          interaction_id: string;
          label?: string | null;
          party_id?: string | null;
          party_type: string;
          role: string;
          source: string;
        };
        Update: {
          account_id?: string;
          address?: string | null;
          created_at?: string;
          id?: string;
          interaction_id?: string;
          label?: string | null;
          party_id?: string | null;
          party_type?: string;
          role?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'interaction_participants_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'interaction_participants_account_id_interaction_id_fkey';
            columns: ['account_id', 'interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interaction_participants_account_id_interaction_id_fkey';
            columns: ['account_id', 'interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interaction_participants_account_id_interaction_id_fkey';
            columns: ['account_id', 'interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
        ];
      };
      interactions: {
        Row: {
          account_id: string;
          actor: string;
          approval_ref: string | null;
          approved_by: string | null;
          area_id: string | null;
          attestation: string | null;
          author_type: string | null;
          body: string | null;
          channel: string;
          correction_kind: string | null;
          corrects_id: string | null;
          created_at: string;
          deleted_at: string | null;
          direction: string;
          entry_type: string | null;
          external_ref: string | null;
          id: string;
          kind: string;
          logged_at: string;
          maintenance_request_id: string | null;
          occurred_at: string;
          party_id: string | null;
          party_label: string | null;
          party_type: string;
          references_interaction_id: string | null;
          rfc822_message_id: string | null;
          tenancy_id: string | null;
          thread_id: string | null;
          updated_at: string;
          vendor_id: string | null;
          work_order_id: string | null;
        };
        Insert: {
          account_id: string;
          actor: string;
          approval_ref?: string | null;
          approved_by?: string | null;
          area_id?: string | null;
          attestation?: string | null;
          author_type?: string | null;
          body?: string | null;
          channel: string;
          correction_kind?: string | null;
          corrects_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          direction: string;
          entry_type?: string | null;
          external_ref?: string | null;
          id?: string;
          kind?: string;
          logged_at?: string;
          maintenance_request_id?: string | null;
          occurred_at: string;
          party_id?: string | null;
          party_label?: string | null;
          party_type: string;
          references_interaction_id?: string | null;
          rfc822_message_id?: string | null;
          tenancy_id?: string | null;
          thread_id?: string | null;
          updated_at?: string;
          vendor_id?: string | null;
          work_order_id?: string | null;
        };
        Update: {
          account_id?: string;
          actor?: string;
          approval_ref?: string | null;
          approved_by?: string | null;
          area_id?: string | null;
          attestation?: string | null;
          author_type?: string | null;
          body?: string | null;
          channel?: string;
          correction_kind?: string | null;
          corrects_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          direction?: string;
          entry_type?: string | null;
          external_ref?: string | null;
          id?: string;
          kind?: string;
          logged_at?: string;
          maintenance_request_id?: string | null;
          occurred_at?: string;
          party_id?: string | null;
          party_label?: string | null;
          party_type?: string;
          references_interaction_id?: string | null;
          rfc822_message_id?: string | null;
          tenancy_id?: string | null;
          thread_id?: string | null;
          updated_at?: string;
          vendor_id?: string | null;
          work_order_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'interactions_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'interactions_account_id_maintenance_request_id_fkey';
            columns: ['account_id', 'maintenance_request_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_requests';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_vendor_id_fkey';
            columns: ['account_id', 'vendor_id'];
            isOneToOne: false;
            referencedRelation: 'vendors';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_work_order_id_fkey';
            columns: ['account_id', 'work_order_id'];
            isOneToOne: false;
            referencedRelation: 'work_orders';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_approved_by_fkey';
            columns: ['approved_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'interactions_corrects_id_fkey';
            columns: ['account_id', 'corrects_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_corrects_id_fkey';
            columns: ['account_id', 'corrects_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_corrects_id_fkey';
            columns: ['account_id', 'corrects_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
          {
            foreignKeyName: 'interactions_references_interaction_fk';
            columns: ['account_id', 'references_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_references_interaction_fk';
            columns: ['account_id', 'references_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_references_interaction_fk';
            columns: ['account_id', 'references_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
          {
            foreignKeyName: 'interactions_thread_fk';
            columns: ['account_id', 'thread_id'];
            isOneToOne: false;
            referencedRelation: 'comm_threads';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      ip_rate_buckets: {
        Row: {
          count: number;
          ip: string;
          scope: string;
          updated_at: string;
          window_start: string;
        };
        Insert: {
          count?: number;
          ip: string;
          scope: string;
          updated_at?: string;
          window_start?: string;
        };
        Update: {
          count?: number;
          ip?: string;
          scope?: string;
          updated_at?: string;
          window_start?: string;
        };
        Relationships: [];
      };
      leases: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          deposit_amount_cents: number;
          deposit_currency: string | null;
          document: Json;
          id: string;
          rent_amount_cents: number;
          rent_currency: string;
          status: string;
          tenancy_id: string;
          term_end: string | null;
          term_start: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          deposit_amount_cents?: number;
          deposit_currency?: string | null;
          document?: Json;
          id?: string;
          rent_amount_cents: number;
          rent_currency: string;
          status: string;
          tenancy_id: string;
          term_end?: string | null;
          term_start: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          deposit_amount_cents?: number;
          deposit_currency?: string | null;
          document?: Json;
          id?: string;
          rent_amount_cents?: number;
          rent_currency?: string;
          status?: string;
          tenancy_id?: string;
          term_end?: string | null;
          term_start?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'leases_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      maintenance_requests: {
        Row: {
          account_id: string;
          area_id: string;
          asset_id: string | null;
          created_at: string;
          deleted_at: string | null;
          description: string | null;
          id: string;
          intake_token: string | null;
          opened_by: string | null;
          severity: string;
          status: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          area_id: string;
          asset_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          id?: string;
          intake_token?: string | null;
          opened_by?: string | null;
          severity: string;
          status: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          area_id?: string;
          asset_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          id?: string;
          intake_token?: string | null;
          opened_by?: string | null;
          severity?: string;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'maintenance_requests_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'maintenance_requests_account_id_asset_id_fkey';
            columns: ['account_id', 'asset_id'];
            isOneToOne: false;
            referencedRelation: 'assets';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      notices: {
        Row: {
          account_id: string;
          body: string | null;
          created_at: string;
          deleted_at: string | null;
          document: Json;
          id: string;
          notice_type: string;
          served_at: string | null;
          served_method: string | null;
          tenancy_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          body?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          document?: Json;
          id?: string;
          notice_type: string;
          served_at?: string | null;
          served_method?: string | null;
          tenancy_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          body?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          document?: Json;
          id?: string;
          notice_type?: string;
          served_at?: string | null;
          served_method?: string | null;
          tenancy_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notices_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      payment_allocations: {
        Row: {
          account_id: string;
          amount_cents: number;
          charge_id: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          payment_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          amount_cents: number;
          charge_id: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          payment_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          amount_cents?: number;
          charge_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          payment_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'payment_allocations_account_id_charge_id_fkey';
            columns: ['account_id', 'charge_id'];
            isOneToOne: false;
            referencedRelation: 'charges';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'payment_allocations_account_id_payment_id_fkey';
            columns: ['account_id', 'payment_id'];
            isOneToOne: false;
            referencedRelation: 'payments';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      payments: {
        Row: {
          account_id: string;
          amount_cents: number;
          created_at: string;
          currency: string;
          deleted_at: string | null;
          id: string;
          idempotency_key: string | null;
          method: string;
          notes: string | null;
          payer_tenant_id: string | null;
          processor_ref: string | null;
          received_at: string;
          reference: string | null;
          tenancy_id: string;
          updated_at: string;
          void_reason: string | null;
          voided_at: string | null;
        };
        Insert: {
          account_id: string;
          amount_cents: number;
          created_at?: string;
          currency: string;
          deleted_at?: string | null;
          id?: string;
          idempotency_key?: string | null;
          method: string;
          notes?: string | null;
          payer_tenant_id?: string | null;
          processor_ref?: string | null;
          received_at: string;
          reference?: string | null;
          tenancy_id: string;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
        };
        Update: {
          account_id?: string;
          amount_cents?: number;
          created_at?: string;
          currency?: string;
          deleted_at?: string | null;
          id?: string;
          idempotency_key?: string | null;
          method?: string;
          notes?: string | null;
          payer_tenant_id?: string | null;
          processor_ref?: string | null;
          received_at?: string;
          reference?: string | null;
          tenancy_id?: string;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'payments_account_id_payer_tenant_id_fkey';
            columns: ['account_id', 'payer_tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'payments_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      platform_numbers: {
        Row: {
          account_id: string;
          capabilities: string[];
          created_at: string;
          id: string;
          number: string;
          provider: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          capabilities?: string[];
          created_at?: string;
          id?: string;
          number: string;
          provider: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          capabilities?: string[];
          created_at?: string;
          id?: string;
          number?: string;
          provider?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'platform_numbers_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      properties: {
        Row: {
          account_id: string;
          address: Json;
          created_at: string;
          deleted_at: string | null;
          id: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          address?: Json;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          address?: Json;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'properties_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      rent_schedules: {
        Row: {
          account_id: string;
          amount_cents: number;
          change_reason: string | null;
          created_at: string;
          currency: string;
          deleted_at: string | null;
          due_day: number;
          end_date: string | null;
          id: string;
          kind: string;
          source_lease_id: string | null;
          source_notice_id: string | null;
          start_date: string;
          tenancy_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          amount_cents: number;
          change_reason?: string | null;
          created_at?: string;
          currency: string;
          deleted_at?: string | null;
          due_day: number;
          end_date?: string | null;
          id?: string;
          kind: string;
          source_lease_id?: string | null;
          source_notice_id?: string | null;
          start_date: string;
          tenancy_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          amount_cents?: number;
          change_reason?: string | null;
          created_at?: string;
          currency?: string;
          deleted_at?: string | null;
          due_day?: number;
          end_date?: string | null;
          id?: string;
          kind?: string;
          source_lease_id?: string | null;
          source_notice_id?: string | null;
          start_date?: string;
          tenancy_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'rent_schedules_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'rent_schedules_source_lease_fk';
            columns: ['account_id', 'source_lease_id'];
            isOneToOne: false;
            referencedRelation: 'leases';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'rent_schedules_source_notice_fk';
            columns: ['account_id', 'source_notice_id'];
            isOneToOne: false;
            referencedRelation: 'notices';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      scheduled_task_runs: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          generated_at: string;
          id: string;
          period_start: string;
          task_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          generated_at?: string;
          id?: string;
          period_start: string;
          task_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          generated_at?: string;
          id?: string;
          period_start?: string;
          task_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scheduled_task_runs_account_id_task_id_fkey';
            columns: ['account_id', 'task_id'];
            isOneToOne: false;
            referencedRelation: 'scheduled_tasks';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      scheduled_tasks: {
        Row: {
          account_id: string;
          area_id: string | null;
          asset_id: string | null;
          created_at: string;
          deleted_at: string | null;
          id: string;
          kind: string;
          last_run: string | null;
          next_run: string | null;
          recurrence: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          area_id?: string | null;
          asset_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind: string;
          last_run?: string | null;
          next_run?: string | null;
          recurrence: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          area_id?: string | null;
          asset_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind?: string;
          last_run?: string | null;
          next_run?: string | null;
          recurrence?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scheduled_tasks_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'scheduled_tasks_account_id_asset_id_fkey';
            columns: ['account_id', 'asset_id'];
            isOneToOne: false;
            referencedRelation: 'assets';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      tenancies: {
        Row: {
          account_id: string;
          area_id: string;
          created_at: string;
          deleted_at: string | null;
          end_date: string | null;
          id: string;
          start_date: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          area_id: string;
          created_at?: string;
          deleted_at?: string | null;
          end_date?: string | null;
          id?: string;
          start_date: string;
          status: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          area_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          end_date?: string | null;
          id?: string;
          start_date?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tenancies_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      tenancy_tenants: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          role: string;
          tenancy_id: string;
          tenant_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          role: string;
          tenancy_id: string;
          tenant_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          role?: string;
          tenancy_id?: string;
          tenant_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tenancy_tenants_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'tenancy_tenants_account_id_tenant_id_fkey';
            columns: ['account_id', 'tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      tenants: {
        Row: {
          account_id: string;
          created_at: string;
          deleted_at: string | null;
          emails: string[];
          full_name: string;
          id: string;
          notes: string | null;
          phones: string[];
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          deleted_at?: string | null;
          emails?: string[];
          full_name: string;
          id?: string;
          notes?: string | null;
          phones?: string[];
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          emails?: string[];
          full_name?: string;
          id?: string;
          notes?: string | null;
          phones?: string[];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tenants_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      thread_channel_bindings: {
        Row: {
          account_id: string;
          active: boolean;
          channel: string;
          created_at: string;
          id: string;
          participant_address: string;
          participant_id: string;
          platform_number: string | null;
          reply_address: string | null;
          thread_id: string;
          thread_mode: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          active?: boolean;
          channel?: string;
          created_at?: string;
          id?: string;
          participant_address: string;
          participant_id: string;
          platform_number?: string | null;
          reply_address?: string | null;
          thread_id: string;
          thread_mode?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          active?: boolean;
          channel?: string;
          created_at?: string;
          id?: string;
          participant_address?: string;
          participant_id?: string;
          platform_number?: string | null;
          reply_address?: string | null;
          thread_id?: string;
          thread_mode?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'thread_channel_bindings_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'thread_channel_bindings_account_id_participant_id_fkey';
            columns: ['account_id', 'participant_id'];
            isOneToOne: false;
            referencedRelation: 'comm_thread_participants';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'thread_channel_bindings_account_id_thread_id_fkey';
            columns: ['account_id', 'thread_id'];
            isOneToOne: false;
            referencedRelation: 'comm_threads';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'thread_channel_bindings_platform_number_fkey';
            columns: ['account_id', 'platform_number'];
            isOneToOne: false;
            referencedRelation: 'platform_numbers';
            referencedColumns: ['account_id', 'number'];
          },
        ];
      };
      unit_details: {
        Row: {
          account_id: string;
          area_id: string;
          bathrooms: number | null;
          bedrooms: number | null;
          created_at: string;
          sqft: number | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          area_id: string;
          bathrooms?: number | null;
          bedrooms?: number | null;
          created_at?: string;
          sqft?: number | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          area_id?: string;
          bathrooms?: number | null;
          bedrooms?: number | null;
          created_at?: string;
          sqft?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'unit_details_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
      users: {
        Row: {
          created_at: string;
          deleted_at: string | null;
          display_name: string | null;
          id: string;
          phone: string | null;
          phone_verified_at: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          deleted_at?: string | null;
          display_name?: string | null;
          id: string;
          phone?: string | null;
          phone_verified_at?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          deleted_at?: string | null;
          display_name?: string | null;
          id?: string;
          phone?: string | null;
          phone_verified_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      vendors: {
        Row: {
          account_id: string;
          contact: Json;
          created_at: string;
          deleted_at: string | null;
          id: string;
          name: string;
          notes: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          contact?: Json;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name: string;
          notes?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          contact?: Json;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name?: string;
          notes?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'vendors_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      work_orders: {
        Row: {
          account_id: string;
          area_id: string;
          completed_at: string | null;
          cost_cents: number | null;
          cost_currency: string | null;
          created_at: string;
          deleted_at: string | null;
          id: string;
          maintenance_request_id: string | null;
          scheduled_for: string | null;
          status: string;
          summary: string;
          updated_at: string;
          vendor_id: string | null;
        };
        Insert: {
          account_id: string;
          area_id: string;
          completed_at?: string | null;
          cost_cents?: number | null;
          cost_currency?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          maintenance_request_id?: string | null;
          scheduled_for?: string | null;
          status: string;
          summary: string;
          updated_at?: string;
          vendor_id?: string | null;
        };
        Update: {
          account_id?: string;
          area_id?: string;
          completed_at?: string | null;
          cost_cents?: number | null;
          cost_currency?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          maintenance_request_id?: string | null;
          scheduled_for?: string | null;
          status?: string;
          summary?: string;
          updated_at?: string;
          vendor_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'work_orders_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'work_orders_account_id_maintenance_request_id_fkey';
            columns: ['account_id', 'maintenance_request_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_requests';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'work_orders_account_id_vendor_id_fkey';
            columns: ['account_id', 'vendor_id'];
            isOneToOne: false;
            referencedRelation: 'vendors';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
    };
    Views: {
      interactions_with_chain: {
        Row: {
          account_id: string | null;
          actor: string | null;
          approval_ref: string | null;
          approved_by: string | null;
          area_id: string | null;
          attestation: string | null;
          author_type: string | null;
          body: string | null;
          channel: string | null;
          correction_kind: string | null;
          corrects_id: string | null;
          created_at: string | null;
          deleted_at: string | null;
          delivered_at: string | null;
          delivery_status: string | null;
          direction: string | null;
          entry_type: string | null;
          external_ref: string | null;
          id: string | null;
          is_head: boolean | null;
          kind: string | null;
          logged_at: string | null;
          maintenance_request_id: string | null;
          occurred_at: string | null;
          outbox_id: string | null;
          party_id: string | null;
          party_label: string | null;
          party_type: string | null;
          references_interaction_id: string | null;
          rfc822_message_id: string | null;
          superseded_by_id: string | null;
          tenancy_id: string | null;
          thread_id: string | null;
          updated_at: string | null;
          vendor_id: string | null;
          work_order_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'interactions_account_id_area_id_fkey';
            columns: ['account_id', 'area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'interactions_account_id_maintenance_request_id_fkey';
            columns: ['account_id', 'maintenance_request_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_requests';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_tenancy_id_fkey';
            columns: ['account_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_vendor_id_fkey';
            columns: ['account_id', 'vendor_id'];
            isOneToOne: false;
            referencedRelation: 'vendors';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_account_id_work_order_id_fkey';
            columns: ['account_id', 'work_order_id'];
            isOneToOne: false;
            referencedRelation: 'work_orders';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_approved_by_fkey';
            columns: ['approved_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'interactions_corrects_id_fkey';
            columns: ['account_id', 'corrects_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_corrects_id_fkey';
            columns: ['account_id', 'corrects_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_corrects_id_fkey';
            columns: ['account_id', 'corrects_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
          {
            foreignKeyName: 'interactions_references_interaction_fk';
            columns: ['account_id', 'references_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_references_interaction_fk';
            columns: ['account_id', 'references_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'id'];
          },
          {
            foreignKeyName: 'interactions_references_interaction_fk';
            columns: ['account_id', 'references_interaction_id'];
            isOneToOne: false;
            referencedRelation: 'interactions_with_chain';
            referencedColumns: ['account_id', 'superseded_by_id'];
          },
          {
            foreignKeyName: 'interactions_thread_fk';
            columns: ['account_id', 'thread_id'];
            isOneToOne: false;
            referencedRelation: 'comm_threads';
            referencedColumns: ['account_id', 'id'];
          },
        ];
      };
    };
    Functions: {
      _comm_group_routing_key: {
        Args: { p_members: string[]; p_number: string };
        Returns: string;
      };
      _comm_journal_channel: { Args: { p_channel: string }; Returns: string };
      _comm_normalize_msgid: { Args: { p_raw: string }; Returns: string };
      _party_display_name: {
        Args: { p_account_id: string; p_party_id: string; p_party_type: string };
        Returns: string;
      };
      _persona_find_or_create_thread: {
        Args: {
          p_account_id: string;
          p_cp_address: string;
          p_cp_id: string;
          p_cp_type: string;
          p_landlord_address?: string;
          p_landlord_user_id?: string;
          p_reply_domain: string;
          p_subject: string;
        };
        Returns: {
          cp_participant_id: string;
          tenancy_id: string;
          thread_id: string;
        }[];
      };
      _persona_record_unmatched: {
        Args: {
          p_account_id: string;
          p_body: string;
          p_cc_addresses: string[];
          p_dkim: string;
          p_dmarc: string;
          p_from_address: string;
          p_from_display_name: string;
          p_media: Json;
          p_persona_address: string;
          p_provider: string;
          p_provider_msg_id: string;
          p_reason: string;
          p_received_at: string;
          p_rfc822_message_id: string;
          p_spf: string;
          p_subject: string;
          p_to_addresses: string[];
        };
        Returns: string;
      };
      _storage_path_account_id: { Args: { p_name: string }; Returns: string };
      _tenant_stamp_form_started: {
        Args: { p_account_id: string; p_inspection_id: string };
        Returns: undefined;
      };
      advance_tenancy_statuses: {
        Args: { p_as_of?: string };
        Returns: {
          o_account_id: string;
          o_start_date: string;
          o_tenancy_id: string;
        }[];
      };
      bump_ip_rate_bucket: {
        Args: { p_ip: string; p_scope: string; p_window_sec: number };
        Returns: number;
      };
      capture_inbound: {
        Args: {
          p_account_id: string;
          p_auth_results?: Json;
          p_body: string;
          p_cc?: string[];
          p_channel: string;
          p_from_address: string;
          p_in_reply_to?: string;
          p_media: Json;
          p_provider: string;
          p_provider_msg_id: string;
          p_received_at: string;
          p_references?: string[];
          p_rfc822_message_id?: string;
          p_subject?: string;
          p_to_number: string;
        };
        Returns: {
          disposition: string;
          interaction_id: string;
          participant_id: string;
          thread_id: string;
        }[];
      };
      capture_persona_inbound: {
        Args: {
          p_account_id: string;
          p_body: string;
          p_cc_addresses: string[];
          p_dkim: string;
          p_dmarc: string;
          p_from_address: string;
          p_from_display_name: string;
          p_in_reply_to: string;
          p_media: Json;
          p_persona_address: string;
          p_provider: string;
          p_provider_msg_id: string;
          p_received_at: string;
          p_references: string[];
          p_reply_domain: string;
          p_rfc822_message_id: string;
          p_spf: string;
          p_subject: string;
          p_to_addresses: string[];
        };
        Returns: {
          disposition: string;
          interaction_id: string;
          participant_id: string;
          thread_id: string;
          unmatched_id: string;
        }[];
      };
      change_tenancy_rent: {
        Args: {
          p_account_id: string;
          p_amount_cents: number;
          p_change_reason?: string;
          p_currency: string;
          p_due_day?: number;
          p_effective_date: string;
          p_kind?: string;
          p_source_lease_id?: string;
          p_source_notice_id?: string;
          p_tenancy_id: string;
        };
        Returns: {
          o_ended_schedule_ids: string[];
          o_schedule_id: string;
          o_superseded_lease_ids: string[];
          o_voided_charge_ids: string[];
        }[];
      };
      claim_idempotency_key: {
        Args: { p_account_id: string; p_fingerprint: string; p_key: string };
        Returns: {
          body: Json;
          claimed: boolean;
          fingerprint_matches: boolean;
          in_flight: boolean;
          status_code: number;
        }[];
      };
      complete_evidence_export: {
        Args: {
          p_attachment_id: string;
          p_chain_message: string;
          p_chain_verified: boolean;
          p_content_hash: string;
          p_evidence_export_id: string;
          p_generated_at: string;
          p_size_bytes: number;
          p_storage_path: string;
        };
        Returns: undefined;
      };
      complete_idempotency_key: {
        Args: {
          p_account_id: string;
          p_body: Json;
          p_key: string;
          p_status: number;
        };
        Returns: undefined;
      };
      complete_send: {
        Args: {
          p_outbox_id: string;
          p_provider: string;
          p_provider_sid: string;
          p_rfc822_message_id?: string;
        };
        Returns: string;
      };
      create_account_for_new_user: {
        Args: { p_account_name: string; p_display_name?: string };
        Returns: {
          account_id: string;
          role: string;
        }[];
      };
      create_payment_with_allocations: {
        Args: {
          p_account_id: string;
          p_allocations: Json;
          p_amount_cents: number;
          p_currency: string;
          p_method: string;
          p_notes: string;
          p_payer_tenant_id: string;
          p_received_at: string;
          p_reference: string;
          p_tenancy_id: string;
        };
        Returns: {
          allocations: Json;
          payment: Json;
        }[];
      };
      create_tenancy_document: {
        Args: {
          p_account_id: string;
          p_attachment_path?: string;
          p_content_hash: string;
          p_document_type: string;
          p_mime_type: string;
          p_requires_ack: boolean;
          p_size_bytes: number;
          p_source: string;
          p_static_asset_path?: string;
          p_static_template_id?: string;
          p_tenancy_id: string;
          p_title: string;
        };
        Returns: Json;
      };
      detect_rent_drift: {
        Args: { p_account_id: string };
        Returns: {
          o_auto_charge_enabled: boolean;
          o_lease_amount_cents: number;
          o_lease_currency: string;
          o_lease_id: string;
          o_schedule_currencies: string[];
          o_schedule_total_cents: number;
          o_tenancy_id: string;
        }[];
      };
      dismiss_unmatched_inbound: {
        Args: { p_account_id: string; p_unmatched_id: string };
        Returns: {
          account_id: string;
          auto_acked_at: string | null;
          body: string | null;
          cc_addresses: string[];
          created_at: string;
          dkim: string | null;
          dmarc: string | null;
          from_address: string;
          from_display_name: string | null;
          id: string;
          linked_interaction_id: string | null;
          linked_party_id: string | null;
          linked_party_type: string | null;
          linked_thread_id: string | null;
          media: Json;
          persona_address: string;
          provider: string;
          provider_msg_id: string;
          reason: string;
          received_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
          rfc822_message_id: string | null;
          spf: string | null;
          status: string;
          subject: string | null;
          to_addresses: string[];
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'comm_unmatched_inbound';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      emit_inspection_report_document: {
        Args: {
          p_account_id: string;
          p_attachment_id: string;
          p_content_hash: string;
          p_inspection_id: string;
          p_requires_ack?: boolean;
          p_size_bytes: number;
          p_title: string;
        };
        Returns: Json;
      };
      entity_history: {
        Args: { p_entity_id: string; p_entity_type: string };
        Returns: {
          account_id: string;
          account_seq: number;
          actor: string;
          entity_id: string;
          entity_type: string;
          event_hash: string;
          event_type: string;
          id: string;
          occurred_at: string;
          payload: Json;
          prev_event_hash: string | null;
        }[];
        SetofOptions: {
          from: '*';
          to: 'events';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      fail_send: {
        Args: {
          p_detail?: string;
          p_error_code: string;
          p_outbox_id: string;
          p_reconcile?: boolean;
        };
        Returns: {
          account_id: string;
          approval_ref: string;
          approved_by: string | null;
          author_type: string;
          body: string;
          channel: string;
          client_ref: string;
          created_at: string;
          delivered_at: string | null;
          error_code: string | null;
          error_message: string | null;
          group_addresses: string[] | null;
          id: string;
          interaction_id: string | null;
          maintenance_request_id: string | null;
          not_before: string | null;
          participant_id: string | null;
          provider: string | null;
          provider_sid: string | null;
          recipient_snapshot: Json | null;
          relay_of_interaction_id: string | null;
          rfc822_message_id: string | null;
          status: string;
          subject: string | null;
          template_id: string | null;
          tenancy_id: string | null;
          thread_id: string | null;
          to_address: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'comm_outbox';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      generate_rent_charges: {
        Args: { p_account_id: string; p_as_of: string };
        Returns: {
          o_amount_cents: number;
          o_charge_id: string;
          o_period_start: string;
          o_schedule_id: string;
        }[];
      };
      generate_scheduled_task_runs: {
        Args: { p_account_id: string; p_as_of: string };
        Returns: {
          o_period_start: string;
          o_run_id: string;
          o_task_id: string;
        }[];
      };
      inspection_checkout_diff: {
        Args: { p_account_id: string; p_checkout_inspection_id: string };
        Returns: {
          baseline_id: string;
          baseline_photo_count: number;
          baseline_value: string;
          change_type: string;
          checkout_id: string;
          checkout_photo_count: number;
          checkout_value: string;
          group_label: string;
          key: string;
          label: string;
          row_type: string;
          status: string;
        }[];
      };
      is_account_member: { Args: { p_account_id: string }; Returns: boolean };
      is_address_opted_out: {
        Args: { p_address: string; p_channel: string };
        Returns: boolean;
      };
      is_approver_member: {
        Args: { p_account_id: string; p_user_id: string };
        Returns: boolean;
      };
      journal_with_participants: {
        Args: { p_account_id: string; p_entry: Json; p_participants: Json };
        Returns: {
          account_id: string;
          actor: string;
          approval_ref: string | null;
          approved_by: string | null;
          area_id: string | null;
          attestation: string | null;
          author_type: string | null;
          body: string | null;
          channel: string;
          correction_kind: string | null;
          corrects_id: string | null;
          created_at: string;
          deleted_at: string | null;
          direction: string;
          entry_type: string | null;
          external_ref: string | null;
          id: string;
          kind: string;
          logged_at: string;
          maintenance_request_id: string | null;
          occurred_at: string;
          party_id: string | null;
          party_label: string | null;
          party_type: string;
          references_interaction_id: string | null;
          rfc822_message_id: string | null;
          tenancy_id: string | null;
          thread_id: string | null;
          updated_at: string;
          vendor_id: string | null;
          work_order_id: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'interactions';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      link_unmatched_inbound: {
        Args: {
          p_account_id: string;
          p_party_id: string;
          p_party_type: string;
          p_reply_domain: string;
          p_unmatched_id: string;
        };
        Returns: {
          interaction_id: string;
          thread_id: string;
        }[];
      };
      list_account_opt_outs: {
        Args: { p_account_id: string; p_channel?: string };
        Returns: {
          address: string;
          channel: string;
          keyword: string | null;
          opted_out_at: string;
          source_ref: string | null;
        }[];
        SetofOptions: {
          from: '*';
          to: 'comm_opt_outs';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      normalize_search_text: { Args: { p_text: string }; Returns: string };
      prune_idempotency_keys: {
        Args: {
          p_completed_ttl_seconds?: number;
          p_in_flight_ttl_seconds?: number;
        };
        Returns: {
          pruned_completed: number;
          pruned_in_flight: number;
        }[];
      };
      prune_inbound_raw: { Args: { p_older_than?: string }; Returns: number };
      prune_ip_rate_buckets: {
        Args: { p_max_window_sec?: number };
        Returns: number;
      };
      reconcile_scan: {
        Args: { p_account_id: string; p_ttl_seconds?: number };
        Returns: {
          account_id: string;
          approval_ref: string;
          approved_by: string | null;
          author_type: string;
          body: string;
          channel: string;
          client_ref: string;
          created_at: string;
          delivered_at: string | null;
          error_code: string | null;
          error_message: string | null;
          group_addresses: string[] | null;
          id: string;
          interaction_id: string | null;
          maintenance_request_id: string | null;
          not_before: string | null;
          participant_id: string | null;
          provider: string | null;
          provider_sid: string | null;
          recipient_snapshot: Json | null;
          relay_of_interaction_id: string | null;
          rfc822_message_id: string | null;
          status: string;
          subject: string | null;
          template_id: string | null;
          tenancy_id: string | null;
          thread_id: string | null;
          to_address: string | null;
          updated_at: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'comm_outbox';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      record_inbound_provenance: {
        Args: {
          p_account_id: string;
          p_body_sha256: string;
          p_provider: string;
          p_provider_msg_id: string;
          p_received_at: string;
          p_signature: string;
          p_signature_timestamp: string;
          p_storage_path: string;
        };
        Returns: {
          account_id: string;
          body_sha256: string;
          created_at: string;
          id: string;
          provider: string;
          provider_msg_id: string;
          purged_at: string | null;
          received_at: string;
          signature: string | null;
          signature_timestamp: string | null;
          storage_path: string;
        };
        SetofOptions: {
          from: '*';
          to: 'inbound_provenance';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_opt_out: {
        Args: {
          p_account_id: string;
          p_address: string;
          p_channel: string;
          p_keyword: string;
          p_source_ref: string;
        };
        Returns: {
          address: string;
          channel: string;
          keyword: string | null;
          opted_out_at: string;
          source_ref: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'comm_opt_outs';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      search_entities: {
        Args: {
          p_account_id: string;
          p_exclude: string[];
          p_limit: number;
          p_q: string;
          p_types: string[];
        };
        Returns: {
          context: Json;
          entity_id: string;
          entity_type: string;
          score: number;
          subtitle: string;
          title: string;
        }[];
      };
      seed_inspection_items_from_template: {
        Args: {
          p_account_id: string;
          p_inspection_id: string;
          p_template_id?: string;
        };
        Returns: Json;
      };
      set_owner_phone_verified: {
        Args: { p_account_id: string; p_phone: string; p_user_id: string };
        Returns: {
          created_at: string;
          deleted_at: string | null;
          display_name: string | null;
          id: string;
          phone: string | null;
          phone_verified_at: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'users';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      show_limit: { Args: never; Returns: number };
      show_trgm: { Args: { '': string }; Returns: string[] };
      start_checkout_from_checkin: {
        Args: {
          p_account_id: string;
          p_baseline_inspection_id: string;
          p_notes?: string;
          p_performed_at?: string;
          p_template_id?: string;
        };
        Returns: {
          account_id: string;
          area_id: string;
          baseline_inspection_id: string | null;
          capture_mode: string;
          completed_at: string | null;
          created_at: string;
          deleted_at: string | null;
          form_opened_at: string | null;
          form_started_at: string | null;
          id: string;
          kind: string;
          link_delivered_at: string | null;
          notes: string | null;
          performed_at: string | null;
          performed_by: string | null;
          status: string;
          subject_snapshot: Json | null;
          submitted_at: string | null;
          supersedes_inspection_id: string | null;
          template_id: string | null;
          template_snapshot: Json | null;
          tenancy_id: string | null;
          updated_at: string;
          void_reason: string | null;
          voided_at: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'inspections';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      submit_intake: {
        Args: {
          p_account_id: string;
          p_actor: string;
          p_area_id: string;
          p_description: string;
          p_occurred_at: string;
          p_severity: string;
          p_tenancy_id: string;
          p_title: string;
        };
        Returns: {
          deduped: boolean;
          interaction_id: string;
          maintenance_request_id: string;
        }[];
      };
      submit_intake_with_attachment: {
        Args: {
          p_account_id: string;
          p_actor: string;
          p_area_id: string;
          p_attachment_hash: string;
          p_attachment_mime: string;
          p_attachment_path: string;
          p_attachment_size: number;
          p_derivative_hash?: string;
          p_derivative_mime?: string;
          p_derivative_path?: string;
          p_derivative_size?: number;
          p_description: string;
          p_occurred_at: string;
          p_severity: string;
          p_tenancy_id: string;
          p_title: string;
        };
        Returns: {
          attachment_id: string;
          deduped: boolean;
          derivative_id: string;
          interaction_id: string;
          maintenance_request_id: string;
        }[];
      };
      tenant_attach_inspection_item_photo: {
        Args: {
          p_account_id: string;
          p_attachment_hash: string;
          p_attachment_mime: string;
          p_attachment_path: string;
          p_attachment_size: number;
          p_derivative_hash?: string;
          p_derivative_mime?: string;
          p_derivative_path?: string;
          p_derivative_size?: number;
          p_inspection_id: string;
          p_item_id: string;
          p_token_id: string;
        };
        Returns: {
          attachment_id: string;
          derivative_id: string;
        }[];
      };
      tenant_confirm_inspection_room: {
        Args: {
          p_account_id: string;
          p_group_label: string;
          p_inspection_id: string;
          p_token_id: string;
        };
        Returns: undefined;
      };
      tenant_mark_form_opened: {
        Args: {
          p_account_id: string;
          p_inspection_id: string;
          p_token_id: string;
        };
        Returns: undefined;
      };
      tenant_search_text: {
        Args: { p_emails: string[]; p_full_name: string };
        Returns: string;
      };
      tenant_submit_inspection: {
        Args: {
          p_account_id: string;
          p_inspection_id: string;
          p_token_id: string;
        };
        Returns: {
          account_id: string;
          area_id: string;
          baseline_inspection_id: string | null;
          capture_mode: string;
          completed_at: string | null;
          created_at: string;
          deleted_at: string | null;
          form_opened_at: string | null;
          form_started_at: string | null;
          id: string;
          kind: string;
          link_delivered_at: string | null;
          notes: string | null;
          performed_at: string | null;
          performed_by: string | null;
          status: string;
          subject_snapshot: Json | null;
          submitted_at: string | null;
          supersedes_inspection_id: string | null;
          template_id: string | null;
          template_snapshot: Json | null;
          tenancy_id: string | null;
          updated_at: string;
          void_reason: string | null;
          voided_at: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'inspections';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      tenant_update_inspection_item: {
        Args: {
          p_account_id: string;
          p_condition: string;
          p_inspection_id: string;
          p_item_id: string;
          p_notes: string;
          p_token_id: string;
        };
        Returns: {
          account_id: string;
          change_type: string | null;
          condition: string | null;
          created_at: string;
          deleted_at: string | null;
          group_label: string | null;
          id: string;
          inspection_id: string;
          item_key: string | null;
          label: string;
          notes: string | null;
          sort_order: number | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'inspection_items';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      tenant_upsert_inspection_checks: {
        Args: {
          p_account_id: string;
          p_checks: Json;
          p_inspection_id: string;
          p_token_id: string;
        };
        Returns: {
          account_id: string;
          answered_at: string | null;
          answered_by: string | null;
          created_at: string;
          deleted_at: string | null;
          field_key: string;
          group_label: string | null;
          id: string;
          inspection_id: string;
          label: string;
          sort_order: number | null;
          updated_at: string;
          value: Json | null;
        }[];
        SetofOptions: {
          from: '*';
          to: 'inspection_checks';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      tenant_upsert_inspection_items: {
        Args: {
          p_account_id: string;
          p_inspection_id: string;
          p_items: Json;
          p_token_id: string;
        };
        Returns: {
          account_id: string;
          change_type: string | null;
          condition: string | null;
          created_at: string;
          deleted_at: string | null;
          group_label: string | null;
          id: string;
          inspection_id: string;
          item_key: string | null;
          label: string;
          notes: string | null;
          sort_order: number | null;
          updated_at: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'inspection_items';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      update_delivery: {
        Args: {
          p_error_code?: string;
          p_outbox_id: string;
          p_provider_ts: string;
          p_status: string;
        };
        Returns: {
          account_id: string;
          approval_ref: string;
          approved_by: string | null;
          author_type: string;
          body: string;
          channel: string;
          client_ref: string;
          created_at: string;
          delivered_at: string | null;
          error_code: string | null;
          error_message: string | null;
          group_addresses: string[] | null;
          id: string;
          interaction_id: string | null;
          maintenance_request_id: string | null;
          not_before: string | null;
          participant_id: string | null;
          provider: string | null;
          provider_sid: string | null;
          recipient_snapshot: Json | null;
          relay_of_interaction_id: string | null;
          rfc822_message_id: string | null;
          status: string;
          subject: string | null;
          template_id: string | null;
          tenancy_id: string | null;
          thread_id: string | null;
          to_address: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'comm_outbox';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      upsert_inspection_checks: {
        Args: { p_account_id: string; p_checks: Json; p_inspection_id: string };
        Returns: {
          account_id: string;
          answered_at: string | null;
          answered_by: string | null;
          created_at: string;
          deleted_at: string | null;
          field_key: string;
          group_label: string | null;
          id: string;
          inspection_id: string;
          label: string;
          sort_order: number | null;
          updated_at: string;
          value: Json | null;
        }[];
        SetofOptions: {
          from: '*';
          to: 'inspection_checks';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      upsert_inspection_items: {
        Args: { p_account_id: string; p_inspection_id: string; p_items: Json };
        Returns: {
          account_id: string;
          change_type: string | null;
          condition: string | null;
          created_at: string;
          deleted_at: string | null;
          group_label: string | null;
          id: string;
          inspection_id: string;
          item_key: string | null;
          label: string;
          notes: string | null;
          sort_order: number | null;
          updated_at: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'inspection_items';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      verify_chain: {
        Args: { p_account_id: string };
        Returns: {
          broken_at: string;
          broken_event_no: number;
          ok: boolean;
          reason: string;
        }[];
      };
      verify_chain_incremental: {
        Args: { p_account_id: string };
        Returns: {
          broken_at: string;
          broken_event_no: number;
          events_checked: number;
          ok: boolean;
          reason: string;
        }[];
      };
      verify_chain_sweep: {
        Args: { p_account_id: string };
        Returns: {
          alert_inserted: boolean;
          alerts_resolved: number;
          ok: boolean;
        }[];
      };
      void_inspection: {
        Args: {
          p_account_id: string;
          p_inspection_id: string;
          p_reason: string;
        };
        Returns: {
          account_id: string;
          area_id: string;
          baseline_inspection_id: string | null;
          capture_mode: string;
          completed_at: string | null;
          created_at: string;
          deleted_at: string | null;
          form_opened_at: string | null;
          form_started_at: string | null;
          id: string;
          kind: string;
          link_delivered_at: string | null;
          notes: string | null;
          performed_at: string | null;
          performed_by: string | null;
          status: string;
          subject_snapshot: Json | null;
          submitted_at: string | null;
          supersedes_inspection_id: string | null;
          template_id: string | null;
          template_snapshot: Json | null;
          tenancy_id: string | null;
          updated_at: string;
          void_reason: string | null;
          voided_at: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'inspections';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
