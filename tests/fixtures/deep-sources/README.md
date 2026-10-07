# Offline source fixtures

These are reduced, documentation-derived response contracts with normalized sample titles, identifiers and dates. They are not fresh live-search recordings. No searches were executed to obtain them. CourtListener's Foo v. Foo and Open Library's Fantastic Mr Fox follow the providers' published examples; other records exercise the documented response shapes. HTML/XML files are frozen protocol examples. Edge cases mutate copies of these fixtures in memory. All network dependencies in the new tests are replaced by fixture transports.

Reference contracts (consulted or linked for operator verification):

- Europe PMC: https://europepmc.org/RestfulWebService
- ClinicalTrials.gov v2: https://clinicaltrials.gov/data-api/api
- OpenAlex: https://help.openalex.org/api/ and https://help.openalex.org/access/pricing/
- DOAJ: https://doaj.org/api/docs
- CourtListener v4: https://www.courtlistener.com/help/api/rest/search/
- SEC: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data (EFTS search is a website endpoint, not a versioned public API)
- GovInfo: https://api.govinfo.gov/docs/
- Federal Register: https://www.federalregister.gov/developers/documentation/api/v1
- CKAN: https://docs.ckan.org/en/latest/api/index.html#ckan.logic.action.get.package_search
- EU catalogue: https://data.europa.eu/en/about/sparql (modern portal uses SPARQL, not CKAN)
- LOC: https://www.loc.gov/apis/json-and-yaml/ and https://www.loc.gov/apis/additional-apis/chronicling-america-api/ (legacy Chronicling America API retired)
- Europeana: https://api.europeana.eu/en
- Open Library: https://openlibrary.org/dev/docs/api/search
- Hugging Face: https://huggingface.co/docs/hub/api
- Stack Exchange: https://api.stackexchange.com/docs/advanced-search
- GDELT DOC: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
- Wayback: https://archive.org/help/wayback_api.php

Before enabling production traffic, replace or supplement these contract examples with operator-recorded responses from each configured endpoint. In particular, portal endpoints, SEC EFTS, GovInfo search and authenticated providers have not been live-verified.
