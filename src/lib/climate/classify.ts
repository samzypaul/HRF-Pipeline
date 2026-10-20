import { SERVICES, type ClimateService } from "./catalogue";

/** Does one HFR service row (its category and its service name) belong to this climate-sensitive service? */
export function matches(service: ClimateService, category: string, description: string): boolean {
  return service.match.some((m) => (!m.category || m.category.test(category)) && (!m.description || m.description.test(description)));
}

/**
 * The climate-sensitive services an HFR service row stands for (usually none, sometimes one, rarely two).
 * Pure, so every rule can be unit-tested against real portal text.
 */
export function classifyService(category: string, description: string): ClimateService[] {
  const cat = category.trim();
  const desc = description.trim();
  return SERVICES.filter((s) => matches(s, cat, desc));
}
