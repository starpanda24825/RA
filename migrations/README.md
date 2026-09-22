# Migrations

D1 migrations for `regnum-aeternum-db`, applied through wrangler's migration
tracker rather than by hand:

```bash
npx wrangler d1 migrations apply regnum-aeternum-db --local
npx wrangler d1 migrations apply regnum-aeternum-db --remote
```

Check what is outstanding at any time:

```bash
npx wrangler d1 migrations list regnum-aeternum-db --remote
```

Each file runs **at most once**. Wrangler records the filenames it has run in a
`d1_migrations` table and skips whatever is already listed, so re-running the
command is always safe. This replaces the old
`wrangler d1 execute ... --file=./migrations/NNNN_x.sql`, which bypassed the
tracker and failed with `duplicate column name` if you ever ran it twice.

The tracker was seeded with `0001`–`0016` on 2026-09-22, because those had
already been applied by hand before the tracker existed. Seeding it did not run
any of them again.

## Rules

- **Never edit a migration that has already been applied.** The tracker skips
  it, so the change silently never runs. Add a new numbered file instead —
  including for corrections to an earlier one.
- **`ALTER TABLE ... ADD COLUMN` is one-shot.** SQLite has no
  `ADD COLUMN IF NOT EXISTS`, so a file containing one cannot be re-run; it
  aborts with `duplicate column name: <col>` and rolls back. The tracker is
  what stops that from happening.
- Keep new tables and indexes as `CREATE ... IF NOT EXISTS` regardless, so a
  file's only non-idempotent statement is ever an `ALTER`.

## Adding one

1. Create `migrations/00NN_short_description.sql` with the next free number.
2. Copy the header block from an existing file.
3. `npx wrangler d1 migrations apply regnum-aeternum-db --remote`

Do **not** run `wrangler d1 migrations apply` against a database whose tracker
has not been seeded — with an empty `d1_migrations` table it considers every
file unapplied and will try to re-run `0001` onwards.
