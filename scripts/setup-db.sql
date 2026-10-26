-- One-time setup, run as the postgres superuser:
--   sudo -u postgres psql -f scripts/setup-db.sql
-- Local development password only. Never reuse it for a client environment.
CREATE USER opspilot WITH PASSWORD 'opspilot_dev_pw' CREATEDB;
CREATE DATABASE opspilot OWNER opspilot;
CREATE DATABASE n8n OWNER opspilot;
