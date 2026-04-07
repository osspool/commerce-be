#!/usr/bin/env node

/**
 * Generate Areas Constants File
 *
 * Fetches areas from RedX API and generates/updates bd-areas.js constants file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REDX_API_URL = process.env.REDX_API_URL || 'https://sandbox.redx.com.bd/v1.0.0-beta';
const REDX_API_KEY = process.env.REDX_API_KEY;

interface RedXArea {
  id: number;
  name: string;
  division_name?: string;
  post_code?: number | string;
  zone_id: number;
}

interface GroupedArea {
  id: number;
  name: string;
  postCode: string | null;
  zoneId: number;
}

interface GeneratedArea {
  id: number;
  name: string;
  postCode: string | null;
  zone: string;
  providers: { redx: number };
}

async function fetchRedXAreas(): Promise<RedXArea[]> {
  console.log('Fetching areas from RedX...');

  const response = await fetch(`${REDX_API_URL}/areas`, {
    headers: {
      'API-ACCESS-TOKEN': `Bearer ${REDX_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`RedX API error: ${response.status}`);
  }

  const data = (await response.json()) as { areas?: RedXArea[] };
  return data.areas || [];
}

function groupAreasByDivision(areas: RedXArea[]): Record<string, GroupedArea[]> {
  const grouped: Record<string, GroupedArea[]> = {};

  for (const area of areas) {
    const divisionKey = area.division_name?.toLowerCase().replace(/\s+/g, '-') || 'other';

    if (!grouped[divisionKey]) {
      grouped[divisionKey] = [];
    }

    grouped[divisionKey].push({
      id: area.id,
      name: area.name,
      postCode: area.post_code?.toString() || null,
      zoneId: area.zone_id,
    });
  }

  return grouped;
}

function inferZone(divisionName: string | undefined, areaName: string, zoneId: number): string {
  const lowerDiv = divisionName?.toLowerCase() || '';
  const _lowerName = areaName?.toLowerCase() || '';

  if (lowerDiv === 'dhaka') {
    if (zoneId === 1) return 'dhaka-metro';
    return 'dhaka-suburb';
  }

  if (lowerDiv === 'chittagong' || lowerDiv === 'chattogram') {
    return 'chittagong-metro';
  }

  const divisionalCities = ['rajshahi', 'khulna', 'sylhet', 'rangpur', 'barishal', 'mymensingh'];
  if (divisionalCities.includes(lowerDiv)) {
    return 'divisional';
  }

  return 'district';
}

function generateConstantsFile(redxAreas: RedXArea[]): string {
  const grouped = groupAreasByDivision(redxAreas);

  const dhakaAreas: GeneratedArea[] = (grouped.dhaka || [])
    .map((area, index) => ({
      id: index + 1,
      name: area.name.replace(/\(.*\)/, '').trim(),
      postCode: area.postCode,
      zone: inferZone('Dhaka', area.name, area.zoneId),
      providers: {
        redx: area.id,
      },
    }))
    .slice(0, 100);

  const template = `/**
 * Bangladesh Delivery Areas (Auto-Generated)
 *
 * Generated from RedX API on: ${new Date().toISOString()}
 * Total areas synced: ${redxAreas.length}
 *
 * DO NOT EDIT MANUALLY - regenerate with:
 * node modules/logistics/scripts/generate-areas.js
 */

// ============================================
// DIVISIONS
// ============================================

export const DIVISIONS = [
  { id: 'dhaka', name: 'Dhaka', nameLocal: '\u09A2\u09BE\u0995\u09BE' },
  { id: 'chittagong', name: 'Chittagong', nameLocal: '\u099A\u099F\u09CD\u099F\u0997\u09CD\u09B0\u09BE\u09AE' },
  { id: 'rajshahi', name: 'Rajshahi', nameLocal: '\u09B0\u09BE\u099C\u09B6\u09BE\u09B9\u09C0' },
  { id: 'khulna', name: 'Khulna', nameLocal: '\u0996\u09C1\u09B2\u09A8\u09BE' },
  { id: 'sylhet', name: 'Sylhet', nameLocal: '\u09B8\u09BF\u09B2\u09C7\u099F' },
  { id: 'rangpur', name: 'Rangpur', nameLocal: '\u09B0\u0982\u09AA\u09C1\u09B0' },
  { id: 'barishal', name: 'Barishal', nameLocal: '\u09AC\u09B0\u09BF\u09B6\u09BE\u09B2' },
  { id: 'mymensingh', name: 'Mymensingh', nameLocal: '\u09AE\u09AF\u09BC\u09AE\u09A8\u09B8\u09BF\u0982\u09B9' },
];

// ============================================
// DELIVERY ZONES (For Pricing)
// ============================================

export const DELIVERY_ZONES = {
  'dhaka-metro': { name: 'Dhaka Metro', baseCharge: 60, codPercentage: 1 },
  'dhaka-suburb': { name: 'Dhaka Suburb', baseCharge: 80, codPercentage: 1 },
  'chittagong-metro': { name: 'Chittagong Metro', baseCharge: 100, codPercentage: 1.5 },
  'divisional': { name: 'Divisional Cities', baseCharge: 120, codPercentage: 1.5 },
  'district': { name: 'District Towns', baseCharge: 130, codPercentage: 2 },
  'remote': { name: 'Remote Areas', baseCharge: 150, codPercentage: 2.5 },
};

// ============================================
// AREAS (Synced from RedX)
// ============================================

export const AREAS = ${JSON.stringify(dhakaAreas, null, 2)};

// ============================================
// HELPER FUNCTIONS
// ============================================

export function getAllAreas() {
  return AREAS;
}

export function getAreaById(id) {
  return AREAS.find(a => a.id === id);
}

export function getProviderAreaId(areaId, provider) {
  const area = getAreaById(areaId);
  return area?.providers?.[provider] || null;
}

export function searchAreas(query, limit = 20) {
  const q = query.toLowerCase();
  return AREAS
    .filter(a => a.name.toLowerCase().includes(q) || a.postCode?.includes(q))
    .slice(0, limit);
}

export function estimateDeliveryCharge(zoneId, codAmount = 0) {
  const zone = DELIVERY_ZONES[zoneId] || DELIVERY_ZONES['district'];
  const codCharge = Math.round(codAmount * (zone.codPercentage / 100));
  return {
    deliveryCharge: zone.baseCharge,
    codCharge,
    totalCharge: zone.baseCharge + codCharge,
  };
}

export default {
  DIVISIONS,
  DELIVERY_ZONES,
  AREAS,
  getAllAreas,
  getAreaById,
  getProviderAreaId,
  searchAreas,
  estimateDeliveryCharge,
};
`;

  return template;
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Generate BD Areas Constants');
  console.log('='.repeat(60));

  if (!REDX_API_KEY) {
    console.error('Error: REDX_API_KEY environment variable required');
    console.log('Using existing bd-areas.js file (manual mode)');
    process.exit(0);
  }

  try {
    const areas = await fetchRedXAreas();
    console.log(`Fetched ${areas.length} areas from RedX`);

    const content = generateConstantsFile(areas);

    const outputPath = path.join(__dirname, '../constants/bd-areas.generated.js');
    fs.writeFileSync(outputPath, content, 'utf8');

    console.log(`\nGenerated: ${outputPath}`);
    console.log('\nTo use the generated file:');
    console.log('  1. Review the generated file');
    console.log('  2. Copy to bd-areas.js or import from bd-areas.generated.js');

    console.log(`\n${'='.repeat(60)}`);
    console.log('Done!');
    console.log('='.repeat(60));
  } catch (error) {
    const err = error as Error;
    console.error('Generation failed:', err.message);
    process.exit(1);
  }
}

main().catch(console.error);
