/**
 * Bangladesh Divisions
 *
 * 8 administrative divisions of Bangladesh
 */

import type { Division } from './types.js';

export const DIVISIONS: Division[] = [
  { id: 'barisal', name: 'Barisal', nameLocal: 'বরিশাল' },
  { id: 'chittagong', name: 'Chittagong', nameLocal: 'চট্টগ্রাম' },
  { id: 'dhaka', name: 'Dhaka', nameLocal: 'ঢাকা' },
  { id: 'khulna', name: 'Khulna', nameLocal: 'খুলনা' },
  { id: 'mymensingh', name: 'Mymensingh', nameLocal: 'ময়মনসিংহ' },
  { id: 'rajshahi', name: 'Rajshahi', nameLocal: 'রাজশাহী' },
  { id: 'rangpur', name: 'Rangpur', nameLocal: 'রংপুর' },
  { id: 'sylhet', name: 'Sylhet', nameLocal: 'সিলেট' },
];

export function getDivisions(): Division[] {
  return DIVISIONS;
}

export function getDivisionById(id: string): Division | undefined {
  return DIVISIONS.find(d => d.id === id);
}

export function getDivisionByName(name: string): Division | undefined {
  const lower = name.toLowerCase();
  return DIVISIONS.find(d =>
    d.name.toLowerCase() === lower ||
    d.nameLocal === name
  );
}
