# Co víme o Kupi.cz

Zjištěno průzkumem živého webu a opakovaným provozem. Každý bod tady stál nejméně jednu
chybu v produkci, takže se vyplatí ho respektovat, i když kód zrovna svádí k opaku.

## Co je veřejně dostupné

| Cesta                         | Obsahuje                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `/hledej?f={dotaz}`           | Server-renderované výsledky: produkty, nabídky, lokalita, odkazy na nejbližší pobočky |
| `/sleva/{slug}`               | Detail produktu se všemi nabídkami                                                    |
| `/obchod/{retezec}`           | Stránka řetězce — **žádná** data o pobočkách                                          |
| `/obchod/{retezec}/{pobocka}` | JSON-LD `LocalBusiness` + `var markerPosition` se souřadnicemi a ID                   |

`robots.txt` zakazuje mimo jiné `/get-mesto`, `/get-locality-by-gps`, `/get-slevy`,
`/get-akce`, `/get-znacky`. Nepoužívají se a klient je má mimo allowlist cest.

Skupina `User-agent: AI` má v `robots.txt` úplný zákaz. Pro veřejné nebo objemné nasazení
je na místě výslovný souhlas provozovatele.

## Lokalita

Kupi drží lokalitu v cookies `user_locality` a `user_slocality`. Text „Pacov" na interní ID
překládá `/get-mesto`, který je zakázaný — proto se ID **nikdy neodhaduje**. Buď ho
provozovatel předá předem známé, nebo se použije anonymní výchozí lokalita podle IP a
výsledek nese varování.

Skutečná lokalita se **vždy** čte zpět z HTML selektorem
`.locality_near_headline [data-user-localizator]`. Nikdy se nepředstírá ta požadovaná.

Interní ID nejsou veřejné stabilní API a jsou to citlivá data provozovatele — do
repozitáře nepatří.

## Pobočky

Odkaz na nejbližší pobočku každého řetězce je ve výsledcích hledání:

```html
<div class="discounts_markets">
  <a href="/obchod/albert/albert-mesto" data-shop="Albert">8 nejbližších poboček</a>
</div>
```

Stránka pobočky nese souřadnice přímo, takže **externí geocoder není potřeba**:

```js
var markerPosition = { lat: 49.4698106, lng: 15.0020617, show: 1, id: 1142 };
```

`id` odpovídá internímu identifikátoru pobočky. Slouží jako stabilní klíč pro deduplikaci;
bez něj se použije řetězec + adresa.

**Stránka pobočky neobsahuje žádné ceny ani nabídky.** Ověřeno: nula elementů
`discount_row`. Z toho plyne rozdíl, který musí kód držet:

| Tvrzení                                 | Podloženo             |
| --------------------------------------- | --------------------- |
| Pobočka řetězce existuje a je v radiusu | **Ano**, ze souřadnic |
| Tato akce platí právě na této pobočce   | **Ne**                |

Proto `branchApplicability: "assumed"`, nikdy `confirmed`.

## Otevírací doba

JSON-LD `openingHours` ve tvaru `"Mo 07:00 - 20:00"`.

**`"Su 00:00 - 00:00"` znamená zavřeno celý den**, ne nonstop. Čtení rovnosti jako
24 hodin poslalo uživatele k zamčeným dveřím. Zavírací čas _menší_ než otevírací naopak
znamená přesah přes půlnoc.

Svátky, inventury ani jednorázová zavření zdroj neobsahuje. „Otevřeno" tedy znamená „podle
běžné doby ano", nikdy „ověřeno".

## Ceny a balení

Jednotková cena přichází v **různých základnách** — `100 g`, `1 kg`, `100 ml`. Bez
normalizace na jednu základnu (Kč/kg, Kč/l, Kč/ks) jsou čísla neporovnatelná. Jmenovatel
musí být v datech vždy uvedený, jinak se `499,67` čte jako Kč/g místo Kč/kg.

Kč/kg se nesmí porovnávat s Kč/ks — poměr mezi nimi nic neznamená.

Balení `6 × 0,5 l` je multipack: nese počet kusů i velikost jednoho kusu. Požadavek
v kusech se počítá podle počtu kusů v balení, požadavek v hmotnosti podle celkového obsahu.

Ekvivalentní zápisy: `0,5 l` = `0.5 l` = `500 ml`, `1 kg` = `1000 g`.

## Platnost akcí

Nabídka platí když `validFrom <= validOn <= validTo`. Akce se známým začátkem v budoucnu se
**nikdy** nevydává za aktuálně platnou.

Kupi často uvádí jen „platí do", takže `validFrom` chybí. Chybějící začátek se nedoplňuje a
nabídka zůstává zahrnutá — jinak by se ztratila většina akcí.

Data jako „zítra končí" a „platí 29. 8. – 3. 9." se parsují, samotný název dne ne.

## Sémantické pasti

Kupi vrací fulltextově blízké, ale významově jiné produkty. Reálně pozorované:

| Dotaz              | Vrací také                    | Score |
| ------------------ | ----------------------------- | ----- |
| `hermelín`         | Pomazánka hermelínová         | 0,53  |
| `máslo`            | Tuk cukrářský máslová příchuť | 0,43  |
| `vepřová krkovice` | Uzená / marinovaná krkovice   | 0,48  |
| `bageta`           | Obložená bageta               | 0,58  |
| `kuřecí prsa`      | Trhané kuře sous vide         | 0,43  |

Rozhoduje přítomnost slova, které mění **povahu** produktu (uzená, pomazánka, obložená,
příchuť, sous-vide). Sterilizace nebo konzervace povahu nemění — sterilovaná kukuřice je
pořád ta zelenina.

Skóre se musí počítat **vždy**, ne jen při řazení podle relevance. Když volající řadí podle
ceny, dostane jinak nejlevnější položku bez signálu, že je to špatný produkt.

## Podmínky nabídek

Klubovou cenu nepozná jen slovo „klub" — `Cena s Kaufland Card XTRA` je taky klubová.

Některé podmínky nelze z textu vyhodnotit: kupon, „2 + 1", „při koupi 2 ks", platnost jen
na vybraných prodejnách. Taková nabídka se nezahazuje, ale označí — uvedená cena nemusí být
cena u pokladny. Prostý limit „max 12 ks/osoba/den" cenu neovlivňuje.

## Výkon

Latenci určuje **náš vlastní rate limit**, ne Kupi. Limiter rezervuje sloty na jedné
globální ose, takže serializuje všechno bez ohledu na concurrency:

```text
wall-clock ≈ počet requestů × minRequestIntervalMs
```

Naměřeno: síť ~360 ms na request, parsing ~30 ms — obojí se vejde dovnitř intervalu.
Concurrency 1 a 2 se nelišily, dokud byl interval 1000 ms.

**Batching neexistuje.** Ověřeno: `f=maslo,chleb` vrátí totéž co `f=maslo` (druhý term se
ignoruje), `f=maslo+chleb` nevrátí nic. Jediný `application/ld+json` na stránce je
schema.org značkování, ne datové API.

Duplicitní requesty řeší cache klienta podle URL + lokality.
