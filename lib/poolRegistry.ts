// Pool registry — JSON file at ~/.wells/pool/registry.json.
//
// The pool is a separate namespace of pre-hatched, pre-warmed wells held
// in reserve for fast adoption by `well create`. Members are named
// `pool-XXXXXXXX` (8 hex from a fresh UUID) so they never collide with
// operator-chosen well names.
//
// Lifecycle of a pool member:
//   1. `fillPool()` (A.1.4.b) creates a member: clones the base image,
//      boots, runs well-firstboot with the pool's generic identity, sets
//      /etc/.well-ready, hibernates. Adds entry here with state="ready".
//   2. `adoptFromPool()` (A.1.4.c) pops a ready member, renames it to
//      the operator's chosen name, resets identity (rm /etc/.well-ready,
//      swap cidata), wakes from hibernate.bin, removes from pool.
//   3. Pool refills async after each adoption.
//
// Why a separate registry file: pool members aren't user-visible wells.
// `well list` enumerates the main registry only (~/.wells/registry.json);
// the pool namespace lives at ~/.wells/pool/registry.json so cell admins
// don't see pool-XXXX entries cluttering their `well list` output.
//
// Pool members ARE visible to lume (they're VM bundles like any other),
// but lume names use the same pool-XXXX prefix so `lume ls` shows them
// as obviously-not-user-wells.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "./state.ts";

// State machine for a pool member. Mirrors the WellRuntime states used
// for regular wells but trimmed to the lifecycle the pool actually needs.
//   - provisioning: bundle being created, not yet booted
//   - warming:      booted, well-firstboot still running
//   - ready:        hibernated with /etc/.well-ready set, available to adopt
//   - adopting:     popped from pool, mid-rename — visible in registry
//                   only briefly so a concurrent fill task can't reuse
export type PoolMemberState =
  | "provisioning"
  | "warming"
  | "ready"
  | "adopting";

export interface PoolMember {
  name: string;
  uuid: string;
  created_at: string;
  // The image this member was hatched from. Pool refill clones the same
  // image to keep the pool's egg shape consistent.
  source_image: string;
  // Sizing — pool members must match the wells's expected default sizing
  // so adoption is a transparent swap. Captured at fill-time from
  // defaults.json so a later defaults change doesn't silently invalidate
  // the pool.
  cpu: number;
  memory: string;
  disk_size: string;
  state: PoolMemberState;
  // Set by fillPool when /etc/.well-ready lands and hibernation completes.
  // Adopt path uses presence-of-this to gate "is this member actually
  // ready" without trusting the state field alone (state could lie if
  // welld crashed mid-write).
  ready_at?: string;
}

interface PoolRegistry {
  members: PoolMember[];
}

// Generate a fresh pool member name. UUID-prefixed so no collision with
// operator-chosen well names (which can't start with `pool-` per the
// well-name validator) and no collision between concurrent fill tasks.
export function generatePoolMemberName(): string {
  return `pool-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export async function loadPoolRegistry(): Promise<PoolRegistry> {
  const path = PATHS.poolRegistry();
  if (!existsSync(path)) return { members: [] };
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}

export async function savePoolRegistry(reg: PoolRegistry): Promise<void> {
  const path = PATHS.poolRegistry();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function listPoolMembers(): Promise<PoolMember[]> {
  return (await loadPoolRegistry()).members;
}

export async function findPoolMember(
  name: string,
): Promise<PoolMember | undefined> {
  return (await loadPoolRegistry()).members.find((m) => m.name === name);
}

// Count members in `ready` state. Used by the fill loop to decide
// whether the pool needs more members (target_size - ready count).
export async function countReadyMembers(): Promise<number> {
  return (await loadPoolRegistry()).members.filter((m) => m.state === "ready")
    .length;
}

// Filter for reserveReadyMember. Any field omitted is treated as
// "don't care". Used by createWell's pool-adoption gate to refuse a
// pool member whose sizing or source image doesn't match the caller's
// request — pool only handles the default profile, anything custom
// falls through to fresh-create.
export interface PoolMemberCriteria {
  source_image?: string;
  cpu?: number;
  memory?: string;
  disk_size?: string;
}

function memberMatches(m: PoolMember, c?: PoolMemberCriteria): boolean {
  if (!c) return true;
  if (c.source_image !== undefined && m.source_image !== c.source_image) return false;
  if (c.cpu !== undefined && m.cpu !== c.cpu) return false;
  if (c.memory !== undefined && m.memory !== c.memory) return false;
  if (c.disk_size !== undefined && m.disk_size !== c.disk_size) return false;
  return true;
}

// Pop a ready member for adoption. Atomically transitions the member
// to `adopting` so a concurrent adopt request can't double-pop. Returns
// the member or undefined if the pool is empty/no-ready-members.
//
// Optional `criteria` filters the pool by sizing + source image. A
// member that's `ready` but whose shape doesn't match returns
// undefined — caller falls through to fresh-create.
//
// Why transition to `adopting` rather than removing immediately: keeps
// the bundle dir guarded against the fill loop that might otherwise
// see an "empty pool slot" and hatch a duplicate. Caller calls
// removePoolMember once the rename is committed.
export async function reserveReadyMember(
  criteria?: PoolMemberCriteria,
): Promise<PoolMember | undefined> {
  const reg = await loadPoolRegistry();
  const ready = reg.members.find(
    (m) => m.state === "ready" && memberMatches(m, criteria),
  );
  if (!ready) return undefined;
  ready.state = "adopting";
  await savePoolRegistry(reg);
  return ready;
}

export async function addPoolMember(member: PoolMember): Promise<void> {
  const reg = await loadPoolRegistry();
  if (reg.members.some((m) => m.name === member.name)) {
    throw new Error(`pool member '${member.name}' already exists`);
  }
  reg.members.push(member);
  await savePoolRegistry(reg);
}

// Update a member's state in place. Used by fillPool to walk a member
// through provisioning → warming → ready, and by recovery code that
// finds wedged members.
export async function setPoolMemberState(
  name: string,
  state: PoolMemberState,
  readyAt?: string,
): Promise<PoolMember | undefined> {
  const reg = await loadPoolRegistry();
  const m = reg.members.find((x) => x.name === name);
  if (!m) return undefined;
  m.state = state;
  if (readyAt) m.ready_at = readyAt;
  await savePoolRegistry(reg);
  return m;
}

export async function removePoolMember(name: string): Promise<boolean> {
  const reg = await loadPoolRegistry();
  const before = reg.members.length;
  reg.members = reg.members.filter((m) => m.name !== name);
  if (reg.members.length === before) return false;
  await savePoolRegistry(reg);
  return true;
}
