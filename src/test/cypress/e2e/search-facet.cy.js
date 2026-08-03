const auth = { username: 'admin', password: '' };

// Facet drill-down on /api/search (existdb-openapi#55 / oxygen (c)):
//   &facet=<dim>:<value>  (repeatable; same dim -> OR, different -> AND)
// ES post_filter semantics — selecting a value narrows the returned hits but the
// facet bucket COUNTS stay stable (computed on the base query). Uses standard
// Lucene facet drill-down (ft:query facets option), so it runs on any eXist.
// Self-contained: seeds a fixture with several site-app values.

const APP = 'cypress-facet';
const SCOPE = `/db/apps/${APP}`;
const CONF = `/db/system/config/db/apps/${APP}`;

const SETUP = `
let $xconf :=
  <collection xmlns="http://exist-db.org/collection-config/1.0">
    <index><lucene>
      <analyzer class="org.apache.lucene.analysis.standard.StandardAnalyzer"/>
      <text qname="rec">
        <field name="site-content" expression="string-join(.//text(), ' ')"/>
        <facet dimension="site-app" expression="string(@app)"/>
      </text>
    </lucene></index>
  </collection>
return (
  xmldb:create-collection("/db/system/config/db/apps", "${APP}"),
  xmldb:store("${CONF}", "collection.xconf", $xconf),
  xmldb:create-collection("/db/apps", "${APP}"),
  xmldb:store("${SCOPE}", "a.xml", <rec app="docs">tuning guide content</rec>),
  xmldb:store("${SCOPE}", "b.xml", <rec app="docs">more tuning content</rec>),
  xmldb:store("${SCOPE}", "c.xml", <rec app="blog">tuning blog content</rec>),
  xmldb:reindex("${SCOPE}"),
  "indexed=" || count(collection("${SCOPE}")/rec)
)[last()]
`;

const TEARDOWN = `
(if (xmldb:collection-available("${SCOPE}")) then xmldb:remove("${SCOPE}") else (),
 if (xmldb:collection-available("${CONF}")) then xmldb:remove("${CONF}") else (),
 "cleaned")[last()]
`;

function runAdmin(query) {
  return cy.request({ url: '/api/query', method: 'POST', auth, body: { query } }).then(r => {
    if (r.body && r.body.cursor) cy.request({ url: `/api/query/${r.body.cursor}`, method: 'DELETE', auth, failOnStatusCode: false });
  });
}

const enc = encodeURIComponent;

describe('GET /api/search — facet drill-down (#55 / oxygen c)', () => {
  before(() => runAdmin(SETUP));
  after(() => runAdmin(TEARDOWN));

  it('unfiltered search reports facet buckets with counts', () => {
    cy.request({ url: `/api/search?q=tuning&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.status).to.eq(200);
      expect(r.body.total).to.eq(3);
      expect(r.body.facets['site-app']).to.deep.include({ docs: 2, blog: 1 });
    });
  });

  it('facet=site-app:docs narrows the hits', () => {
    cy.request({ url: `/api/search?q=tuning&scope=${enc(SCOPE)}&facet=site-app:docs`, auth }).then(r => {
      expect(r.body.total).to.eq(2);
    });
  });

  it('post_filter: bucket counts stay stable when a facet is selected', () => {
    cy.request({ url: `/api/search?q=tuning&scope=${enc(SCOPE)}&facet=site-app:docs`, auth }).then(r => {
      // hits narrowed to 2, but the bucket counts still reflect the base query
      expect(r.body.total).to.eq(2);
      expect(r.body.facets['site-app']).to.deep.include({ docs: 2, blog: 1 });
    });
  });

  it('multiple values for one dimension combine with OR', () => {
    cy.request({ url: `/api/search?q=tuning&scope=${enc(SCOPE)}&facet=site-app:docs&facet=site-app:blog`, auth }).then(r => {
      expect(r.body.total).to.eq(3);
    });
  });

  it('the app shortcut is equivalent to facet=site-app:…', () => {
    cy.request({ url: `/api/search?q=tuning&scope=${enc(SCOPE)}&app=blog`, auth }).then(r => {
      expect(r.body.total).to.eq(1);
      expect(r.body.facets['site-app']).to.deep.include({ docs: 2, blog: 1 });
    });
  });
});
