import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DataQuality, Platform } from '../domain/enums';
import { numberToFixed6 } from '../domain/fixed';
import {
  MarketDefinition,
  MarketRegistryDocument,
  MarketRegistrySourceMetadata,
  MarketResolution,
} from '../domain/models';

const EMPTY_DOCUMENT = (): MarketRegistryDocument => ({
  schemaVersion: 1,
  generatedAt: new Date(0).toISOString(),
  sources: {},
  markets: [],
});

export class MarketRegistryService {
  private documentValue: MarketRegistryDocument = EMPTY_DOCUMENT();

  constructor(private readonly path: string) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.path)) {
      this.documentValue = EMPTY_DOCUMENT();
      return;
    }
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    const document = normalizeDocument(parsed);
    validateDefinitions(document.markets);
    this.documentValue = document;
  }

  document(): MarketRegistryDocument {
    return structuredClone(this.documentValue);
  }

  list(): MarketDefinition[] {
    return this.documentValue.markets.map((item) => ({ ...item }));
  }

  listPlatform(platform: Platform): MarketDefinition[] {
    return this.list().filter((item) => item.platform === platform);
  }

  hasPlatform(platform: Platform): boolean {
    return this.documentValue.markets.some((item) => item.platform === platform);
  }

  source(platform: Platform): MarketRegistrySourceMetadata | undefined {
    const value = this.documentValue.sources[platform];
    return value ? { ...value } : undefined;
  }

  replace(
    definitions: MarketDefinition[],
    sources: Partial<Record<Platform, MarketRegistrySourceMetadata>> = this.documentValue.sources,
  ): void {
    validateDefinitions(definitions);
    const document: MarketRegistryDocument = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sources: { ...sources },
      markets: sortDefinitions(definitions),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    renameSync(temporary, this.path);
    this.documentValue = document;
  }

  replacePlatform(
    platform: Platform,
    definitions: MarketDefinition[],
    source: MarketRegistrySourceMetadata,
    preserveManual = true,
  ): void {
    if (definitions.some((item) => item.platform !== platform)) {
      throw new Error(`replacePlatform(${platform}) received a definition for another platform`);
    }
    const retained = this.documentValue.markets.filter((item) => {
      if (item.platform !== platform) return true;
      return preserveManual && item.source === 'manual';
    });
    const manualKeys = new Set(
      retained
        .filter((item) => item.platform === platform && item.source === 'manual')
        .map(definitionKey),
    );
    const discovered = definitions.filter((item) => !manualKeys.has(definitionKey(item)));
    this.replace([...retained, ...discovered], {
      ...this.documentValue.sources,
      [platform]: source,
    });
  }

  resolve(
    platform: Platform,
    marketAddress: string,
    collateralAddress?: string | null,
  ): MarketResolution {
    const exact = this.documentValue.markets.find(
      (item) =>
        item.platform === platform
        && item.marketAddress === marketAddress
        && (!item.collateralAddress
          || !collateralAddress
          || item.collateralAddress === collateralAddress),
    );
    const fallback = this.documentValue.markets.find(
      (item) => item.platform === platform && item.marketAddress === marketAddress,
    );
    const value = exact ?? fallback;
    if (!value) {
      return {
        platform,
        marketAddress,
        pair: `unknown:${marketAddress}`,
        known: false,
        collateralUsdPriceE6: null,
      };
    }
    return {
      ...value,
      known: true,
      collateralUsdPriceE6:
        typeof value.collateralUsdPrice === 'number'
          ? numberToFixed6(value.collateralUsdPrice)
          : value.collateralIsStable
            ? 1_000_000n
            : null,
    };
  }

  quality(
    resolution: MarketResolution,
    collateralComplete: boolean,
    stateComplete = true,
  ): DataQuality {
    if (!resolution.known) return DataQuality.PARTIAL_MARKET;
    if (!collateralComplete) return DataQuality.PARTIAL_COLLATERAL;
    if (!stateComplete) return DataQuality.PARTIAL_STATE;
    return DataQuality.COMPLETE;
  }
}

function normalizeDocument(value: unknown): MarketRegistryDocument {
  if (Array.isArray(value)) {
    return {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      sources: {},
      markets: value as MarketDefinition[],
    };
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Market registry must be a JSON array or a schemaVersion=1 document');
  }
  const candidate = value as Partial<MarketRegistryDocument>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.markets)) {
    throw new Error('Unsupported market registry document');
  }
  return {
    schemaVersion: 1,
    generatedAt: candidate.generatedAt ?? new Date(0).toISOString(),
    sources: candidate.sources ?? {},
    markets: candidate.markets,
  };
}

function definitionKey(item: MarketDefinition): string {
  return `${item.platform}:${item.marketAddress}:${item.collateralAddress ?? ''}`;
}

function sortDefinitions(definitions: MarketDefinition[]): MarketDefinition[] {
  return [...definitions].sort((left, right) =>
    left.platform.localeCompare(right.platform)
    || left.pair.localeCompare(right.pair)
    || left.marketAddress.localeCompare(right.marketAddress)
    || (left.collateralAddress ?? '').localeCompare(right.collateralAddress ?? ''),
  );
}

function validateDefinitions(definitions: MarketDefinition[]): void {
  const keys = new Set<string>();
  for (const item of definitions) {
    if (!Object.values(Platform).includes(item.platform)) {
      throw new Error(`Invalid platform: ${String(item.platform)}`);
    }
    if (!item.marketAddress || !item.pair) {
      throw new Error('marketAddress and pair are required');
    }
    const key = definitionKey(item);
    if (keys.has(key)) throw new Error(`Duplicate market definition: ${key}`);
    keys.add(key);
  }
}
