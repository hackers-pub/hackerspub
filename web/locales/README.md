Translation contribution guide
==============================

This document provides guidance for contributing translations to Hackers' Pub.

Getting started
----------------

### Add language to *i18n.ts*

 -  Import your JSON translation file in *i18n.ts*.
 -  Add the language to the `resources` object.
 -  Update type definitions if necessary.

### Add language code to `POSSIBLE_LOCALES`

 -  If your language code isn't already in the `POSSIBLE_LOCALES` array in
    *i18n.ts*, please add it first.

### Create code of conduct translation

 -  Add a translated version of the code of conduct as
    *CODE_OF_CONDUCT.`language-code`.md*.

### Create Markdown guide translation

 -  Add a translated version of the Markdown guide as
    *locales/markdown/`language-code`.md*.

### Create search guide translation

 -  Add a translated version of the search guide as
    *locales/search/`language-code`.md*.


Translation guidelines
----------------------

### Create a glossary first

 -  Before translating the entire file, establish translations for key terms
    in the `glossary` section.
 -  Reference the English glossary in *locales/en.json* to understand the terms.
 -  If you're unsure about any concept, ask the maintainers instead of guessing.

### Maintain consistency

 -  Use glossary terms consistently throughout the translation.
 -  Keep formatting and placeholders (`{{variable}}`) intact.
 -  Preserve translation keys (the parts before the colons).

### Respect context

 -  Some strings may need different translations depending on context.
 -  Pay attention to plural forms (e.g., `_one`, `_other` suffixes).

### Test your translation

 -  After completing the translation, please test it in the application to
    ensure proper rendering and functionality.


Submitting your translation
---------------------------

Submit your translation as a pull request and be available to respond to
feedback and questions during the review process.
