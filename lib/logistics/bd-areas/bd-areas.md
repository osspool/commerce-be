# @classytic/bd-areas

Bangladesh delivery areas with multi-provider support. Contains 8 divisions, 64 districts, and 2836+ delivery areas.

## Installation

```bash
npm install @classytic/bd-areas
```

## Features

- **Complete Coverage**: All 8 divisions, 64 districts, 2836+ areas
- **Multi-Provider**: RedX, Pathao, Steadfast ID mappings
- **Type-Safe**: Full TypeScript support
- **Tree-Shakeable**: Import only what you need
- **Zero Dependencies**: Pure data, no external dependencies

## API Reference

### Divisions

```typescript
import {
  DIVISIONS,
  getDivisions,
  getDivisionById,
  getDivisionByName,
} from '@classytic/bd-areas';

// Get all 8 divisions
const divisions = getDivisions();

// Find by ID
const dhaka = getDivisionById('dhaka');
// { id: 'dhaka', name: 'Dhaka', nameLocal: 'ঢাকা' }

// Find by name (English or Bengali)
const division = getDivisionByName('ঢাকা');
```

### Districts

```typescript
import {
  DISTRICTS,
  getAllDistricts,
  getDistrictsByDivision,
  getDistrictById,
} from '@classytic/bd-areas';

// Get all 64 districts
const all = getAllDistricts();

// Get districts for a division (for cascading dropdown)
const dhakaDistricts = getDistrictsByDivision('dhaka');
// [{ id: 'dhaka', name: 'Dhaka', divisionId: 'dhaka' }, ...]

// Find by ID
const gazipur = getDistrictById('gazipur');
```

### Areas

```typescript
import {
  AREAS,
  getAllAreas,
  getAreasByDistrict,
  getAreasByDivision,
  getAreasByPostCode,
  getArea,
  getAreaByProvider,
} from '@classytic/bd-areas';

// Get all 2836+ areas
const all = getAllAreas();

// Get areas for a district (for cascading dropdown)
const dhakaAreas = getAreasByDistrict('dhaka');

// Get areas for entire division
const divisionAreas = getAreasByDivision('dhaka');

// Get areas by postal code
const areas1207 = getAreasByPostCode(1207);

// Get specific area by internal ID
const area = getArea(1206);
// { internalId: 1206, name: 'Mohammadpur', providers: { redx: 1206 }, ... }

// Get area by provider-specific ID
const areaByRedx = getAreaByProvider('redx', 1206);
```

### Utilities

```typescript
import {
  resolveArea,
  convertProviderId,
  searchAreas,
  getStats,
} from '@classytic/bd-areas';

// Resolve area with full division/district objects
const resolved = resolveArea(1206);
// { ...area, division: Division, district: District }

// Convert between provider IDs
const pathaoId = convertProviderId('redx', 1206, 'pathao');

// Search areas by name, postcode, district, or division
const results = searchAreas('mohammadpur');
// [{ internalId: 1206, name: 'Mohammadpur', ... }, ...]

// Get statistics
const stats = getStats();
// {
//   divisions: 8,
//   districts: 64,
//   areas: 2836,
//   providerCoverage: { redx: 2836, pathao: 0, steadfast: 0 },
//   byDivision: [{ division: 'Dhaka', districts: 13, areas: 892 }, ...]
// }
```

## Use Cases

### Frontend: Cascading Address Dropdown

```tsx
// React example
function AddressForm() {
  const [divisionId, setDivisionId] = useState('');
  const [districtId, setDistrictId] = useState('');
  const [areaId, setAreaId] = useState<number | null>(null);

  const divisions = getDivisions();
  const districts = divisionId ? getDistrictsByDivision(divisionId) : [];
  const areas = districtId ? getAreasByDistrict(districtId) : [];

  return (
    <form>
      <select onChange={(e) => setDivisionId(e.target.value)}>
        <option value="">Select Division</option>
        {divisions.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>

      <select onChange={(e) => setDistrictId(e.target.value)} disabled={!divisionId}>
        <option value="">Select District</option>
        {districts.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>

      <select onChange={(e) => setAreaId(Number(e.target.value))} disabled={!districtId}>
        <option value="">Select Area</option>
        {areas.map((a) => (
          <option key={a.internalId} value={a.internalId}>{a.name}</option>
        ))}
      </select>
    </form>
  );
}
```

### Backend: Address Validation

```typescript
// Validate and resolve customer address
function validateAddress(areaId: number) {
  const resolved = resolveArea(areaId);

  if (!resolved) {
    throw new Error('Invalid area ID');
  }

  return {
    area: resolved.name,
    district: resolved.district.name,
    division: resolved.division.name,
    divisionLocal: resolved.division.nameLocal,
    postCode: resolved.postCode,
  };
}
```

### Multi-Provider ID Conversion

```typescript
// When switching from RedX to Pathao
function getPathaoAreaId(redxAreaId: number): number | undefined {
  return convertProviderId('redx', redxAreaId, 'pathao');
}

// Or get the area and access directly
const area = getAreaByProvider('redx', redxAreaId);
const pathaoId = area?.providers.pathao;
```

## Types

```typescript
interface Division {
  id: string;
  name: string;
  nameLocal: string;
}

interface District {
  id: string;
  name: string;
  divisionId: string;
  divisionName: string;
}

interface Area {
  internalId: number;
  name: string;
  postCode: number | null;
  zoneId: number;
  districtId: string;
  districtName: string;
  divisionId: string;
  divisionName: string;
  providers: ProviderAreaIds;
}

interface ProviderAreaIds {
  redx?: number;
  pathao?: number;
  steadfast?: number;
}

type ProviderName = 'redx' | 'pathao' | 'steadfast';
```
