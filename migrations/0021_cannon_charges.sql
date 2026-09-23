-- 0021_cannon_charges.sql
-- Powder charges belong to the GUN, not to the operator's page.
--
-- THE PROBLEM. The calculator used to carry one "Powder Charges" slider for the
-- whole page, and an officer set it before each calculation. Two things were
-- wrong with that: the count is a property of the gun as it is loaded (a 4-block
-- gun is not fired with the same charge as a 12-block one), and a single slider
-- cannot describe a barrage in which several guns with different loads fire at
-- once. Worse, the count is a real, deliberate choice — how much powder is in
-- the tube — and it was being re-set from the website every time.
--
-- So the count is stored against the cannon and set in the Cannon Registry (and
-- per gun on the Vehicle Registry). Every solution — a single shot, a ship's
-- broadside, or an order's queued shots — is solved with that gun's own count.
--
-- 1. THE CANNON'S LOAD. Defaulted to 3, which is what the old slider started at,
--    so an existing registry keeps the aim it had until an officer changes it.
--
-- 2. THE SHOT'S LOAD. A barrage can fire guns with different counts, so the
--    number a shot was solved with is recorded ON THE SHOT. That is also what
--    lets the live map replay a flight truthfully — muzzle velocity comes
--    straight from the charge count, so a single order-level number would fly
--    some guns' shells at the wrong speed.
--
--    Nullable on purpose: shots queued before this migration have no count of
--    their own, and read as the order's own value.
--
-- Apply with:
--   npx wrangler d1 migrations apply regnum-aeternum-db --remote

ALTER TABLE ballistics_cannons   ADD COLUMN charges INTEGER NOT NULL DEFAULT 3;

ALTER TABLE ballistics_fire_queue ADD COLUMN charges INTEGER;
