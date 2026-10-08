// Load .env.local first (Next.js convention), then .env.
import { config } from "dotenv";
config({ path: [".env.local", ".env"], quiet: true });
