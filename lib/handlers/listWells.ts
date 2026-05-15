// Pure handler for GET /v1/wells. Composes three lookups (registry +
// lume list + per-well IP) into the sprite-shaped WellsListResponse.
//
// Deps surface is wider than the single-well handlers because the
// list view fans out per-row IP resolution. The real wiring (in
// daemon/welld.ts) uses listWells / LumeClient / resolveWellIp /
// publicBase; tests stub each.

import { wellsListResponse } from "../apiResponse.ts";
import type { WellSummary } from "../schemas.ts";
import type { WedgeLabel } from "../wedge.ts";

export interface ListWellsLumeRow {
  name: string;
  status?: string;
}

export interface ListWellsRegistryRow {
  name: string;
  created_at: string;
}

export interface ListWellsDeps {
  listWells(): Promise<ListWellsRegistryRow[]>;
  listLumeVms(): Promise<ListWellsLumeRow[]>;
  publicBase(): string | null;
  resolveWellIp(name: string): Promise<string | null>;
  getWedgeLabel(name: string): WedgeLabel;
  wellsListResponse?: typeof wellsListResponse;
}

export async function handleListWells(deps: ListWellsDeps): Promise<Response> {
  const wells = await deps.listWells();
  const lumeList = await deps.listLumeVms();
  const lumeByName = new Map(lumeList.map((v) => [v.name, v]));
  const base = deps.publicBase();

  const rows: WellSummary[] = await Promise.all(
    wells.map(async (s) => {
      const lv = lumeByName.get(s.name);
      const status =
        typeof lv?.status === "string"
          ? (lv.status as "running" | "stopped")
          : "missing";
      const ip = await deps.resolveWellIp(s.name);
      return {
        name: s.name,
        status,
        url: base ? `https://${s.name}.${base}` : null,
        ip,
        created_at: s.created_at,
        last_running_at: null,
        wedge: deps.getWedgeLabel(s.name),
      };
    }),
  );

  const body = { wells: rows };
  const respond = deps.wellsListResponse ?? wellsListResponse;
  return respond(body, "/v1/wells");
}
