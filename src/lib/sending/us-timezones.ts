// US HQ-state → IANA timezone (operator item, Session 12).
//
// Every current lead is country=US, and the US spans several zones, so the
// Session 11 country fallback never applies. This table resolves a zone from
// the company's HQ state, and — for the states that span two zones — from an
// explicitly listed city. A missing state, an unrecognised state, or a split
// state whose city is missing or not listed is UNRESOLVED: the lead keeps its
// null timezone and the send stage keeps holding it as `timezone_unknown`.
// Nothing here guesses the majority zone of a split state.
//
// Arizona is treated as single-zone (America/Phoenix, no DST) except for the
// listed Navajo Nation communities, which observe DST (America/Denver).

export type UsTimezoneResult =
  | { ok: true; timeZone: string; source: "hq_state" | "hq_state_city"; state: string }
  | { ok: false; unresolved: "state_missing" | "state_unknown" | "ambiguous_split_state"; state: string | null };

const NY = "America/New_York";
const CHI = "America/Chicago";
const DEN = "America/Denver";
const PHX = "America/Phoenix";
const LA = "America/Los_Angeles";

/** USPS code → full name, used to normalise either form. */
const STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands", AS: "American Samoa",
  MP: "Northern Mariana Islands",
};

/** States (and territories) that lie entirely in one zone. */
export const SINGLE_ZONE_STATES: Readonly<Record<string, string>> = {
  AL: CHI, AR: CHI, AZ: PHX, CA: LA, CO: DEN, CT: NY, DE: NY, DC: NY, GA: NY,
  HI: "Pacific/Honolulu", IL: CHI, IA: CHI, LA: CHI, ME: NY, MD: NY, MA: NY, MN: CHI,
  MS: CHI, MO: CHI, MT: DEN, NH: NY, NJ: NY, NM: DEN, NY: NY, NC: NY, OH: NY, OK: CHI,
  PA: NY, RI: NY, SC: NY, UT: DEN, VT: NY, VA: NY, WA: LA, WV: NY, WI: CHI, WY: DEN,
  PR: "America/Puerto_Rico", GU: "Pacific/Guam", VI: "America/St_Thomas",
  AS: "Pacific/Pago_Pago", MP: "Pacific/Saipan",
};

/**
 * States that span two zones: city → zone, explicitly listed on both sides of
 * the line. A city not listed here is ambiguous and stays unresolved.
 */
export const SPLIT_STATE_CITIES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  AK: {
    "America/Anchorage": ["anchorage", "fairbanks", "juneau", "wasilla", "sitka", "ketchikan", "kenai", "kodiak", "palmer", "bethel", "homer", "nome", "soldotna", "valdez"],
    "America/Adak": ["adak", "atka"],
  },
  FL: {
    [NY]: ["miami", "orlando", "tampa", "jacksonville", "tallahassee", "fort lauderdale", "st petersburg", "hialeah", "port st lucie", "cape coral", "pembroke pines", "hollywood", "miramar", "gainesville", "coral springs", "clearwater", "palm bay", "west palm beach", "pompano beach", "lakeland", "davie", "boca raton", "sunrise", "deltona", "plantation", "palm coast", "fort myers", "naples", "sarasota", "boynton beach", "delray beach", "jupiter", "palm beach", "palm beach gardens", "kissimmee", "daytona beach", "melbourne", "ocala", "winter park", "doral", "coral gables", "aventura", "bradenton", "sanford", "st augustine", "vero beach", "key west", "weston", "wellington", "brandon", "largo", "ponte vedra beach", "fort pierce", "stuart", "port charlotte", "bonita springs", "estero", "lake mary", "altamonte springs", "oviedo", "clermont", "winter garden", "celebration", "miami beach", "north miami", "homestead", "apopka"],
    [CHI]: ["pensacola", "panama city", "panama city beach", "fort walton beach", "destin", "crestview", "navarre", "milton", "niceville", "gulf breeze", "defuniak springs", "marianna", "chipley", "mary esther", "santa rosa beach", "miramar beach", "lynn haven", "callaway"],
  },
  ID: {
    "America/Boise": ["boise", "meridian", "nampa", "idaho falls", "pocatello", "caldwell", "twin falls", "eagle", "kuna", "ammon", "chubbuck", "rexburg", "blackfoot", "mountain home", "burley", "star", "hailey", "ketchum", "sun valley", "jerome", "emmett"],
    [LA]: ["coeur dalene", "moscow", "lewiston", "post falls", "sandpoint", "hayden", "rathdrum", "bonners ferry", "grangeville"],
  },
  IN: {
    "America/Indiana/Indianapolis": ["indianapolis", "fort wayne", "south bend", "carmel", "fishers", "bloomington", "lafayette", "west lafayette", "muncie", "terre haute", "noblesville", "greenwood", "anderson", "elkhart", "mishawaka", "lawrence", "jeffersonville", "columbus", "westfield", "new albany", "kokomo", "richmond", "zionsville", "brownsburg", "plainfield", "avon", "goshen", "franklin", "granger", "shelbyville", "marion", "vincennes"],
    [CHI]: ["gary", "hammond", "merrillville", "valparaiso", "crown point", "portage", "michigan city", "la porte", "laporte", "schererville", "munster", "hobart", "highland", "chesterton", "dyer", "st john", "lake station", "east chicago", "whiting", "cedar lake", "griffith", "evansville", "newburgh", "boonville", "mount vernon", "princeton", "tell city", "rensselaer", "knox"],
  },
  KS: {
    [CHI]: ["wichita", "overland park", "kansas city", "olathe", "topeka", "lawrence", "shawnee", "manhattan", "lenexa", "salina", "hutchinson", "leawood", "leavenworth", "garden city", "dodge city", "emporia", "derby", "prairie village", "junction city", "hays", "liberal", "pittsburg", "gardner", "merriam", "mission", "colby", "great bend", "mcpherson", "newton", "andover"],
    [DEN]: ["goodland", "sharon springs", "tribune", "syracuse"],
  },
  KY: {
    [NY]: ["louisville", "lexington", "covington", "florence", "georgetown", "richmond", "frankfort", "nicholasville", "elizabethtown", "ashland", "independence", "erlanger", "winchester", "danville", "shelbyville", "berea", "bardstown", "somerset", "newport", "pikeville", "london", "radcliff", "fort thomas", "mount washington", "shepherdsville", "lawrenceburg"],
    [CHI]: ["bowling green", "owensboro", "paducah", "hopkinsville", "henderson", "madisonville", "murray", "glasgow", "mayfield", "russellville", "fort campbell", "scottsville"],
  },
  MI: {
    "America/Detroit": ["detroit", "grand rapids", "warren", "sterling heights", "ann arbor", "lansing", "east lansing", "flint", "dearborn", "livonia", "troy", "westland", "farmington hills", "kalamazoo", "wyoming", "southfield", "rochester hills", "taylor", "royal oak", "novi", "pontiac", "birmingham", "bloomfield hills", "marquette", "traverse city", "saginaw", "midland", "bay city", "holland", "muskegon", "battle creek", "jackson", "portage", "auburn hills", "sault ste marie", "escanaba", "houghton", "grosse pointe", "okemos", "canton", "plymouth", "northville", "brighton", "clarkston"],
    "America/Menominee": ["iron mountain", "menominee", "ironwood", "iron river", "kingsford", "norway", "bessemer", "wakefield"],
  },
  NE: {
    [CHI]: ["omaha", "lincoln", "bellevue", "grand island", "kearney", "fremont", "hastings", "norfolk", "columbus", "north platte", "papillion", "la vista", "south sioux city", "beatrice", "lexington", "elkhorn", "gretna", "valentine"],
    [DEN]: ["scottsbluff", "gering", "alliance", "sidney", "chadron", "ogallala", "kimball"],
  },
  NV: {
    [LA]: ["las vegas", "henderson", "reno", "north las vegas", "sparks", "carson city", "fernley", "elko", "mesquite", "boulder city", "summerlin", "paradise", "enterprise", "spring valley", "pahrump", "minden", "gardnerville", "incline village", "winnemucca"],
    [DEN]: ["west wendover"],
  },
  ND: {
    [CHI]: ["fargo", "bismarck", "grand forks", "minot", "west fargo", "williston", "mandan", "jamestown", "wahpeton", "devils lake", "valley city", "watford city"],
    [DEN]: ["dickinson", "bowman", "beach", "hettinger", "belfield"],
  },
  OR: {
    [LA]: ["portland", "eugene", "salem", "gresham", "hillsboro", "beaverton", "bend", "medford", "springfield", "corvallis", "albany", "tigard", "lake oswego", "keizer", "grants pass", "oregon city", "mcminnville", "redmond", "tualatin", "west linn", "woodburn", "wilsonville", "klamath falls", "pendleton", "hermiston", "roseburg", "astoria", "newberg", "happy valley", "milwaukie", "sherwood", "the dalles", "hood river", "la grande", "baker city", "coos bay", "ashland"],
    "America/Boise": ["ontario", "nyssa", "vale"],
  },
  SD: {
    [CHI]: ["sioux falls", "aberdeen", "brookings", "watertown", "mitchell", "yankton", "pierre", "huron", "vermillion", "brandon", "harrisburg", "tea"],
    [DEN]: ["rapid city", "spearfish", "sturgis", "belle fourche", "hot springs", "lead", "deadwood", "custer", "box elder"],
  },
  TN: {
    [CHI]: ["nashville", "memphis", "clarksville", "murfreesboro", "franklin", "jackson", "hendersonville", "brentwood", "smyrna", "collierville", "germantown", "bartlett", "spring hill", "lebanon", "gallatin", "cookeville", "mount juliet", "columbia", "la vergne", "cordova", "nolensville", "dickson", "shelbyville", "tullahoma", "manchester", "mcminnville", "crossville", "thompsons station", "goodlettsville", "antioch", "hermitage", "arlington", "millington", "dyersburg", "union city", "paris", "martin", "lakeland"],
    [NY]: ["knoxville", "chattanooga", "johnson city", "kingsport", "bristol", "cleveland", "maryville", "morristown", "oak ridge", "athens", "greeneville", "sevierville", "gatlinburg", "pigeon forge", "elizabethton", "farragut"],
  },
  TX: {
    [CHI]: ["houston", "san antonio", "dallas", "austin", "fort worth", "arlington", "corpus christi", "plano", "laredo", "lubbock", "irving", "garland", "frisco", "mckinney", "amarillo", "grand prairie", "brownsville", "killeen", "pasadena", "mesquite", "mcallen", "denton", "waco", "carrollton", "midland", "odessa", "round rock", "abilene", "pearland", "richardson", "sugar land", "the woodlands", "beaumont", "college station", "lewisville", "league city", "tyler", "wichita falls", "allen", "san angelo", "edinburg", "conroe", "bryan", "katy", "spring", "cypress", "humble", "southlake", "flower mound", "georgetown", "pflugerville", "new braunfels", "san marcos", "mansfield", "cedar park", "leander", "kyle", "coppell", "grapevine", "keller", "rockwall", "prosper", "celina", "addison", "bellaire", "temple", "longview", "texarkana", "galveston", "harlingen", "mission", "weatherford", "burleson", "boerne", "friendswood", "missouri city", "baytown", "kingwood", "tomball", "magnolia", "dripping springs", "lakeway", "westlake", "colleyville", "university park", "highland park", "fredericksburg", "kerrville", "nacogdoches", "lufkin", "huntsville", "victoria", "port arthur", "big spring"],
    [DEN]: ["el paso", "socorro", "horizon city", "canutillo", "anthony", "san elizario", "fabens", "sierra blanca", "dell city"],
  },
};

/** Arizona's Navajo Nation communities observe DST, unlike the rest of the state. */
const ARIZONA_NAVAJO_CITIES: readonly string[] = ["window rock", "chinle", "tuba city", "kayenta", "ganado", "fort defiance"];

function key(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/[,]/g, " ")
    .replace(/^saint\s+/, "st ")
    .replace(/\s+/g, " ");
}

const NAME_TO_CODE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [code, name] of Object.entries(STATE_NAMES)) {
    map.set(key(name), code);
    map.set(key(code), code);
  }
  for (const [alias, code] of [
    ["washington dc", "DC"],
    ["washington d c", "DC"],
    ["us virgin islands", "VI"],
    ["virgin islands", "VI"],
  ] as const) {
    map.set(key(alias), code);
  }
  return map;
})();

/** USPS code for a state given as a code or an English name; null if unknown. */
export function normalizeUsState(state: string | null | undefined): string | null {
  const raw = (state ?? "").trim();
  if (!raw) return null;
  return NAME_TO_CODE.get(key(raw)) ?? null;
}

export function isSplitState(code: string): boolean {
  return code in SPLIT_STATE_CITIES;
}

/** Resolve a recipient zone from an HQ state (+ city for split states). Never guesses. */
export function resolveUsTimezone(input: { state: string | null | undefined; city: string | null | undefined }): UsTimezoneResult {
  if (!(input.state ?? "").trim()) return { ok: false, unresolved: "state_missing", state: null };
  const code = normalizeUsState(input.state);
  if (!code) return { ok: false, unresolved: "state_unknown", state: input.state ?? null };
  const city = input.city ? key(input.city) : "";

  if (code === "AZ" && city && ARIZONA_NAVAJO_CITIES.includes(city)) {
    return { ok: true, timeZone: DEN, source: "hq_state_city", state: code };
  }
  const single = SINGLE_ZONE_STATES[code];
  if (single) return { ok: true, timeZone: single, source: "hq_state", state: code };

  const zones = SPLIT_STATE_CITIES[code];
  if (!zones || !city) return { ok: false, unresolved: "ambiguous_split_state", state: code };
  const matches = Object.entries(zones).filter(([, cities]) => cities.includes(city));
  if (matches.length !== 1) return { ok: false, unresolved: "ambiguous_split_state", state: code };
  return { ok: true, timeZone: matches[0]![0], source: "hq_state_city", state: code };
}
