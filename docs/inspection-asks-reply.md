# Reply: inspection asks §17, §20(a–c), and BACKEND_ASKS #21–#23

**From:** backend (CTO review)
**Re:** Field-Log asks — checks delete, typed checks, catalog dedupe, upsert
stamping, per-unit form memory, catalog provenance, key stability
**Ships as:** PR #86 → #87 → #88 → #89 (stacked, merge in order)

Every ask was accepted in substance. Below: what shipped, where we corrected
the ask, and the three things you should change on your side.

---

## §17 — Removing a check: DELETE endpoint shipped, replace-set rejected (#86)

`DELETE /v1/accounts/{a}/inspections/{id}/checks/{checkId}` → 204. Soft
delete, symmetric with items. The freed `field_key` can be re-minted later.

We deliberately did **not** give `POST …/checks` replace-set semantics: that
endpoint is your offline batch re-sync path, and replace-set would turn every
partial sync into silent deletion of the checks the device didn't have. An
explicit DELETE also leaves a per-row audit event.

Three behaviors to know about:

1. **Completed inspections reject the delete with 409.** Your prod duplicates
   (`gate_keys_2`, report `2dc483570d42`) are cleanable only where the
   inspection is still draft/submitted. Completed ones already rendered those
   rows into an emitted report; the correction path remains void + recreate.
   This is the audit invariant, not a gap.
2. **Re-seeding an inspection resurrects template-seeded checks you deleted**
   (same as items today). Deleting a check is a per-inspection fact; making a
   trim survive future inspections is exactly what the layout store (#89) is
   for.
3. **Evidence-export bundles keep deleted rows**, now annotated `(removed)`.
   Bundles are deliberately complete (same policy as soft-deleted tenancies);
   the immutable report PDF renders live rows only.

## §20(c) — Stamping and erase-on-omit: fixed in BOTH writers (#86)

Confirmed, and it was worse than reported: the tenant capture RPC had the
same two defects, and the full-replace `DO UPDATE` also meant a value-only
sync wiped `group_label`/`sort_order` and reset `label` to the raw key.

Both RPCs now **presence-merge**: a key present in your payload element is
set; an absent key preserves the stored value. Semantics for `value`:

| payload            | stored value | answered_by / answered_at            |
|--------------------|--------------|--------------------------------------|
| key absent         | preserved    | preserved                            |
| `"value": 3`       | `3`          | stamped (member path sets both; tenant path sets `answered_at` only) |
| `"value": null`    | SQL NULL     | **cleared** (explicit un-answer)     |

Your defensive round-tripping of `group_label`/`value`/`sort_order` is now
unnecessary — you can send only what changed. (Keep payload elements unique
by `field_key`; a duplicate in one batch still errors, as before.)

Existing mis-stamped rows: healed (answered_* nulled where value is empty) on
**draft** inspections only. Completed inspections are immutable and their
reports already rendered; we do not rewrite emitted evidence.

## §20(a) — `input_kind` end-to-end (#87)

`inspection_checks.input_kind` (`'boolean' | 'count' | 'text'`, nullable;
null = legacy rows → keep rendering Yes/No). Surfaces:

- `GET …/checks`, the tenant capture form payload, and both upsert bodies
  (optional, enum-validated).
- Seeded from the template schema (unrecognized values sanitize to null —
  template schemas are client-editable, a stale kind must not brick seeding).
- **Also carried through `start-checkout`'s skeleton copy** — this was
  missing from the ask; without it every move-out form would have regressed
  to Yes/No at exactly the deposit-relevant moment.

`input_kind` is a rendering hint, not a validation contract: the backend
never rejects a `value` for not matching the kind, so offline syncs can't
brick on a stale hint. Render steppers for `count`, toggles for `boolean`.

## §20(b) — Garage remote dedupe (#87)

Dropped `garage/door_remotes`; **`keys/garage_remotes` is canonical**
(handover counts live in Keys & access, where every other count is). Catalog
version bumped `'1' → '2'` so clones record which form they got. Existing
clones are copies-at-clone-time and are untouched.

## #21 — Per-unit layout delta store (#89)

Shipped as specified — inert JSON, delta-not-fork, backend does zero
key-vs-schema validation. Endpoint shapes exactly as asked:

```
GET    /v1/accounts/{a}/areas/{areaId}/inspection-layouts/{templateId}   404 = no memory
PUT    …    idempotent whole-document upsert
DELETE …    reset to the standard form (404 afterward, as specified)
```

Deviations you should know about:

- **The PUT body is strictly shaped** (`base_template_version?`, `layout` with
  the five delta arrays; bounded: removed_* ≤ 500 keys, added_* ≤ 200 entries,
  strings ≤ 200 chars; unknown fields are 400, not silently stored). Run
  `bun run api:types` after the spec update — the generated types are exact.
  Do not send `area_id`/`template_id` in the body; they live in the path.
- **`added_checks` entries accept optional `input_kind`** so a custom count
  check renders as a stepper on every future inspection (coherent with §20a).
- **Your Idempotency-Key plan works with zero changes** — but note it is
  *mandatory* on every account-scoped mutation in this API, DELETE included
  (400 without it).
- Deleting the area or template cascade-deletes the row, as you preferred.

## #22 — `catalog_id` backlink (#88), plus a correction

Shipped: nullable `catalog_id` on templates, set only by `from-catalog`,
returned on GET/list, never client-writable (stripped from PATCH bodies).

**Correction to the ask: existing rows do NOT stay null.** Cloned schemas
have always embedded the catalog id at `schema.form_code`, so the migration
backfills `catalog_id` for every existing clone. You can delete the
name/jurisdiction/version heuristic outright instead of keeping it as a
fallback.

Bonus, aimed at your #21 `base_template_version` field: templates now also
return **`schema_hash`** — a DB-generated `md5` over the canonical jsonb
schema. It changes iff the schema changes (no false "template changed" flags
from metadata-only edits), which is exactly the content-hash you said was
"better". Prefer it over `updated_at`.

## #23 — Key stability: committed, with the boundary drawn honestly

The backend commitments, each now pinned by a CI regression test (#87):

1. **Template schemas are stored verbatim** — create and PATCH never rewrite,
   re-namespace, or regenerate keys. (One nuance: Postgres jsonb canonicalizes
   object *key order* and deduplicates repeated keys. Content — every key,
   label, value, and array order — round-trips exactly.)
2. **Seed derivation is fixed**: `item_key`/`field_key` = exactly
   `<section.key>/<field.key>`. Pinned so the #19 decay class can't recur.
3. **Catalog keys are add/remove-only, never renamed** — a key rename now
   fails our CI against a frozen key-set snapshot.

The boundary: the backend cannot enforce label/key independence inside a
PATCHed schema blob — a key rename is indistinguishable from remove+add, and
remove is legitimate. The main writer of template schemas is your own editor,
so "editing a label must not change its key" is an invariant your editor has
to uphold; our side guarantees we never mutate what you stored.

---

## Sequencing for your side

| Backend PR | What you can do when it deploys |
|------------|--------------------------------|
| #86 | Delete duplicate checks on non-completed inspections; drop the defensive field round-tripping |
| #87 | Regenerate types; render count steppers; remove parse-time dedupe for the garage remote pair on *new* clones |
| #88 | Regenerate types; switch provenance to `catalog_id`; delete the matching heuristic; use `schema_hash` as the drift marker |
| #89 | Flip `AREA_LAYOUT_SUPPORTED`; layout memory becomes durable + cross-device |

Four prod migrations ride these PRs (`20260719000001–4`), applied in order
before each deploy — schema leads code, as usual.
