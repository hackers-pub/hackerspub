CREATE FUNCTION "reject_deleted_account_username"() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "deleted_account"
    WHERE "username" = NEW."username"
  ) THEN
    RAISE EXCEPTION 'account username is reserved by a deleted account'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'account_username_not_deleted_account_username';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "account_username_not_deleted_account_username"
  AFTER INSERT OR UPDATE OF "username" ON "account"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW
  EXECUTE FUNCTION "reject_deleted_account_username"();
