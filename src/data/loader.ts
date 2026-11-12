import { readFile } from "node:fs/promises";
import path from "node:path";

export interface SeedDataset {
  brandProfile: Record<string, unknown>;
  services: Array<Record<string, unknown>>;
  competitors: Record<string, unknown>;
  calendar: Array<Record<string, unknown>>;
}

async function readJson<T>(fileName: string): Promise<T> {
  const fullPath = path.resolve("src", "data", fileName);
  const raw = await readFile(fullPath, "utf8");
  return JSON.parse(raw) as T;
}

export async function loadSeedDataset(): Promise<SeedDataset> {
  const [brandProfile, services, competitors, calendar] = await Promise.all([
    readJson<Record<string, unknown>>("brand-profile.json"),
    readJson<Array<Record<string, unknown>>>("services.json"),
    readJson<Record<string, unknown>>("competitors.json"),
    readJson<Array<Record<string, unknown>>>("india-market-calendar.json"),
  ]);

  return { brandProfile, services, competitors, calendar };
}

