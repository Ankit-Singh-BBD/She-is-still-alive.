# Madhurita Legacy Migration Guide (Phase P28)

Per Build Book Part XXV.2 and Phase P28 (M18).

## Why This Exists

The new Madhurita runtime boots and works correctly from an **empty database**.
Legacy DB import is **not** a prerequisite of the rebuild and is **never**
opened by the runtime during normal operation.

This guide describes the **optional, explicit, validated** import of the
archived legacy SQLite DB into the new schema. It is a separate phase
(P28 / M18) executed only when the owner decides the legacy archive
should be carried forward.

## Principles (Part XXV.2)

1. The legacy DB is **preserved as the archive**. The new runtime **never**
   reads, writes, or locks the archive.
2. The importer opens the archive **read-only** (or shares a handle that
   the test rig controls). The archive is **never mutated**.
3. Every imported memory must have:
   - **Provenance** (cycle, conversation, extractor, confidence, validatedBy).
   - **Sensitivity** that maps correctly to the new Knowledge Retrieval Policy.
   - **Scope** that matches the legacy owner (`owner_only` for the legacy
     owner; never elevate guest/person rows to `owner_only`).
4. A non-dry-run import **requires explicit owner confirmation** (`ownerConfirmed: true`).
5. The import runs as a **single atomic transaction**. Any failure
   rolls back completely — the destination DB is unchanged.
6. Dry-run mode **scans and reports counts only**. The destination DB is
   untouched.

## Mapping

### Identities (`old_users` → `identity` + `permission`)

| Legacy `role` | New `identity.kind` | `permission.json` |
| ------------- | ------------------- | ----------------- |
| `admin`       | `owner`             | `DEFAULT_PERMISSIONS.owner` |
| `guest`       | `guest`             | `DEFAULT_PERMISSIONS.guest` |
| *else*        | `person`            | `DEFAULT_PERMISSIONS.person` |

A new ULID is minted for each legacy identity. The mapping is kept in
memory for the duration of the transaction only.

### Memories (`old_memories` → multi-domain)

The legacy schema stored `(category, text)`. The new schema is multi-domain.

| Legacy `category` | Destination table  | Notes |
| ----------------- | ------------------ | ----- |
| `preference`      | `preference`       | `key = legacy id`, `value = text` |
| *else*            | `semantic_memory`  | `subject = legacy id`, `predicate = category`, `object = text` |

Sensitivity:

| Source `kind` | New `sensitivity` |
| ------------- | ----------------- |
| `owner`       | `owner_only`      |
| `person`      | `person_shared`   |
| `guest`       | `person_shared`   |

Provenance stamped on every imported row:

```json
{
  "sourceCycleId": "legacy-cycle",
  "sourceConversationId": "legacy-conv",
  "sourceMessageIds": [],
  "extractedAt": <now>,
  "extractor": "legacy_import",
  "confidence": 1,
  "validatedBy": "owner_confirmation"
}
```

The `extractor: "legacy_import"` discriminator is honored by
`MemoryRetrieval` and the audit log. Imported rows pass through the same
Knowledge Retrieval Policy as runtime-produced rows.

## Usage

```ts
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { ImportLegacyScript } from '../../scripts/migrate/import_legacy.js';

const dest = new Database({ path: 'madhurita.sqlite' });
runMigrations(dest, 'server/persistence/migrations');

const importer = new ImportLegacyScript(dest, '/path/to/legacy-archive.sqlite');

// 1. Dry-run: scan counts, mutate nothing.
const preview = await importer.run({ dryRun: true });

// 2. Confirmed import: only when the owner has approved.
const stats = await importer.run({ dryRun: false, ownerConfirmed: true });
```

If `ownerConfirmed` is `false` (or absent) and `dryRun` is `false`,
the importer throws `Owner confirmation required before importing legacy data`.

## Rollback / Failure

The import is wrapped in `db.transaction(...)`. If any row fails
(e.g. a constraint, a trigger, a uniqueness violation), the entire
import is rolled back. The destination DB is unchanged.

The legacy archive is **never** modified. Even a partial failed run
leaves the archive byte-for-byte identical.

## What This Guide Does Not Do

- It does not delete the legacy archive. The owner purges it explicitly.
- It does not import from sources other than the legacy SQLite archive.
- It does not modify the destination DB schema. The new schema is the
  contract; the importer adapts the legacy data to fit it.
