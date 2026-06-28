// Safe words that contain banned substrings but are not profanity.
// ru: checked via Cyrillic normalization path
// en: checked via Latin normalization path (add only entries that actually trigger a banned root)
module.exports = {
  ru: [
    'хулио', 'хурма', 'хутор', 'хусейн', 'художник', 'худой', 'худоба',
    'художество', 'хулиган', 'художница', 'ухо', 'ухват', 'ухажер',

    'лебедь', 'лебедев', 'лебединый', 'небо', 'хлеб', 'хлебец', 'хлебный',
    'требо', 'себастьян', 'ребёнок', 'ребята', 'учеба', 'учебник', 'учебный',

    'сукачев', 'сукно', 'суконный', 'сучок', 'сучья', 'барсук',

    'мудрость', 'мудрец', 'мудрый', 'премудрый', 'мудрёный',

    'бляха', 'бляшка',

    'пизанский', 'пизанская',

    'сухой', 'страх', 'страха', 'страхи',
  ],

  en: [
    // rape
    'scrape', 'grape',
    // cock
    'cocktail', 'peacock', 'cockburn', 'hancock',
    // cunt
    'scunthorpe',
    // dick
    'dickens',
    // cum
    'document', 'accumulate',
    // nig  (note: 'niger' omitted — 'nigger' collapses to the same form)
    'night', 'knight', 'snigger', 'nigel', 'nigeria',
  ],
};
