/**
 * Identify the climate-sensitive services of every facility from the services already stored (no portal calls),
 * and refresh the English / Kiswahili catalogue in the database.
 *
 *   npx tsx scripts/classify-climate.ts
 */
import "./_env";
import { closeDb } from "../src/lib/db/client";
import { refreshClimateServices } from "../src/lib/climate/refresh";

refreshClimateServices()
  .then((r) =>
    console.log(
      `${r.services} services in the catalogue; ${r.matchedPairs} of ${r.totalPairs} registry service names matched; ` +
        `${r.facilities} facilities offer at least one (${r.links} facility-service links).`,
    ),
  )
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
