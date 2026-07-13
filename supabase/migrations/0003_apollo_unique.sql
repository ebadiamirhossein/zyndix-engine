-- Partial unique indexes for Apollo dedupe (step 5.1)
-- Apply in Supabase SQL editor.

create unique index if not exists leads_apollo_person_uidx
  on leads (apollo_person_id) where apollo_person_id is not null;

create unique index if not exists companies_apollo_org_uidx
  on companies (apollo_org_id) where apollo_org_id is not null;
