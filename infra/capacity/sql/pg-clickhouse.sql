CREATE SCHEMA ch_extension;
CREATE EXTENSION pg_clickhouse WITH SCHEMA ch_extension VERSION '0.10';
DO $$ BEGIN
  IF ch_extension.pgch_version() <> '0.10.0' OR
     (SELECT extversion FROM pg_extension WHERE extname = 'pg_clickhouse') <> '0.10' THEN
    RAISE EXCEPTION 'pg_clickhouse pin mismatch';
  END IF;
END $$;
REVOKE ALL ON SCHEMA ch_extension FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ch_extension FROM PUBLIC;
REVOKE EXECUTE ON ALL PROCEDURES IN SCHEMA ch_extension FROM PUBLIC;
CREATE SCHEMA capacity_ch;
REVOKE ALL ON SCHEMA capacity_ch FROM PUBLIC;
CREATE SERVER capacity_ch_server FOREIGN DATA WRAPPER clickhouse_fdw
OPTIONS (driver 'http', host 'clickhouse', port '8123', dbname 'capacity_analytics', secure 'off');
CREATE ROLE capacity_analytics_reader LOGIN CONNECTION LIMIT 1;
ALTER ROLE capacity_analytics_reader SET statement_timeout = '5s';
ALTER ROLE capacity_analytics_reader SET pg_clickhouse.session_settings = 'join_use_nulls 1, group_by_use_nulls 1, final 1, transform_null_in 0';
GRANT USAGE ON SCHEMA ch_extension, capacity_ch TO capacity_analytics_reader;
GRANT USAGE ON FOREIGN SERVER capacity_ch_server TO capacity_analytics_reader;
GRANT EXECUTE ON FUNCTION ch_extension.pgch_version() TO capacity_analytics_reader;
-- A superuser maps ONLY this scoped role using the ephemeral credential, then
-- SET ROLE capacity_analytics_reader; IMPORT FOREIGN SCHEMA capacity_analytics
-- LIMIT TO (ledger_sample) FROM SERVER capacity_ch_server INTO capacity_ch.
-- IMPORT ownership is returned to the installer; the reader receives SELECT only.
