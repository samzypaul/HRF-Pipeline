import { climateServiceFor, type ClimateService } from "./catalogue";

/**
 * The climate-sensitive service an HFR service row (its category and its service name) stands for, if any.
 * Exact portal text, so every climate row traces back to a facility_services row. Pure, so it can be unit-tested against real portal text.
 */
export function classifyService(category: string, description: string): ClimateService | undefined {
  return climateServiceFor(category, description);
}
