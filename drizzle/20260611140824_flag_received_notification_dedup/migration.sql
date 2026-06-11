CREATE UNIQUE INDEX "moderation_notification_flag_received_idx" ON "moderation_notification" ("account_id","case_id") WHERE 
        "type" = 'flag_received' AND "read" IS NULL
      ;