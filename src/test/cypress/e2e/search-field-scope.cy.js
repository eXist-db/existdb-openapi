const auth = { username: 'admin', password: '' };

// GET /api/search with the field-scoped query params (existdb-openapi#55):
//   field  — restrict the query to one named field (a /api/search/fields value)
//   scope  — collection path(s) to search under
// Field-scoped search uses standard ft:query (NOT ft:fields), so it works on a
// stock eXist — these tests run anywhere, no #6455/#6459 needed. The suite is
// self-contained: it indexes a fixture with a public (site-content) and a
// non-public (secret-notes) field and asserts field isolation + field-level
// security (a field the caller may not see returns 403).

const APP = 'cypress-fieldscope';
const SCOPE = `/db/apps/${APP}`;
const CONF = `/db/system/config/db/apps/${APP}`;

const SETUP = `
let $xconf :=
  <collection xmlns="http://exist-db.org/collection-config/1.0">
    <index><lucene>
      <analyzer class="org.apache.lucene.analysis.standard.StandardAnalyzer"/>
      <text qname="rec">
        <field name="site-content" expression="string-join(.//text(), ' ')"/>
        <field name="secret-notes" expression="string(@secret)"/>
        <facet dimension="site-app" expression="'${APP}'"/>
      </text>
    </lucene></index>
  </collection>
return (
  xmldb:create-collection("/db/system/config/db/apps", "${APP}"),
  xmldb:store("${CONF}", "collection.xconf", $xconf),
  xmldb:create-collection("/db/apps", "${APP}"),
  xmldb:store("${SCOPE}", "r1.xml", <rec secret="buried classified"><title>One</title>visible body text</rec>),
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
    if (r.body && r.body.cursor) {
      cy.request({ url: `/api/query/${r.body.cursor}`, method: 'DELETE', auth, failOnStatusCode: false });
    }
  });
}

const enc = encodeURIComponent;

describe('GET /api/search — field-scoped query (#55)', () => {
  before(() => runAdmin(SETUP));
  after(() => runAdmin(TEARDOWN));

  it('field=site-content matches body text', () => {
    cy.request({ url: `/api/search?q=visible&field=site-content&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.status).to.eq(200);
      expect(r.body.total).to.be.greaterThan(0);
    });
  });

  it('field isolation: a term only in secret-notes does not match site-content', () => {
    cy.request({ url: `/api/search?q=buried&field=site-content&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.body.total).to.eq(0);
    });
    cy.request({ url: `/api/search?q=buried&field=secret-notes&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.body.total).to.be.greaterThan(0);
    });
  });

  it('scope restricts the search to the given collection', () => {
    cy.request({ url: `/api/search?q=visible&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.status).to.eq(200);
      r.body.results.forEach(hit => expect(hit.path).to.contain(SCOPE));
    });
  });

  it('FLS: a non-public field is not queryable by guest (403)', () => {
    cy.request({ url: `/api/search?q=buried&field=secret-notes&scope=${enc(SCOPE)}`, failOnStatusCode: false }).then(r => {
      expect(r.status).to.eq(403);
      expect(r.body).to.have.property('error');
    });
  });

  it('FLS: a public field IS queryable by guest (200)', () => {
    cy.request({ url: `/api/search?q=visible&field=site-content&scope=${enc(SCOPE)}`, failOnStatusCode: false }).then(r => {
      expect(r.status).to.eq(200);
    });
  });

  it('FLS: a dba may query the non-public field', () => {
    cy.request({ url: `/api/search?q=buried&field=secret-notes&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.status).to.eq(200);
      expect(r.body.total).to.be.greaterThan(0);
    });
  });

  it('default (no field) is unchanged: stable envelope shape', () => {
    cy.request({ url: `/api/search?q=visible&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.body).to.include.all.keys('query', 'total', 'offset', 'limit', 'facets', 'results');
    });
  });
});
