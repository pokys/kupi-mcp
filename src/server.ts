import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { BasketPlanner } from './basket.js';
import { BranchDirectory } from './branches.js';
import { KupiClient, KupiClientError } from './client.js';
import type { Config } from './config.js';
import { SearchService } from './search.js';
import type { BasketResult, NearbyBranch, Offer, Product, SearchResult } from './types.js';

const location = z.string().trim().min(1).max(120);
const stores = z.array(z.string().trim().min(1).max(100)).max(50);
const exclude = z
  .array(z.string().trim().min(1).max(50))
  .max(20)
  .describe('Slova, která produkt diskvalifikují, například ["uzená"].');
const validOn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Použijte datum ve tvaru YYYY-MM-DD.')
  .describe('Datum, ke kterému musí akce platit. Výchozí je dnešek v Praze.');
const radiusKm = z
  .number()
  .positive()
  .max(200)
  .optional()
  .describe(
    'Vrať jen řetězce s ověřenou pobočkou do této vzdušné vzdálenosti. Bez tohoto parametru nástroj vzdálenost NEZNÁ. Stojí další HTTP požadavky.',
  );
const origin = z
  .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
  .optional()
  .describe('Přesný výchozí bod; jinak se odvodí z poboček v zadané lokalitě.');
const unit = z.enum(['g', 'kg', 'ml', 'l', 'ks']);

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// The MCP schema mirrors the shape of the result rather than restating every field: the
// types are the contract, and a second copy of them here would only drift.
const outputSchema = {
  success: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      status: z.number().int().nullable(),
      retryable: z.boolean(),
    })
    .optional(),
} as const;

function czk(value: number | null): string {
  return value === null
    ? 'neuvedena'
    : `${new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2 }).format(value)} Kč`;
}

function offerLine(offer: Offer): string {
  const flags = [
    offer.membershipRequired ? 'klubová cena' : null,
    offer.mobileAppRequired ? 'pouze v aplikaci' : null,
    offer.quantityLimit !== null ? `limit ${offer.quantityLimit} ks` : null,
    offer.needsManualCheck ? 'podmínku nutno ověřit ručně' : null,
  ].filter(Boolean);
  const perUnit =
    offer.unitPrice !== null
      ? ` (${czk(offer.unitPrice)} / ${offer.unitPriceUnit ?? 'jednotku'})`
      : '';
  return `  - ${offer.store ?? 'Neznámý obchod'}: ${czk(offer.price)}${perUnit}; ${
    offer.validityText ?? 'platnost neuvedena'
  }${flags.length > 0 ? `; ${flags.join(', ')}` : ''}`;
}

function productLines(product: Product): string {
  const match = product.match
    ? ` [shoda ${product.match.quality}, ${product.match.score.toFixed(2)}${
        product.match.differs.length > 0 ? `; odlišuje se: ${product.match.differs.join(', ')}` : ''
      }]`
    : '';
  return [
    `- ${product.name}${product.packageText ? `, ${product.packageText}` : ''}${match} — ${product.productUrl}`,
    ...(product.offers.length > 0 ? product.offers.map(offerLine) : ['  - bez rozpoznané akce']),
  ].join('\n');
}

/**
 * Says "dle běžné otevírací doby" on purpose: the source has no holidays or one-off
 * closures, so this must never read as a guarantee that the shop is open.
 */
function openingLine(branch: NearbyBranch): string {
  const { opening } = branch;
  if (opening.open === null) return '; otevírací doba neuvedena';
  if (!opening.open) {
    return opening.opensAt
      ? `; dle běžné otevírací doby zavřeno, otevírá ${opening.opensAt}`
      : '; dle běžné otevírací doby dnes již zavřeno';
  }
  const closing = opening.closesAt ? `, zavírá ${opening.closesAt}` : '';
  const tight =
    opening.minutesUntilClose !== null && opening.minutesUntilClose <= 60
      ? ` — už jen ${opening.minutesUntilClose} min!`
      : '';
  return `; dle běžné otevírací doby otevřeno${closing}${tight}`;
}

function searchText(title: string, result: SearchResult): string {
  const lines = [
    title,
    `Lokalita dat: ${result.location}`,
    `Načteno: ${result.retrievedAt}`,
    `Zdroj: ${result.sourceUrl}`,
  ];
  if (result.radiusKm !== undefined) {
    lines.push(
      result.resolvedOrigin
        ? `Radius: ${result.radiusKm} km vzdušnou čarou od ${result.resolvedOrigin.name} (zdroj ${result.resolvedOrigin.source})`
        : `Radius ${result.radiusKm} km NEBYL použit: výchozí bod se nepodařilo ověřit, vzdálenost proto netvrdím.`,
    );
  }
  if (result.warnings.length > 0) lines.push(`Upozornění: ${result.warnings.join(' ')}`);
  lines.push(
    result.products.length > 0
      ? result.products.map(productLines).join('\n')
      : 'Nebyl nalezen žádný odpovídající produkt s rozpoznanou nabídkou.',
  );
  if (result.upcoming.length > 0) {
    lines.push('Akce, které teprve začnou (dnes NEPLATÍ):');
    for (const offer of result.upcoming) {
      const saving =
        offer.savingIfWaiting !== null && offer.savingIfWaiting > 0
          ? `; počkáním ušetříte ${czk(offer.savingIfWaiting)}`
          : '';
      lines.push(
        `  - ${offer.product} u ${offer.store ?? 'neznámého obchodu'}: ${czk(offer.price)} od ${offer.validFrom} (za ${offer.startsInDays} dní)${saving}`,
      );
    }
  }
  lines.push('Letáková akce není potvrzením skladové dostupnosti; cenu ověřte u prodejce.');
  return lines.join('\n');
}

function basketText(result: BasketResult): string {
  const lines = [
    result.status === 'complete'
      ? 'Návrh nákupu (kompletní košík)'
      : 'Návrh nákupu (NEÚPLNÝ košík)',
    `Lokalita dat: ${result.location}`,
    `Platnost akcí k: ${result.validOn}`,
    `Pokrytí: ${result.resolvedItems}/${result.totalItems} položek (${Math.round(result.coverage * 100)} %)`,
    result.status === 'complete'
      ? `Celkem za celý košík: ${czk(result.totalPrice)}`
      : `Cena vyřešené části: ${czk(result.resolvedPrice)} — NEJDE o cenu celého nákupu, ta není známa.`,
  ];
  if (result.radiusKm !== null) {
    lines.push(
      result.resolvedOrigin
        ? `Radius: ${result.radiusKm} km vzdušnou čarou od ${result.resolvedOrigin.name} (zdroj ${result.resolvedOrigin.source})`
        : `Radius ${result.radiusKm} km NEBYL použit: výchozí bod se nepodařilo ověřit.`,
    );
  }
  if (result.excludedChains.length > 0) {
    lines.push(
      `Mimo radius nebo neověřeno: ${result.excludedChains
        .map(
          (entry) =>
            `${entry.chain}${entry.distanceKm !== undefined ? ` (${entry.distanceKm} km)` : ' (pobočku nelze ověřit)'}`,
        )
        .join(', ')}`,
    );
  }
  for (const store of result.stores) {
    const branch = store.branch
      ? ` — pobočka ${store.branch.name}, ${store.branch.address.city} (${store.branch.distanceKm} km vzdušnou čarou; platnost akce na pobočce: ${store.branch.branchApplicability}${openingLine(store.branch)})`
      : '';
    lines.push(`${store.chain}${branch} — ${czk(store.subtotal)}`);
    for (const line of store.lines) {
      const amount =
        line.requestedQuantity && line.purchasedQuantity
          ? ` [požadováno ${line.requestedQuantity}, koupeno ${line.purchasedQuantity}]`
          : '';
      const pack = line.packCount ? ` (multipack po ${line.packCount} ks)` : '';
      const sanity =
        line.priceSanity.status === 'extreme' || line.priceSanity.status === 'high'
          ? `; cena za jednotku je ${line.priceSanity.ratioToMedian}× nad mediánem`
          : '';
      lines.push(
        `  - ${line.packages}× ${line.product.name}${line.offer.packageText ? ` (${line.offer.packageText})` : ''}${pack}: ${czk(line.packagePrice)}/balení → ${czk(line.purchasePrice)}${amount}${sanity}${line.note ? `; ${line.note}` : ''}`,
      );
    }
  }
  if (result.unresolved.length > 0) {
    lines.push(
      `Nenalezené položky: ${result.unresolved.map((item) => `${item.query} (${item.reason})`).join(', ')}`,
    );
  }
  if (result.warnings.length > 0) lines.push(`Upozornění: ${result.warnings.join(' ')}`);
  return lines.join('\n');
}

function toolError(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const failure =
    error instanceof KupiClientError
      ? error
      : new KupiClientError(
          error instanceof Error ? error.message : String(error),
          'NETWORK_ERROR',
        );
  console.error(`[kupi-mcp] ${failure.code}: ${failure.message}`);
  const structuredContent = {
    success: false,
    error: {
      code: failure.code,
      message: failure.message,
      status: failure.status,
      retryable: failure.retryable,
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}

export function createServer(config: Config, sharedClient?: KupiClient): McpServer {
  const client = sharedClient ?? new KupiClient(config);
  const branches = new BranchDirectory(client);
  // A generated snapshot keeps branch lookups off the request path. Its absence is not an
  // error: discovery falls back to fetching the branch pages live.
  branches.loadSnapshot();
  const search = new SearchService(client, branches);
  const planner = new BasketPlanner(search, branches);

  const server = new McpServer({
    name: 'kupi-mcp',
    version: '1.0.0',
    title: 'Kupi.cz',
    websiteUrl: 'https://github.com/pokys/kupi-mcp',
    icons: [
      { src: 'https://kupi-mcp.vercel.app/icon.png', mimeType: 'image/png', sizes: ['256x256'] },
    ],
  });

  server.registerTool(
    'search_products',
    {
      title: 'Vyhledat akční produkty na Kupi.cz',
      description:
        'Vyhledá slevové nabídky ve veřejném HTML Kupi.cz. BEZ parametru radiusKm nástroj NEZNÁ vzdálenost obchodů — neodvozuj ji z názvu obchodu („Albert Pardubice“ neznamená poblíž). Vrací jen akce platné k danému dni; akce, které teprve začnou, jsou odděleně v upcoming jako důvod počkat. Údaje o balení v dotazu („hermelín 100 g“) se automaticky oddělí, aby nekazily hledání. Každý produkt nese match.score (0–1) a match.quality vyjadřující, jak dobře odpovídá dotazu. Nejde o potvrzení skladové dostupnosti.',
      inputSchema: {
        query: z.string().trim().min(1).max(100),
        location: location.optional(),
        stores: stores.optional(),
        exclude: exclude.optional(),
        excludeMembershipOnly: z.boolean().default(false),
        sortBy: z.enum(['relevance', 'price', 'unit_price', 'discount']).default('relevance'),
        limit: z.number().int().min(1).max(20).default(8),
        validOn: validOn.optional(),
        radiusKm,
        origin,
      },
      outputSchema,
      annotations,
    },
    async (input) => {
      try {
        const { value } = await client.runWithRequestBudget(4, () => search.search(input));
        return {
          content: [{ type: 'text', text: searchText('Výsledky hledání', value) }],
          structuredContent: { success: true, ...value },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_product_offers',
    {
      title: 'Porovnat nabídky konkrétního produktu',
      description:
        'Načte veřejný detail produktu a vrátí nabídky všech obchodů, včetně klubových, aplikačních a množstevních podmínek. Detail nese víc obchodů než výsledek hledání, takže je to správný nástroj, jakmile je produkt známý.',
      inputSchema: z
        .object({
          productUrl: z.string().trim().min(1).max(300).optional(),
          slug: z.string().trim().min(1).max(160).optional(),
          location: location.optional(),
          stores: stores.optional(),
          excludeMembershipOnly: z.boolean().default(false),
          validOn: validOn.optional(),
        })
        .refine((value) => Boolean(value.productUrl) !== Boolean(value.slug), {
          message: 'Zadejte právě jedno z productUrl nebo slug.',
        }),
      outputSchema,
      annotations,
    },
    async (input) => {
      try {
        const { value } = await client.runWithRequestBudget(4, () => search.product(input));
        return {
          content: [{ type: 'text', text: searchText('Nabídky produktu', value) }],
          structuredContent: { success: true, ...value },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'compare_shopping_list',
    {
      title: 'Sestavit nákupní seznam z akcí',
      description:
        'Hlavní nástroj: sestaví realizovatelný akční košík. Maximalizuje pokrytí seznamu a přitom respektuje členství, množstevní limity, datum platnosti i maximální počet obchodů. Množství zadávejte přes amount + unit („2 kg“); počet balení dopočítá podle skutečné velikosti balení včetně multipacků. Neúplný košík má totalPrice null a cenu vyřešené části v resolvedPrice.',
      inputSchema: {
        items: z
          .array(
            z
              .object({
                query: z.string().trim().min(1).max(100),
                amount: z
                  .number()
                  .positive()
                  .max(1000)
                  .optional()
                  .describe('Kolik je potřeba, například 2 spolu s unit "kg".'),
                unit: unit.optional(),
                package: z
                  .object({
                    amount: z.number().positive().max(1000),
                    unit,
                    mode: z
                      .enum(['preferred', 'required'])
                      .default('preferred')
                      .describe(
                        'preferred = bližší velikost boduje lépe, jiná je povolena; required = jiná velikost se nepoužije.',
                      ),
                  })
                  .optional()
                  .describe('Požadovaná velikost balení a její závaznost.'),
                exclude: exclude.optional(),
              })
              .refine((item) => (item.amount === undefined) === (item.unit === undefined), {
                message: 'amount a unit musí být uvedeny společně.',
              }),
          )
          .min(1)
          .max(12),
        location: location.optional(),
        maxStores: z.number().int().min(1).max(8).default(3),
        allowedStores: stores.optional(),
        excludedStores: stores.optional(),
        availableMemberships: stores
          .optional()
          .describe('Věrnostní karty, které uživatel má; jen ty zpřístupní klubové ceny.'),
        validOn: validOn.optional(),
        radiusKm,
        origin,
      },
      outputSchema,
      annotations,
    },
    async (input) => {
      try {
        const budget = Math.min(20, input.items.length + 8);
        const { value, metrics } = await client.runWithRequestBudget(budget, () =>
          planner.plan(input),
        );
        if (metrics.requestBudgetRemaining === 0) {
          value.warnings.push(
            `Dosažen limit ${metrics.requestBudget} požadavků na zdroj; radius nebo část kandidátů může být neúplná.`,
          );
        }
        return {
          content: [{ type: 'text', text: basketText(value) }],
          structuredContent: { success: true, ...value },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
