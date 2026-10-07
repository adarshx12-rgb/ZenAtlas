// Operator-only: node --env-file-if-exists=.env --import tsx scripts/site-search-template.ts rbi.org.in 'https://rbi.org.in/<verified-path>?q={searchTerms}'
import {connect} from '../src/db.js';
import {readConfig} from '../src/config.js';
import {addSiteTemplate, MANUAL_DOMAINS} from '../src/site-search.js';
const [domain, template] = process.argv.slice(2);
if (!domain || !template) throw new Error(`Provide a domain (${MANUAL_DOMAINS.join(', ')}) and a verified GET template containing {searchTerms}.`);
const db = connect(readConfig().DATABASE_URL);
try { await addSiteTemplate(db, domain, template); console.log(`Saved manual search template for ${domain}.`); }
finally { await db.close(); }
