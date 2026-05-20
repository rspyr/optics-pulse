-- Add a `manual` value to the match_level enum to represent attribution
-- events that an operator resolved by hand (field-mapping rule, per-lead
-- funnel override, etc). Distinct from the auto-match tiers (diamond /
-- golden / silver / bronze) and from `unmatched`. See task #574.
ALTER TYPE "match_level" ADD VALUE IF NOT EXISTS 'manual' BEFORE 'unmatched';
