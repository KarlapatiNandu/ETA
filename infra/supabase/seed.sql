-- Local development seed. SYNTHETIC PEOPLE ONLY — never real roster data (Read_this_first §7).
-- Phone numbers are in the +91 99999 00xxx block; with SMS_PROVIDER=console the OTP is
-- printed in the gateway log, so any of these can be claimed locally.

INSERT INTO roster_students (roll_no, full_name, admission_year, cohort, phone_e164, branch) VALUES
  ('160125737001', 'Asha Dev',     2025, derive_cohort(2025::smallint, operating_date()), '+919999900001', 'IT'),
  ('160124737002', 'Ravi Dev',     2024, derive_cohort(2024::smallint, operating_date()), '+919999900002', 'IT'),
  ('160125737003', 'No Phone Dev', 2025, derive_cohort(2025::smallint, operating_date()), NULL,            'IT'),
  ('TDADMIN01',    'TD Admin Dev', 2020, 'senior',                                        '+919999900099', NULL)
ON CONFLICT (roll_no) DO NOTHING;

-- To make TDADMIN01 an admin after claiming it at /claim, run in Studio (localhost:54323):
--   UPDATE profiles SET role = 'td_admin' WHERE roll_no = 'TDADMIN01';
-- then sign out and in again (the JWT's user_role claim refreshes on the next token).
