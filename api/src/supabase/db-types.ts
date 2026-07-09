import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './database.types';

export type { Database, Json };

export type AppSupabaseClient = SupabaseClient<Database>;

export type DbTableName = keyof Database['public']['Tables'];
export type DbTableRow<T extends DbTableName> = Database['public']['Tables'][T]['Row'];
export type DbTableInsert<T extends DbTableName> = Database['public']['Tables'][T]['Insert'];
export type DbTableUpdate<T extends DbTableName> = Database['public']['Tables'][T]['Update'];

export type DbFunctionName = keyof Database['public']['Functions'];
export type DbFunctionArgs<T extends DbFunctionName> = Database['public']['Functions'][T]['Args'];

export function asDbInsert<T extends DbTableName>(
  value: Record<string, unknown>,
): DbTableInsert<T> {
  return value as DbTableInsert<T>;
}

export function asDbUpdate<T extends DbTableName>(
  value: Record<string, unknown>,
): DbTableUpdate<T> {
  return value as DbTableUpdate<T>;
}

export function asDbFunctionArgs<T extends DbFunctionName>(
  value: Record<string, unknown>,
): DbFunctionArgs<T> {
  return value as DbFunctionArgs<T>;
}

// Use only after a request/schema parser, storage metadata parser, or DB row
// shape has already validated that the payload is JSON-serializable.
export function asJson(value: unknown): Json {
  return value as Json;
}

// Supabase's generated Function Args do not distinguish required-but-nullable
// SQL parameters. Use this at RPC call boundaries where null is a valid
// database value rather than "omit this optional parameter".
export function nullableRpcArg<T>(value: T | null): T {
  return value as T;
}
