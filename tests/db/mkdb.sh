#!/bin/sh
# usage: mkdb.sh <dbname> [extra sql files...]
P="psql -h /tmp -p 54322 -U postgres -v ON_ERROR_STOP=1 -q"
name=$1; shift
$P -c "drop database if exists $name" -c "create database $name" >/dev/null 2>&1
$P -d $name -f tests/db/supabase_stub.sql >/dev/null 2>&1
$P -d $name -f database/supabase_setup.sql >/dev/null 2>&1 || { echo "setup failed"; exit 1; }
for f in "$@"; do $P -d $name -f "$f" >/dev/null 2>&1 || { echo "failed: $f"; $P -d $name -f "$f" 2>&1 | grep ERROR; exit 1; }; done
echo "built $name"
