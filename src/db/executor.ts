/** Minimal SQL surface the raw-SQL stores depend on. */
export interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
