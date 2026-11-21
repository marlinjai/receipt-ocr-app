#!/usr/bin/env bash
# The one check command of this repository: `pnpm verify`.
#
# Runs every step of .github/workflows/verify.yml in the same order and prints one
# line per stage, PASS or FAIL with its time. The output of a stage is kept in a
# log file; the last lines of a failed stage are printed. Exit code 0 only when
# every stage passed.
#
# The database tests need two throwaway Postgres databases. When
# TEST_DATABASE_URL and CONTACTS_TEST_DATABASE_URL are set, those are used.
# Otherwise two Docker containers are started on free local ports and removed at
# the end. Either way a stage of its own checks every database URL before the
# migrations are applied: local host, a name ending in _test (test/db-guard.ts).
#
# VERIFY_SKIP_INSTALL=1 skips the dependency install (a checkout that has them).
set -u
cd "$(dirname "$0")/.."

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/receipts-verify.XXXXXX")"
FAILED=0
STARTED_CONTAINERS=()

cleanup() {
  if [ "${#STARTED_CONTAINERS[@]}" -gt 0 ]; then
    docker rm -f "${STARTED_CONTAINERS[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# stage <name> <command...>: run it, print one line, keep the log.
stage() {
  local name="$1"
  shift
  local log="$LOGS/${name// /-}.log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    printf 'PASS  %-34s %4ss\n' "$name" "$((SECONDS - start))"
    return 0
  fi
  printf 'FAIL  %-34s %4ss  (log: %s)\n' "$name" "$((SECONDS - start))" "$log"
  tail -n 40 "$log" | sed 's/^/      | /'
  FAILED=1
  return 1
}

skip() {
  printf 'FAIL  %-34s    -   (not run: %s)\n' "$1" "$2"
  FAILED=1
}

# The contact tables are opened only through @marlinjai/contacts-core, which keeps
# every query scoped to one company. Raw SQL that names them would bypass that.
contact_tables_guard() {
  # Plain grep, not git grep: the command also runs on a copy of the worktree without its .git folder.
  if grep -rnIE --exclude=verify.sh '(FROM|INTO|UPDATE|JOIN|TABLE)[[:space:]]+"?(contacts|contact_affiliations|tenant_counters)"?([^[:alnum:]_]|$)' src scripts test; then
    echo "Raw SQL on the shared contact tables found. Go through @marlinjai/contacts-core instead."
    return 1
  fi
}

# start_postgres <image> <user> <database>: prints the URL of a fresh container.
# Always a new container with an empty database, never a kept one: the migrations are then applied
# from the first as they are in the checkout, also one that was edited before it was ever merged.
start_postgres() {
  local image="$1" user="$2" database="$3" id port
  id="$(docker run -d -e POSTGRES_USER="$user" -e POSTGRES_PASSWORD="$user" -e POSTGRES_DB="$database" -p 127.0.0.1::5432 "$image")" || return 1
  echo "$id" >>"$LOGS/containers"
  for _ in $(seq 1 60); do
    if docker exec "$id" pg_isready -U "$user" -d "$database" >/dev/null 2>&1; then
      port="$(docker port "$id" 5432/tcp | head -n 1 | sed 's/.*://')"
      # Throwaway credentials of a container that exists only for this run.
      echo "postgresql://$user:$user@127.0.0.1:$port/$database"
      return 0
    fi
    sleep 1
  done
  return 1
}

databases() {
  if [ -n "${TEST_DATABASE_URL:-}" ] && [ -n "${CONTACTS_TEST_DATABASE_URL:-}" ]; then
    echo "using the test databases of the environment"
    return 0
  fi
  command -v docker >/dev/null 2>&1 || { echo "docker not found and no TEST_DATABASE_URL / CONTACTS_TEST_DATABASE_URL set"; return 1; }
  start_postgres postgres:16-alpine receipts receipts_test >"$LOGS/receipts-url" || { echo "the receipts test database did not start"; return 1; }
  start_postgres postgres:17-alpine contacts contacts_test >"$LOGS/contacts-url" || { echo "the contacts test database did not start"; return 1; }
  echo "started two throwaway containers"
}

if [ "${VERIFY_SKIP_INSTALL:-}" != "1" ]; then
  stage "install" pnpm install --frozen-lockfile
fi
stage "contact tables guard" contact_tables_guard
stage "prisma generate" pnpm prisma generate
stage "typecheck" pnpm typecheck
stage "lint" pnpm lint
stage "unit tests" pnpm test

if stage "test databases" databases; then
  if [ -f "$LOGS/containers" ]; then
    while read -r id; do STARTED_CONTAINERS+=("$id"); done <"$LOGS/containers"
    TEST_DATABASE_URL="$(cat "$LOGS/receipts-url")"
    CONTACTS_TEST_DATABASE_URL="$(cat "$LOGS/contacts-url")"
  fi
  export TEST_DATABASE_URL CONTACTS_TEST_DATABASE_URL
  export DATABASE_URL="$TEST_DATABASE_URL"
  # Before anything writes: refuse every URL that is not a local throwaway database. The guard inside
  # the database tests would come too late, the migrations run first.
  if ! stage "test databases are throwaway" pnpm check:databases; then
    skip "migrations apply" "a database URL is not a local throwaway database"
    skip "migrations produce the schema" "a database URL is not a local throwaway database"
    skip "database tests" "a database URL is not a local throwaway database"
  elif stage "migrations apply" pnpm prisma migrate deploy; then
    # The migrations are written by hand: this fails when what they produce differs from the schema.
    stage "migrations produce the schema" pnpm prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
    stage "database tests" pnpm test:db
  else
    skip "migrations produce the schema" "the migrations did not apply"
    skip "database tests" "the migrations did not apply"
  fi
else
  if [ -f "$LOGS/containers" ]; then
    while read -r id; do STARTED_CONTAINERS+=("$id"); done <"$LOGS/containers"
  fi
  skip "test databases are throwaway" "no test databases"
  skip "migrations apply" "no test databases"
  skip "migrations produce the schema" "no test databases"
  skip "database tests" "no test databases"
fi

stage "roadmap check" pnpm check:roadmap

if [ "$FAILED" -eq 0 ]; then
  echo "verify: all stages passed"
else
  echo "verify: FAILED (logs in $LOGS)"
fi
exit "$FAILED"
