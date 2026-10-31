#!/bin/sh
# Test command for the build-mode tests. It records what a copy holds, then passes.
# OBSERVE_FILE names the file. The copy arrives as $DATABASE_URL.
set -e
{
  echo "-- copy $(psql -X -At "$DATABASE_URL" -c 'select current_database()')"
  psql -X -At "$DATABASE_URL" -c "select 'people|' || id || '|' || email || '|' || full_name || '|' || coalesce(passport_no::text,'-') || '|' || coalesce(token::text,'-') || '|' || coalesce(note,'-') from people order by id"
  psql -X -At "$DATABASE_URL" -c "select 'orders|' || id || '|' || buyer_email || '|' || total from orders order by id"
} >> "$OBSERVE_FILE"
exit 0
