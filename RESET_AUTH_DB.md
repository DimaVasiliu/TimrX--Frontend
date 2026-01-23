# Reset Auth Tables (Anonymous Mode)

Use the SQL below to remove the auth tables and detach any foreign keys that
reference `users`, while keeping anonymous history/jobs working. This is safe
to run multiple times.

## SQL (defensive)

```sql
BEGIN;

-- 1) Drop any foreign keys that reference users(id)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT conname, conrelid::regclass AS table_name
        FROM pg_constraint
        WHERE contype = 'f'
          AND confrelid = 'users'::regclass
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.table_name, r.conname);
    END LOOP;
END $$;

-- 2) Drop auth tables
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS users;

-- 3) Ensure user_id columns stay as plain nullable UUIDs (no FK)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'active_jobs' AND column_name = 'user_id') THEN
        ALTER TABLE active_jobs ALTER COLUMN user_id DROP NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'history_items' AND column_name = 'user_id') THEN
        ALTER TABLE history_items ALTER COLUMN user_id DROP NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'models' AND column_name = 'user_id') THEN
        ALTER TABLE models ALTER COLUMN user_id DROP NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'images' AND column_name = 'user_id') THEN
        ALTER TABLE images ALTER COLUMN user_id DROP NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'user_id') THEN
        ALTER TABLE jobs ALTER COLUMN user_id DROP NOT NULL;
    END IF;
END $$;

COMMIT;
```

## Optional cleanup

If you want to remove the `user_id` column entirely from any table that no
longer needs it, run this after the main script (example for `jobs`):

```sql
ALTER TABLE jobs DROP COLUMN IF EXISTS user_id;
```

History already supports `user_id` = NULL, so anonymous items will continue to
work without the `users` table.
