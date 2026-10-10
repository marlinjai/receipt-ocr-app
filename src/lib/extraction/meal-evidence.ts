/**
 * Does the recognized text itself show that a receipt is from a restaurant,
 * cafe or bar?
 *
 * The category used to come from the first keyword that matched anywhere in
 * the text, so a bar receipt naming its waiter under "Server:" was filed as
 * software, and a taverna with none of the listed words as "other". Neither
 * reached the business-meal queue. The signs below are the ones a restaurant
 * receipt carries whatever the place is called: a table, a waiter, a tip
 * line, the printed hospitality form, dishes and drinks.
 */

export interface MealEvidence {
  /** Sum of the weights of the signs found. */
  score: number;
  /** True when the text alone is enough to file the receipt as a meal. */
  strong: boolean;
  signs: string[];
}

/** From this score on, the text alone decides. */
export const MEAL_EVIDENCE_THRESHOLD = 4;

const SIGNS: Array<{ name: string; weight: number; pattern: RegExp; headOnly?: boolean }> = [
  // The form German restaurants print for the business-meal deduction.
  { name: 'hospitality_form', weight: 4, pattern: /bewirtungsaufw(?:and|endungen)|bewirtete\s+person|anlass\s+d(?:er|\.)\s+bewirtung|bewirtungsbeleg/i },
  // Anywhere on a line: "Co Working, Tisch 30" names the table as much as "Tisch: 12" does.
  { name: 'table', weight: 2, pattern: /(?<![\p{L}])(?:tisch|table)\s*[:#]?\s*(?:\d|to\s*go|theke)/iu },
  { name: 'service', weight: 2, pattern: /es\s+bediente\s+sie|bedient\s+von|\bbediener\b|\bkellner(?:in)?\b|\bserver\s*:|\bguests?\s*:\s*\d/i },
  { name: 'venue', weight: 2, headOnly: true, pattern: /\b(?:restaurant|ristorante|ristoranty|trattoria|osteria|pizzeria|taverna?|bistro|brasserie|gasthaus|gasthof|gastst(?:ä|ae)tte|wirtshaus|biergarten|brauhaus|brauerei|brewery|caf(?:é|e)|coffee|kaffeehaus|foodbar|food\s*bar|imbiss|grill|sushi|kitchen|k(?:ü|ue)che|eatery|diner|gastronomie\w*|cantina|tapas|ramen|pho|burger)\b/i },
  { name: 'tip_line', weight: 1, pattern: /trinkgeld|\btip\b|gratuity/i },
  { name: 'dine_in_or_out', weight: 1, pattern: /\bim\s+haus\b|au(?:ß|ss)er\s+haus|\bto\s+go\b|\bzum\s+mitnehmen\b/i },
  { name: 'dish_groups', weight: 1, pattern: /\b(?:speisen|getr(?:ä|ae)nke|food|draught|vorspeise|hauptgericht|dessert)\b/i },
];

const DISH_WORDS =
  /\b(?:cappuccino|latte|espresso|macchiato|americano|kaffee|tee|chai|matcha|schokolade|kakao|wasser|mineralwasser|tafelwasser|cola|limo(?:nade)?|schorle|saft|bier|pils|radler|wei(?:ß|ss)bier|wein|merlot|aperol|cocktail|lassi|ayran|pizza|pasta|gnocchi|carbonara|risotto|suppe|salat|burger|pommes|schnitzel|curry|naan|samosa|pad\s*thai|sushi|ramen|bagel|croissant|sandwich|nachos|tofu|carpaccio|dessert|kuchen|cheesecake|fr(?:ü|ue)hst(?:ü|ue)ck|breakfast)\b/gi;

/** Shops whose receipts list food and drink without being a meal. */
const GROCERY = /\b(?:rewe|edeka|aldi|lidl|penny|netto|kaufland|dm[- ]drogerie|rossmann|alnatura|denn'?s|bio\s?company|supermarkt|getr(?:ä|ae)nkemarkt)\b/i;

export function mealEvidence(fullText: string): MealEvidence {
  const head = fullText.split('\n').slice(0, 8).join('\n');
  if (GROCERY.test(head)) return { score: 0, strong: false, signs: ['grocery'] };
  const signs: string[] = [];
  let score = 0;
  for (const sign of SIGNS) {
    if (sign.pattern.test(sign.headOnly ? head : fullText)) {
      signs.push(sign.name);
      score += sign.weight;
    }
  }
  const dishes = new Set((fullText.match(DISH_WORDS) ?? []).map((w) => w.toLowerCase()));
  if (dishes.size >= 2) {
    signs.push('dishes');
    score += dishes.size >= 4 ? 2 : 1;
  }
  return { score, strong: score >= MEAL_EVIDENCE_THRESHOLD, signs };
}
