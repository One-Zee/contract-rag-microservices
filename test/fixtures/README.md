# Test fixtures

Sample documents for the ingestion tests (unit specs of the text extractor and
the documents e2e). All three are generated, so their content is known exactly:

| File                   | Content                                                                          | Purpose                                  |
| ---------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| `contract-sample.pdf`  | 3 pages, ~1 470 words: a fictional Master Services Agreement with `ARTICLE 1`–`8` headings and `Section X.Y` sub-headings | happy path, page numbers, section titles |
| `contract-sample.docx` | the same text as Word paragraphs (headings as Heading 1)                        | DOCX path, no page numbers               |
| `blank.pdf`            | one page without any text                                                        | "no extractable text" failure path       |

The text lives in `contract-text.mjs`; `generate.mjs` renders it with
[pdf-lib](https://pdf-lib.js.org/) and [docx](https://docx.js.org/). Neither is
a dependency of the project — regenerate with a one-off install:

```bash
cd test/fixtures
npx -y -p pdf-lib -p docx node generate.mjs .
```

Helvetica in pdf-lib covers WinAnsi only, which is why the sample is English
(the Bosnian heading forms — `Član 5`, `Članak 12.` — are covered by unit tests
on plain strings, not by a fixture).
