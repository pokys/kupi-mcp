# kupi-mcp

Neoficiální MCP server nad veřejnými slevovými stránkami [Kupi.cz](https://www.kupi.cz).
Pouze čte: vyhledá akční produkty, porovná nabídky jednoho produktu a sestaví z akcí
nákupní seznam.

Není spojený s provozovatelem Kupi.cz ani jím schválený.

## Nástroje

| Nástroj                 | K čemu je                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `search_products`       | Najde akční produkty. Každý výsledek nese `match.score` (0–1) a `match.quality`, tedy jak dobře odpovídá dotazu. |
| `get_product_offers`    | Nabídky jednoho produktu z jeho detailu — víc obchodů než výsledek hledání.                                      |
| `compare_shopping_list` | Hlavní nástroj: z celého seznamu sestaví proveditelný nákup přes několik obchodů.                                |

Volitelný parametr `radiusKm` u prvního a třetího omezí výsledek na řetězce s ověřenou
pobočkou v okolí. Stojí další HTTP požadavky; bez něj server vzdálenost obchodů nezná.

## Čemu výstup věří a čemu ne

- Leták není sklad. Cena z akce neznamená, že produkt na pobočce je.
- Vzdálenost je vzdušná čára ze souřadnic pobočky, ne délka jízdy.
- Otevírací doba je běžná týdenní; svátky a jednorázová zavření zdroj neuvádí.
- Platnost akce na konkrétní pobočce se nedá z veřejných stránek ověřit, proto je
  označená jako `assumed`.
- Neúplný košík má `totalPrice: null`. Cena vyřešené části je v `resolvedPrice`.
- Produkt, který dotazu neodpovídá dost jistě, se nepoužije; položka zůstane nevyřešená.

## Lokalita

Kupi.cz drží lokalitu v cookies. Endpoint, který překládá název města na interní ID, je
zakázaný v `robots.txt`, takže se ID nikdy neodhaduje. Buď ho předáte v
`KUPI_LOCALITIES`, nebo se použije anonymní výchozí lokalita podle IP — a výsledek
vždy uvádí, pro kterou lokalitu data skutečně jsou.

ID si zjistíte ve vlastním prohlížeči z cookies `user_locality` a `user_slocality` po
nastavení města na Kupi.cz. Jsou to provozní data; do repozitáře nepatří.

## Konfigurace

| Proměnná                       | Výchozí   | Význam                                              |
| ------------------------------ | --------- | --------------------------------------------------- |
| `KUPI_LOCALITIES`              | prázdné   | `Mesto:localityId[:sublocalityId]`, oddělené čárkou |
| `KUPI_USER_AGENT`              | obecný    | User-Agent, kterým se server představuje            |
| `KUPI_MIN_REQUEST_INTERVAL_MS` | `600`     | Rozestup mezi požadavky na zdroj                    |
| `KUPI_MAX_CONCURRENCY`         | `2`       | Souběžné požadavky                                  |
| `KUPI_CACHE_TTL_MS`            | `1800000` | Platnost cache staženého HTML                       |
| `KUPI_TIMEOUT_MS`              | `15000`   | Timeout jednoho požadavku                           |
| `KUPI_MAX_RETRIES`             | `2`       | Opakování po dočasné chybě                          |
| `KUPI_MAX_RESPONSE_BYTES`      | `2097152` | Strop velikosti odpovědi                            |

Pro HTTP nasazení navíc:

| Proměnná                         | Význam                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| `MCP_HTTP_BEARER_TOKEN`          | Token, který klient posílá v `Authorization: Bearer` nebo `X-Api-Key` |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `1` otevře endpoint bez tokenu — jen pro lokální vývoj                |
| `MCP_HTTP_ALLOWED_ORIGINS`       | Povolené `Origin` pro prohlížečové klienty, oddělené čárkou           |
| `MCP_HTTP_MAX_BODY_BYTES`        | Strop velikosti požadavku (výchozí 1 MiB)                             |

Bez `MCP_HTTP_BEARER_TOKEN` a bez výslovného povolení anonymního přístupu endpoint
odpovídá `503`. Nezabezpečený server nikdy nevznikne omylem.

## Spuštění

```bash
npm ci
npm run build
npm start
```

Přes stdio, například v Claude Desktop:

```json
{
  "mcpServers": {
    "kupi": {
      "command": "node",
      "args": ["/cesta/ke/kupi-mcp/dist/index.js"],
      "env": { "KUPI_LOCALITIES": "Mesto:localityId:sublocalityId" }
    }
  }
}
```

## Nasazení na Vercel

Repozitář je připravený jako drop-in projekt: `api/mcp.ts` je MCP endpoint,
`api/health.ts` odpovídá na kořenové cestě. Nastavte `MCP_HTTP_BEARER_TOKEN` mezi
proměnnými prostředí projektu a nasaďte. `npm run package` vyrobí ZIP, který se dá na
Vercel přetáhnout beze změn.

Klient se pak připojí na `https://vase-nasazeni.vercel.app/api/mcp` s hlavičkou
`Authorization: Bearer <token>`; klienti, které vlastní hlavička `Authorization`
nepustí, mohou poslat `X-Api-Key`.

## Snapshot poboček

Vyhledávání s `radiusKm` jinak stahuje stránky poboček za běhu, což je po studeném startu
pomalé. Předgenerovaný snapshot to odstraní:

```bash
npm run branches:refresh -- --location Mesto --radius 50
```

Zapíše `data/store-branches.json`. Opakované běhy pro různá města se slučují. Soubor je
volitelný — bez něj se pobočky dohledávají živě.

## Vývoj

```bash
npm run typecheck
npm run lint
npm test
```

`npm run privacy:check` hlídá, aby se do repozitáře nedostaly e-maily, absolutní cesty
z domovského adresáře ani konkrétní ID lokalit.

Co jsme o zdroji zjistili a proč je kód místy opatrnější, než by se zdálo nutné, je
v [docs/kupi-facts.md](docs/kupi-facts.md).

## Ohleduplnost ke zdroji

Požadavky jsou sériové s rozestupem, odpovědi se cachují a odpovědi `429`/`403` se
nepřekračují — server se je nesnaží obejít, vrátí strukturovanou chybu. Skupina
`User-agent: AI` má v `robots.txt` Kupi.cz úplný zákaz; pro veřejné nebo objemné nasazení
si vyžádejte souhlas provozovatele.

## Licence

MIT, viz [LICENSE](LICENSE).
