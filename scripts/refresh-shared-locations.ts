/**
 * Work out which facilities share exactly the same point and store it (geo_validation.shared_count / shared_with).
 * Runs automatically at the end of every full or weekly run; use this after changing points by hand.
 *
 *   npx tsx scripts/refresh-shared-locations.ts
 */
import "./_env";
import { closeDb } from "../src/lib/db/client";
import { refreshSharedLocations } from "../src/lib/geo/shared";

refreshSharedLocations()
  .then((r) => console.log(`${r.facilities} facilities share a point in ${r.groups} groups (largest ${r.largest}); ${r.changed} rows updated.`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
