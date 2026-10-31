#!/bin/sh
# Records what a copy holds, then passes. OBSERVE_FILE names the file; the copy arrives as $DATABASE_URL.
set -e
{
  echo "-- copy $(psql -X -At "$DATABASE_URL" -c 'select current_database()')"
  psql -X -At "$DATABASE_URL" -c "select 'user|' || email from auth.users order by 1"
  psql -X -At "$DATABASE_URL" -c "select 'doc|' || title || '|' || coalesce(body,'-') from public.documents order by 1"
} >> "$OBSERVE_FILE"
exit 0
