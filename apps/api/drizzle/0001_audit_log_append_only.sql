-- FR-038: audit history is immutable. Block UPDATE and DELETE at the database
-- level so even a bug or a stray SQL session can't rewrite it. Retention purges
-- (FR-039) will run as a separate, approved, privileged job that disables this
-- trigger inside its own transaction.
CREATE OR REPLACE FUNCTION audit_logs_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_changes();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_changes();
