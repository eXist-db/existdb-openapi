const auth = { username: 'admin', password: '' };

// Vector-similarity search on /api/search (existdb-openapi#62 / oxygen (d)):
//   &vector=<field>&similar=<text>&k=<n>
// Discovery-driven: the client sends only the vector field + query text; the
// server resolves the field's embedding model from its ft:fields record
// (eXist-db/exist#6459) and embeds the text before the kNN. Requires a
// vector-capable eXist (the vector extension module + a local embedding model),
// so it runs on the trio/integration instance, not a stock eXist.
// Self-contained: seeds a small corpus with a text-embedding vector field.

const APP = 'cypress-vector';
const SCOPE = `/db/apps/${APP}`;
const CONF = `/db/system/config/db/apps/${APP}`;
const MODEL = 'all-MiniLM-L6-v2';

const SETUP = `
let $xconf :=
  <collection xmlns="http://exist-db.org/collection-config/1.0">
    <index><lucene>
      <analyzer class="org.apache.lucene.analysis.standard.StandardAnalyzer"/>
      <text qname="doc">
        <field name="site-content" expression="."/>
        <vector-field name="site-embedding" expression="." dimension="384" similarity="cosine" embedding="local" model="${MODEL}"/>
      </text>
    </lucene></index>
  </collection>
return (
  xmldb:create-collection("/db/system/config/db/apps", "${APP}"),
  xmldb:store("${CONF}", "collection.xconf", $xconf),
  xmldb:create-collection("/db/apps", "${APP}"),
  xmldb:store("${SCOPE}", "speed.xml", <doc><title>Query performance tuning</title>Make your database queries run much faster by optimizing indexes and caching.</doc>),
  xmldb:store("${SCOPE}", "cooking.xml", <doc><title>Pasta recipes</title>How to cook delicious Italian pasta with a fresh tomato and basil sauce.</doc>),
  xmldb:store("${SCOPE}", "weather.xml", <doc><title>Weather patterns</title>Understanding seasonal climate changes and rainfall in the tropics.</doc>),
  xmldb:reindex("${SCOPE}"),
  "indexed=" || count(collection("${SCOPE}")/doc)
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

describe('GET /api/search — vector similarity (#62 / oxygen d)', () => {
  before(() => runAdmin(SETUP));
  after(() => runAdmin(TEARDOWN));

  it('ranks by semantic similarity (client sends only field + text)', () => {
    cy.request({ url: `/api/search?vector=site-embedding&similar=${enc('how do I speed up my database queries')}&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.status).to.eq(200);
      // the performance doc is most similar to the query, despite no shared keywords with "speed up"
      expect(r.body.results[0].uri).to.eq(`${SCOPE}/speed.xml`);
      expect(r.body.results[0].score).to.be.greaterThan(0);
    });
  });

  it('resolves and echoes the field model server-side (no model sent by client)', () => {
    cy.request({ url: `/api/search?vector=site-embedding&similar=${enc('fast queries')}&scope=${enc(SCOPE)}`, auth }).then(r => {
      expect(r.body.field).to.eq('site-embedding');
      expect(r.body.model).to.eq(MODEL);
      expect(r.body['max-score']).to.eq(r.body.results[0].score);
    });
  });

  it('k limits the number of results', () => {
    cy.request({ url: `/api/search?vector=site-embedding&similar=${enc('fast queries')}&scope=${enc(SCOPE)}&k=2`, auth }).then(r => {
      expect(r.body.k).to.eq(2);
      expect(r.body.results).to.have.length(2);
    });
  });

  it('missing similar -> 400', () => {
    cy.request({ url: `/api/search?vector=site-embedding&scope=${enc(SCOPE)}`, auth, failOnStatusCode: false }).then(r => {
      expect(r.status).to.eq(400);
    });
  });

  it('unknown vector field -> 404', () => {
    cy.request({ url: `/api/search?vector=no-such-field&similar=${enc('anything')}&scope=${enc(SCOPE)}`, auth, failOnStatusCode: false }).then(r => {
      expect(r.status).to.eq(404);
    });
  });
});
