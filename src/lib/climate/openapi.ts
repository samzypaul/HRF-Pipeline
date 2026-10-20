import { DEFAULT_LIMIT, DEFAULT_RADIUS_KM, MAX_LIMIT, MAX_RADIUS_KM } from "./api";
import { SERVICES } from "./catalogue";

/** OpenAPI 3.0 description of the public climate API, served at /api/v1/climate/openapi.json for app developers and API tools. */
export function openApiSpec(origin: string) {
  const lang = { name: "lang", in: "query", schema: { type: "string", enum: ["en", "sw"], default: "en" }, description: "Language of service, tier and category names: English or Kiswahili." };
  const error = { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  return {
    openapi: "3.0.3",
    info: {
      title: "HFR climate-sensitive health facilities API",
      version: "1.0.0",
      description:
        "Open, read-only access to the health facilities that offer climate-sensitive services (for the El Niño rains), with the services each one offers in English and Kiswahili. " +
        "Data comes from the Tanzania Health Facility Registry (HFR). Locations are checked but can be approximate (see `location.approximate`). Responses are cached for a few minutes. " +
        "Please keep to about 100 requests a minute per address.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/v1/climate/facilities": {
        get: {
          summary: "Search facilities",
          description: "Facilities that are operating, have a location and offer at least one climate-sensitive service. Sorted by distance when `lat` and `lng` are given, else by name.",
          parameters: [
            lang,
            { name: "service", in: "query", schema: { type: "string" }, description: `Comma-separated service codes; a facility must offer at least one. Codes: ${SERVICES.map((s) => s.code).join(", ")}.` },
            { name: "tier", in: "query", schema: { type: "string" }, description: "Comma-separated priority tiers 1 to 5 (1 = direct climate-sensitive services)." },
            { name: "region", in: "query", schema: { type: "string" }, description: "Region code from /regions, for example TZ.CL.DO." },
            { name: "council", in: "query", schema: { type: "string" }, description: "Council code from /regions?region=…" },
            { name: "q", in: "query", schema: { type: "string", maxLength: 80 }, description: "Part of the facility name." },
            { name: "lat", in: "query", schema: { type: "number" }, description: "Latitude of the point to search around (needs lng)." },
            { name: "lng", in: "query", schema: { type: "number" }, description: "Longitude of the point to search around (needs lat)." },
            { name: "radius_km", in: "query", schema: { type: "number", default: DEFAULT_RADIUS_KM, maximum: MAX_RADIUS_KM }, description: "Search radius around lat and lng." },
            { name: "min_confidence", in: "query", schema: { type: "string", enum: ["medium", "high"] }, description: "Only facilities whose location is at least this certain." },
            { name: "limit", in: "query", schema: { type: "integer", default: DEFAULT_LIMIT, maximum: MAX_LIMIT } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { "200": { description: "A page of facilities", content: { "application/json": { schema: { $ref: "#/components/schemas/FacilityList" } } } }, "400": error, "429": error },
        },
      },
      "/api/v1/climate/facilities/{code}": {
        get: {
          summary: "One facility",
          parameters: [{ name: "code", in: "path", required: true, schema: { type: "string" }, description: "Facility code, for example 121333-9." }, lang],
          responses: { "200": { description: "The facility", content: { "application/json": { schema: { $ref: "#/components/schemas/FacilityResponse" } } } }, "404": error },
        },
      },
      "/api/v1/climate/services": {
        get: { summary: "The climate-sensitive services", description: "Every service with its name, description, category, priority tier and the number of facilities offering it.", parameters: [lang], responses: { "200": { description: "The services" } } },
      },
      "/api/v1/climate/regions": {
        get: {
          summary: "Regions, or the councils of one region",
          parameters: [{ name: "region", in: "query", schema: { type: "string" }, description: "A region code: returns its councils instead of the regions." }],
          responses: { "200": { description: "Regions or councils with the number of facilities" } },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
        Service: {
          type: "object",
          properties: { code: { type: "string" }, name: { type: "string" }, tier: { type: "integer", minimum: 1, maximum: 5 }, tier_name: { type: "string" } },
        },
        Facility: {
          type: "object",
          properties: {
            code: { type: "string" },
            name: { type: "string" },
            type: { type: "string", nullable: true },
            ownership: { type: "string", nullable: true },
            phone: { type: "string", nullable: true, description: "International format when known, for example +255784755558." },
            region: { type: "string", nullable: true },
            district: { type: "string", nullable: true },
            council: { type: "string", nullable: true },
            ward: { type: "string", nullable: true },
            village: { type: "string", nullable: true },
            location: {
              type: "object",
              properties: {
                lat: { type: "number" },
                lng: { type: "number" },
                approximate: { type: "boolean", description: "True when the point is only the centre of an area or could not be confirmed." },
                confidence: { type: "string", enum: ["high", "medium", "low", "unchecked"] },
              },
            },
            distance_km: { type: "number", description: "Only when lat and lng were given." },
            services: { type: "array", items: { $ref: "#/components/schemas/Service" } },
          },
        },
        FacilityList: {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: "#/components/schemas/Facility" } },
            meta: { type: "object", properties: { total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" }, lang: { type: "string" }, attribution: { type: "string" } } },
          },
        },
        FacilityResponse: { type: "object", properties: { data: { $ref: "#/components/schemas/Facility" }, meta: { type: "object" } } },
      },
    },
  };
}
