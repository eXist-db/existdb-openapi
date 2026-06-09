const auth = { username: 'admin', password: '' };

// /api/search/fields lists the searchable fields/facets under a scope, filtered
// by the field-level-security policy. It is backed by ft:fields, so it requires
// an eXist with that function (eXist-db/exist#6459); on an eXist without it these
// tests fail at the route. The suite is self-contained: it seeds a fixture
// collection with a public site-content field + a non-public field, scopes
// discovery to that collection, and asserts the contract shape.
//
// FLS differentiation by caller identity (guest sees only public fields;
// authenticated callers also see non-public ones) is validated at the handler
// level (fields:discover with guest/auth/dba identities); an HTTP guest-vs-auth
// assertion here additionally depends on whether the route admits unauthenticated
// callers, which is a separate route-security decision.
const APP = 'cypress-fields-test';
const SCOPE = `/db/apps/${APP}`;
const DATA = `${SCOPE}/data`;
const CONF = `/db/system/config/db/apps/${APP}/data`;

const SETUP = `
let $xconf :=
  <collection xmlns="http://exist-db.org/collection-config/1.0">
    <index><lucene>
      <analyzer class="org.apache.lucene.analysis.standard.StandardAnalyzer"/>
      <text qname="rec">
        <field name="site-content" expression="string-join(.//text(), ' ')"/>
        <field name="site-title" expression="string(title)"/>
        <field name="secret-notes" expression="string(@secret)"/>
        <facet dimension="site-app" expression="'${APP}'"/>
      </text>
    </lucene></index>
  </collection>
return (
  xmldb:create-collection("/db/system/config/db/apps", "${APP}"),
  xmldb:create-collection("/db/system/config/db/apps/${APP}", "data"),
  xmldb:store("${CONF}", "collection.xconf", $xconf),
  xmldb:create-collection("/db/apps", "${APP}"),
  xmldb:create-collection("/db/apps/${APP}", "data"),
  xmldb:store("${DATA}", "r1.xml", <rec secret="classified"><title>One</title>array map serialize</rec>),
  xmldb:reindex("${DATA}"),
  "indexed=" || count(collection("${DATA}")/rec)
)[last()]
`;

const TEARDOWN = `
(if (xmldb:collection-available("${SCOPE}")) then xmldb:remove("${SCOPE}") else (),
 if (xmldb:collection-available("/db/system/config/db/apps/${APP}")) then xmldb:remove("/db/system/config/db/apps/${APP}") else (),
 "cleaned")[last()]
`;

function runAdmin(query) {
  return cy.request({ url: '/api/query', method: 'POST', auth, body: { query } }).then(r => {
    if (r.body && r.body.cursor) {
      cy.request({ url: `/api/query/${r.body.cursor}`, method: 'DELETE', auth, failOnStatusCode: false });
    }
  });
}

describe('/api/search/fields', () => {
  before(() => runAdmin(SETUP));
  after(() => runAdmin(TEARDOWN));

  describe('GET /api/search/fields', () => {
    it('returns the documented envelope: scope, user, total, fields', () => {
      cy.request({ url: `/api/search/fields?scope=${SCOPE}`, auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body.scope).to.be.an('array').and.to.include(SCOPE);
        expect(response.body).to.have.property('user');
        expect(response.body).to.have.property('total').that.is.a('number');
        expect(response.body.fields).to.be.an('array').and.to.have.length(response.body.total);
      });
    });

    it("reports each field's contract (kind, elements, analyzer, type, returnable)", () => {
      cy.request({ url: `/api/search/fields?scope=${SCOPE}`, auth }).then(response => {
        const sc = response.body.fields.find(f => f.field === 'site-content' && f.kind === 'field');
        expect(sc, 'site-content field record').to.exist;
        expect(sc.elements).to.be.an('array').and.to.include('rec');
        expect(sc.analyzer).to.exist; // string, or array when indexed with >1 analyzer
        expect(sc).to.have.property('type', 'xs:string');
        expect(sc).to.have.property('returnable', true);
        const facet = response.body.fields.find(f => f.field === 'site-app' && f.kind === 'facet');
        expect(facet, 'site-app facet record').to.exist;
      });
    });

    it('narrows to one field with the field parameter', () => {
      cy.request({ url: `/api/search/fields?scope=${SCOPE}&field=site-content`, auth }).then(response => {
        expect(response.body.fields).to.have.length.greaterThan(0);
        response.body.fields.forEach(f => expect(f.field).to.eq('site-content'));
      });
    });

    it('exposes non-public fields to an authenticated (dba) caller', () => {
      cy.request({ url: `/api/search/fields?scope=${SCOPE}`, auth }).then(response => {
        const names = response.body.fields.map(f => f.field);
        expect(names, 'public field').to.include('site-content');
        expect(names, 'non-public field, visible to this authenticated caller').to.include('secret-notes');
      });
    });
  });
});
