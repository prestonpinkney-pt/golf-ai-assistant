import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

function newId(prefix: string, n: number) {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/**
 * Minimal in-memory Supabase stand-in for Sent.dm inbound-loop integration tests.
 */
export function createInboundLoopMockSupabase() {
  const tables: Record<string, Row[]> = {
    audit_logs: [],
    inbound_events: [],
    contacts: [],
    leads: [],
    qualification_profiles: [],
    conversations: [],
    messages: [],
    webhook_jobs: [],
    business_messaging_numbers: [],
    businesses: [],
    business_messaging_configs: [],
  };

  let seq = 0;

  function nextId(table: string) {
    seq += 1;
    return newId(table, seq);
  }

  function match(row: Row, field: string, value: unknown) {
    if (field.includes(".")) return true;
    return row[field] === value;
  }

  function filterRows(table: string, filters: Array<{ field: string; op: string; value: unknown }>) {
    const rows = tables[table] ?? [];
    return rows.filter((row) =>
      filters.every((f) => {
        if (f.op === "eq") return match(row, f.field, f.value);
        if (f.op === "in") {
          const arr = Array.isArray(f.value) ? f.value : [];
          return arr.includes(row[f.field]);
        }
        if (f.op === "gte") {
          const rowVal = row[f.field];
          if (typeof rowVal !== "string" || typeof f.value !== "string") return true;
          return rowVal >= f.value;
        }
        return true;
      })
    );
  }

  type Builder = {
    table: string;
    filters: Array<{ field: string; op: string; value: unknown }>;
    orderField: string | null;
    orderAsc: boolean;
    limitN: number | null;
    pendingInsert: Row | null;
    pendingUpdate: Row | null;
  };

  function builder(init: Partial<Builder> & { table: string }): Builder {
    return {
      filters: [],
      orderField: null,
      orderAsc: true,
      limitN: null,
      pendingInsert: null,
      pendingUpdate: null,
      ...init,
    };
  }

  function chain(b: Builder) {
    const api = {
      select(_cols?: string) {
        return api;
      },
      insert(row: Row | Row[]) {
        const rows = Array.isArray(row) ? row : [row];
        b.pendingInsert = rows[0] ?? null;
        return api;
      },
      update(patch: Row) {
        b.pendingUpdate = patch;
        return api;
      },
      eq(field: string, value: unknown) {
        b.filters.push({ field, op: "eq", value });
        return api;
      },
      in(field: string, value: unknown) {
        b.filters.push({ field, op: "in", value });
        return api;
      },
      gte(field: string, value: unknown) {
        b.filters.push({ field, op: "gte", value });
        return api;
      },
      order(field: string, opts?: { ascending?: boolean }) {
        b.orderField = field;
        b.orderAsc = opts?.ascending !== false;
        return api;
      },
      limit(n: number) {
        b.limitN = n;
        return api;
      },
      async executePending() {
        if (b.pendingInsert) {
          const row = {
            id: nextId(b.table),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...b.pendingInsert,
          };
          tables[b.table].push(row);
          b.pendingInsert = null;
          b.filters = [];
          return { data: row, error: null };
        }
        if (b.pendingUpdate) {
          const rows = filterRows(b.table, b.filters);
          for (const row of rows) {
            Object.assign(row, b.pendingUpdate, {
              updated_at: new Date().toISOString(),
            });
          }
          const first = rows[0] ?? null;
          b.pendingUpdate = null;
          b.filters = [];
          return { data: first, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        if (b.pendingInsert || b.pendingUpdate) {
          return api.executePending();
        }
        let rows = filterRows(b.table, b.filters);
        if (b.orderField) {
          rows = [...rows].sort((a, c) => {
            const av = String(a[b.orderField!] ?? "");
            const cv = String(c[b.orderField!] ?? "");
            return b.orderAsc ? av.localeCompare(cv) : cv.localeCompare(av);
          });
        }
        if (b.limitN != null) rows = rows.slice(0, b.limitN);
        b.filters = [];
        if (rows.length !== 1) {
          return {
            data: null,
            error: rows.length === 0 ? null : { message: "multiple_rows" },
          };
        }
        return { data: rows[0], error: null };
      },
      maybeSingle: async () => {
        if (b.pendingInsert || b.pendingUpdate) {
          return api.executePending();
        }
        let rows = filterRows(b.table, b.filters);
        if (b.orderField) {
          rows = [...rows].sort((a, c) => {
            const av = String(a[b.orderField!] ?? "");
            const cv = String(c[b.orderField!] ?? "");
            return b.orderAsc ? av.localeCompare(cv) : cv.localeCompare(av);
          });
        }
        if (b.limitN != null) rows = rows.slice(0, b.limitN);
        b.filters = [];
        return { data: rows[0] ?? null, error: null };
      },
      then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return api.executePending().then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  const client = {
    from(table: string) {
      return chain(builder({ table }));
    },
    /** Test helpers */
    __tables: tables,
    __countMessages(filter?: (r: Row) => boolean) {
      return filter ? tables.messages.filter(filter).length : tables.messages.length;
    },
  };

  return client as unknown as SupabaseClient & {
    __tables: typeof tables;
    __countMessages: (filter?: (r: Row) => boolean) => number;
  };
}
